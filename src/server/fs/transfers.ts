// Clipboard do daemon e cópias em fluxo: independente de conversas, browser e clipboard do Windows.
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileClipboard, FileCopyJob, FileCopyIssue, FileCopyState } from '../../shared/types';
import { DeckError } from '../../shared/protocol';
import { join, relativeTo } from '../../shared/paths';
import { checkParents, copyName, copyPath, maybeStat, sameCopyStat, type CopyFs, type CopyStat } from './copyfs';

export const COPY_TERMINAL = new Set<FileCopyState>(['completed', 'partial', 'failed', 'cancelled', 'uncertain']);
export interface CopyEndpoint { fs: CopyFs; identity: string }
interface Entry { from: string; to: string; stat: CopyStat; existing: CopyStat | null; blocked?: string }
interface Run {
  job: FileCopyJob; sourceWid: string; wid: string; controller: AbortController;
  entries: Entry[]; source?: CopyEndpoint; dest?: CopyEndpoint; policy: 'skip' | 'replace';
  signature: string; timer?: NodeJS.Timeout; lastEmit: number; issues: FileCopyIssue[];
}
export interface TransferOptions {
  resolve(hostId: string): Promise<CopyEndpoint>;
  platform(hostId: string): CopyFs['platform'];
  update(job: FileCopyJob, wids: string[]): void;
  clipboard(value: FileClipboard | null): void;
  changed(hostId: string, path: string): void;
  reserve(identity: string, fs: CopyFs, path: string): Promise<() => void>;
  limit?: number;
  confirmAbove?: number;
}

export class FileTransfers {
  clipboard: FileClipboard | null = null;
  private sourceWid = '';
  private clipboardRevision = 0;
  private runs = new Map<string, Run>();
  private requests = new Map<string, string>();
  private tasks = new Set<Promise<void>>();
  private queue: Run[] = [];
  private executing = false;
  private stopped = false;
  constructor(private opts: TransferOptions) {}

  get busy() { return [...this.runs.values()].filter((r) => !COPY_TERMINAL.has(r.job.state)).length; }
  setClipboard(wid: string, hostId: string, p: unknown) {
    if (this.stopped) throw new DeckError('busy', 'Servidor encerrando.');
    const platform = this.opts.platform(hostId);
    const path = copyPath(platform, p);
    const name = path.split(platform === 'win32' ? /[\\/]/ : /\//).pop() || '';
    copyName(platform, name);
    this.sourceWid = wid;
    this.clipboard = { id: crypto.randomUUID(), revision: ++this.clipboardRevision, hostId, path, name };
    this.opts.clipboard(this.clipboard);
    return this.clipboard;
  }
  clearClipboard() { this.clipboard = null; this.opts.clipboard(null); }
  list(wid: string) { return [...this.runs.values()].filter((r) => r.wid === wid || r.sourceWid === wid).map((r) => this.snapshot(r)); }
  get(wid: string, id?: string, requestId?: string) {
    const r = this.owned(wid, id ?? this.requests.get(`${wid}:${requestId}`) ?? '');
    return this.snapshot(r);
  }
  issues(wid: string, id: string, offset = 0) { return this.owned(wid, id).issues.slice(offset, offset + 100); }
  private owned(wid: string, id: string) {
    const r = this.runs.get(id);
    if (!r || (r.wid !== wid && r.sourceWid !== wid)) throw new DeckError('notfound', 'Cópia não encontrada nesta janela.');
    return r;
  }
  start(wid: string, p: { requestId: string; clipboardId: string; revision: number; hostId: string; dir: string }) {
    if (this.stopped) throw new DeckError('busy', 'Servidor encerrando.');
    if (typeof p.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(p.requestId)) throw new DeckError('bad', 'Identificador de colagem inválido.');
    const signature = JSON.stringify([p.clipboardId, p.revision, p.hostId, p.dir]);
    const prev = this.requests.get(`${wid}:${p.requestId}`);
    if (prev) {
      const r = this.owned(wid, prev);
      if (r.signature !== signature) throw new DeckError('bad', 'Este pedido de colagem já foi usado para outro destino.');
      return this.snapshot(r);
    }
    if (this.requests.size >= 10_000) throw new DeckError('busy', 'Limite de pedidos de cópia nesta execução. Atualize/reinicie o Deck quando estiver ocioso.');
    if (this.busy >= 10) throw new DeckError('busy', 'Há muitas cópias pendentes; termine ou cancele as anteriores.');
    const c = this.clipboard;
    if (!c || c.id !== p.clipboardId || c.revision !== p.revision) throw new DeckError('conflict', 'O item copiado mudou. Copie novamente antes de colar.');
    const path = copyPath(this.opts.platform(p.hostId), p.dir);
    const job: FileCopyJob = {
      id: crypto.randomUUID(), requestId: p.requestId, destinationWid: wid, revision: 0,
      source: { hostId: c.hostId, path: c.path }, destination: { hostId: p.hostId, path },
      state: 'scanning', createdAt: Date.now(), files: 0, directories: 0, bytes: 0, transferred: 0,
      copied: 0, skipped: 0, omitted: 0, conflicts: 0, issueCount: 0, issues: [],
    };
    const r: Run = { job, wid, sourceWid: this.sourceWid, entries: [], controller: new AbortController(), policy: 'skip', signature, lastEmit: 0, issues: [] };
    this.runs.set(job.id, r);
    this.requests.set(`${wid}:${p.requestId}`, job.id);
    this.emit(r);
    this.track(this.prepare(r));
    return this.snapshot(r);
  }
  decide(wid: string, id: string, revision: number, decision: string) {
    const r = this.owned(wid, id);
    if (r.wid !== wid) throw new DeckError('otherwindow', 'Só a janela de destino decide conflitos da cópia.');
    if (r.job.state !== 'awaitingDecision' || r.job.revision !== revision) throw new DeckError('conflict', 'A decisão de cópia expirou ou já foi respondida.');
    if (!['skip', 'replace', 'cancel'].includes(decision)) throw new DeckError('bad', 'Decisão inválida.');
    if (decision === 'cancel') return this.cancel(wid, id);
    clearTimeout(r.timer);
    r.policy = decision as 'skip' | 'replace';
    this.enqueue(r);
    return this.snapshot(r);
  }
  cancel(wid: string, id: string) {
    const r = this.owned(wid, id);
    if (!COPY_TERMINAL.has(r.job.state)) {
      r.controller.abort();
      if (r.job.state === 'awaitingDecision' || r.job.state === 'queued') this.end(r, 'cancelled');
    }
    return this.snapshot(r);
  }
  async shutdown() {
    this.stopped = true;
    for (const r of this.runs.values()) if (!COPY_TERMINAL.has(r.job.state)) this.cancel(r.wid, r.job.id);
    await Promise.race([Promise.allSettled([...this.tasks]), new Promise((r) => setTimeout(r, 35_000).unref())]);
  }
  private track(task: Promise<void>) { this.tasks.add(task); void task.finally(() => this.tasks.delete(task)); }
  private snapshot(r: Run): FileCopyJob { return { ...r.job, source: { ...r.job.source }, destination: { ...r.job.destination }, issues: r.issues.slice(0, 10) }; }
  private emit(r: Run, force = true) {
    if (!force && Date.now() - r.lastEmit < 250) return;
    r.lastEmit = Date.now(); r.job.revision++;
    this.opts.update(this.snapshot(r), [...new Set([r.wid, r.sourceWid])]);
  }
  private issue(r: Run, path: string, message: string) {
    r.issues.push({ path, message }); r.job.issueCount = r.issues.length;
  }
  private end(r: Run, state: FileCopyState, error?: string) {
    clearTimeout(r.timer);
    r.job.state = state; r.job.error = error; r.job.finishedAt = Date.now(); r.job.current = undefined;
    this.emit(r);
    const finals = [...this.runs.values()].filter((x) => COPY_TERMINAL.has(x.job.state));
    for (const old of finals.slice(0, Math.max(0, finals.length - 30))) {
      this.runs.delete(old.job.id); // Manter o requestId usado: retry atrasado nunca vira outra cópia.
    }
  }
  private check(r: Run) { r.controller.signal.throwIfAborted(); }
  private async prepare(r: Run) {
    try {
      const { job } = r;
      r.source = await this.opts.resolve(job.source.hostId); this.check(r);
      r.dest = await this.opts.resolve(job.destination.hostId); this.check(r);
      const a = r.source.fs, b = r.dest.fs;
      await checkParents(a, job.source.path);
      await checkParents(b, job.destination.path);
      if ((await b.lstat(job.destination.path)).type !== 'dir') throw new DeckError('bad', 'O destino precisa ser uma pasta real.');
      const root = await a.lstat(job.source.path);
      if (root.type !== 'file' && root.type !== 'dir') throw new DeckError('bad', 'Não copio links ou arquivos especiais como origem.');
      const name = copyName(b.platform, job.source.path.split(a.platform === 'win32' ? /[\\/]/ : /\//).pop()!);
      const target = join(b.platform, job.destination.path, name);
      if (r.source.identity === r.dest.identity) {
        const src = await a.realpath(job.source.path);
        const dst = join(b.platform, await b.realpath(job.destination.path), name);
        if (relativeTo(b.platform, src, dst) !== null || (root.type === 'dir' && relativeTo(b.platform, src, job.destination.path) !== null))
          throw new DeckError('bad', 'Não dá para copiar um item sobre ele mesmo ou para dentro da própria pasta.');
        const st = await maybeStat(b, target);
        if (root.identity && st?.identity === root.identity) throw new DeckError('bad', 'Origem e destino são o mesmo arquivo.');
      }
      const walk = async (from: string, to: string, depth: number, parentBlocked = false) => {
        this.check(r);
        if (depth > 200 || r.entries.length + job.omitted >= (this.opts.limit ?? 50_000)) throw new DeckError('bad', 'Cópia acima do limite de 50 mil itens ou 200 níveis. Nenhum arquivo foi transferido.');
        const st = await a.lstat(from);
        if (st.type !== 'file' && st.type !== 'dir') { job.omitted++; this.issue(r, from, 'Link ou arquivo especial: não foi seguido.'); return; }
        const existing = parentBlocked ? null : await maybeStat(b, to);
        const blocked = parentBlocked || (existing && existing.type !== st.type) ? 'Conflito de tipo ou ancestral bloqueado: não será apagado.' : undefined;
        if (existing?.type === 'symlink') throw new DeckError('bad', `Destino é um link: ${to}`);
        const entry: Entry = { from, to, stat: st, existing, blocked };
        r.entries.push(entry);
        if (st.type === 'file') { job.files++; job.bytes += st.size; if (existing || blocked) job.conflicts++; }
        else { job.directories++; if (blocked) job.conflicts++; }
        if (!Number.isSafeInteger(st.size) || st.size < 0 || !Number.isSafeInteger(job.bytes)) throw new DeckError('bad', 'Tamanho de arquivo fora do limite suportado.');
        this.emit(r, false);
        if (st.type === 'dir') {
          const names = new Set<string>();
          for await (const raw of a.entries(from)) {
            const child = copyName(b.platform, raw);
            const key = b.platform === 'win32' ? child.toLowerCase() : child;
            if (names.has(key)) throw new DeckError('bad', `Nomes colidem no destino: ${child}`);
            names.add(key);
            await walk(join(a.platform, from, raw), join(b.platform, to, child), depth + 1, !!blocked);
          }
        }
      };
      await walk(job.source.path, target, 0);
      this.check(r);
      if (job.conflicts || job.files > (this.opts.confirmAbove ?? 2000)) {
        job.state = 'awaitingDecision'; this.emit(r);
        r.timer = setTimeout(() => { if (job.state === 'awaitingDecision') this.cancel(r.wid, job.id); }, 10 * 60_000).unref();
      } else this.enqueue(r);
    } catch (e: any) { this.end(r, r.controller.signal.aborted ? 'cancelled' : 'failed', e.message); }
  }
  private enqueue(r: Run) { r.job.state = 'queued'; this.emit(r); this.queue.push(r); this.pump(); }
  private pump() {
    if (this.executing) return;
    const r = this.queue.shift();
    if (!r) return;
    if (COPY_TERMINAL.has(r.job.state)) { this.pump(); return; }
    this.executing = true;
    const task = this.execute(r).finally(() => { this.executing = false; this.pump(); });
    this.track(task);
  }
  private async execute(r: Run) {
    r.job.state = 'copying'; this.emit(r);
    const { job } = r; const b = r.dest!.fs;
    try {
      for (const e of r.entries.filter((e) => e.stat.type === 'dir')) {
        this.check(r);
        if (e.blocked) { this.issue(r, e.to, e.blocked); continue; }
        await checkParents(b, e.to);
        const current = await maybeStat(b, e.to);
        if (current && current.type !== 'dir') throw new DeckError('conflict', `O destino mudou: ${e.to}`);
        if (!current) { await b.mkdir(e.to); this.opts.changed(job.destination.hostId, e.to); }
      }
      let index = 0;
      const files = r.entries.filter((e) => e.stat.type === 'file');
      const worker = async () => {
        while (index < files.length) {
          this.check(r);
          const e = files[index++];
          if (e.blocked || (e.existing && r.policy === 'skip')) { job.skipped++; if (e.blocked) this.issue(r, e.to, e.blocked); continue; }
          await this.copyFile(r, e);
        }
      };
      const settled = await Promise.allSettled([worker(), worker()]);
      const failure = settled.find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
      if (failure) throw failure.reason;
      this.check(r);
      this.end(r, r.issues.length || job.skipped ? 'partial' : 'completed');
    } catch (e: any) {
      this.end(r, job.state === 'uncertain' ? 'uncertain' : r.controller.signal.aborted ? 'cancelled' : 'failed', e.message);
    }
  }
  private async copyFile(r: Run, e: Entry) {
    const a = r.source!.fs, b = r.dest!.fs, job = r.job;
    let source: Awaited<ReturnType<CopyFs['source']>> | undefined;
    let stage: Awaited<ReturnType<CopyFs['stage']>> | undefined;
    let publishing = false, committed = false, release: (() => void) | undefined;
    try {
      this.check(r); await checkParents(a, e.from); await checkParents(b, e.to);
      if (!sameCopyStat(e.stat, await a.lstat(e.from))) throw new DeckError('conflict', 'A origem mudou depois da análise.');
      if (!sameCopyStat(e.existing, await maybeStat(b, e.to))) throw new DeckError('conflict', 'O destino mudou depois da confirmação.');
      source = await a.source(e.from);
      source.stream.on('error', () => {}); // Aquisição do destino ainda pode demorar; pipeline observa o erro depois.
      if (!sameCopyStat(e.stat, await source.stat())) throw new DeckError('conflict', 'A origem mudou durante a abertura.');
      this.check(r); stage = await b.stage(e.to); stage.stream.on('error', () => {}); this.check(r);
      let bytes = 0;
      job.current = e.to; this.emit(r, false);
      const counter = new Transform({ transform: (chunk: Buffer, _enc, cb) => {
        bytes += chunk.length; job.transferred += chunk.length; this.emit(r, false); cb(null, chunk);
      } });
      await pipeline(source.stream, counter, stage.stream, { signal: r.controller.signal });
      if (bytes !== e.stat.size || !sameCopyStat(e.stat, await source.stat()) || !sameCopyStat(e.stat, await a.lstat(e.from))) throw new DeckError('conflict', 'A origem mudou durante a cópia; o temporário não será publicado.');
      await source.close(); source = undefined;
      await stage.finish(a.platform === 'posix' && b.platform === 'posix' ? e.stat.mode : undefined);
      release = await this.opts.reserve(r.dest!.identity, b, e.to);
      this.check(r); await checkParents(b, e.to);
      if (!sameCopyStat(e.existing, await maybeStat(b, e.to))) throw new DeckError('conflict', 'O destino mudou antes de publicar.');
      publishing = true;
      await stage.publish(!!e.existing && r.policy === 'replace');
      committed = true; job.copied++; this.opts.changed(job.destination.hostId, e.to);
    } catch (error: any) {
      const unknown = publishing && !['exists', 'EEXIST', 'denied', 'EACCES', 'EPERM', 'unsupported', 'conflict'].includes(error.code) && (error.code === 'timeout' || /connection|socket|closed|disconnect/i.test(error.message));
      if (unknown) { job.state = 'uncertain'; this.issue(r, e.to, 'Publicação não confirmada. Inspecione o destino antes de repetir.'); r.controller.abort(); }
      else if (!r.controller.signal.aborted) this.issue(r, e.to, error.message);
      if (unknown || r.controller.signal.aborted) throw error;
    } finally {
      release?.();
      if (source) { source.stream.destroy(); await source.close().catch((e) => this.issue(r, e.from, `Fechamento: ${e.message}`)); }
      if (stage && (committed || !publishing || job.state !== 'uncertain')) await stage.discard().catch((e) => this.issue(r, stage!.path, `Temporário não removido: ${e.message}`));
      this.emit(r, false);
    }
  }
}
