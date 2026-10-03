// Histórico de conversas do Claude Code: lê os transcripts (~/.claude/projects/<pasta>/<id>.jsonl)
// do próprio computador ou do servidor (via SFTP). É o mesmo histórico da extensão do VS Code.
import fs from 'node:fs';
import type { HostHandle } from '../hosts/registry';
import type { ManualPendingConversation, SessionSummary } from '../../shared/types';
import { encodeProjectDir } from '../../shared/paths';
import { readJson, writeJsonAtomic } from '../config';

const HEAD_BYTES = 24 * 1024;
const TAIL_BYTES = 96 * 1024;
const MAX_TEXT = 60 * 1024;
const MAX_IMAGE_B64 = 3 * 1024 * 1024;

interface CacheEntry {
  size: number;
  mtime: number;
  /** Versão da extração de títulos: mudou a regra, o resumo é refeito. */
  v?: number;
  summary: Omit<SessionSummary, 'file' | 'size' | 'mtime' | 'archived'>;
}

const SUMMARY_VERSION = 2;

/** Título do histórico quando o transcript não tem nome nem pedido do usuário para usar. */
export const UNTITLED = 'Conversa sem título';

export class HistoryCache {
  private data: Record<string, CacheEntry>;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string) {
    this.data = readJson<Record<string, CacheEntry>>(file, {});
  }
  get(key: string, size: number, mtime: number) {
    const e = this.data[key];
    return e && e.size === size && e.mtime === mtime && e.v === SUMMARY_VERSION ? e.summary : undefined;
  }
  set(key: string, size: number, mtime: number, summary: CacheEntry['summary']) {
    this.data[key] = { size, mtime, v: SUMMARY_VERSION, summary };
    this.dirty = true;
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, 2000);
  }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeJsonAtomic(this.file, this.data);
    } catch {
      /* cache é opcional */
    }
  }
}

/** Texto limpo de uma mensagem do usuário (sem tags de contexto da IDE/sistema). */
export function cleanUserText(content: any): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  text = text
    .replace(/<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|local-command-stdout|local-command-stderr|command-message|command-args|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    // Texto colado no terminal do Claude Code: some a marcação, fica o conteúdo.
    .replace(/<\/?pasted_content(?:\s+id="[^"]*")?\s*>/g, ' ')
    .trim();
  return text;
}

function isNoise(text: string) {
  return !text || /^Caveat:|^\[Request interrupted/i.test(text);
}

/** Extrai título, primeiro pedido e pasta de linhas do começo/fim do transcript. */
export function summarizeLines(
  headLines: string[],
  tailLines: string[],
): { sessionId?: string; title: string; firstPrompt?: string; cwd?: string } {
  let title: string | undefined;
  let custom: string | undefined;
  let summaryText: string | undefined;
  let firstPrompt: string | undefined;
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let lastPrompt: string | undefined;
  const scan = (lines: string[], fromTail: boolean) => {
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!sessionId && o.sessionId) sessionId = o.sessionId;
      if (!cwd && o.cwd) cwd = o.cwd;
      if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
      else if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
      else if (o.type === 'summary' && o.summary) summaryText = o.summary;
      else if (o.type === 'last-prompt' && o.lastPrompt) lastPrompt = o.lastPrompt;
      else if (!fromTail && !firstPrompt && o.type === 'user' && !o.isMeta && !o.isSidechain && !o.toolUseResult) {
        const t = cleanUserText(o.message?.content);
        if (!isNoise(t) && !(Array.isArray(o.message?.content) && o.message.content[0]?.type === 'tool_result')) firstPrompt = t.slice(0, 300);
      }
    }
  };
  scan(headLines, false);
  scan(tailLines, true);
  const best: string = custom || title || summaryText || firstPrompt || (lastPrompt && cleanUserText(lastPrompt)) || UNTITLED;
  return { sessionId, title: best.replace(/\s+/g, ' ').trim().slice(0, 160), firstPrompt, cwd };
}

function splitLines(buf: Buffer, dropFirstPartial: boolean, dropLastPartial: boolean): string[] {
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (dropFirstPartial) lines.shift();
  if (dropLastPartial && !text.endsWith('\n')) lines.pop();
  return lines.filter(Boolean);
}

export class HistoryService {
  constructor(
    private cache: HistoryCache,
    private archived: () => Set<string>,
    /** Pasta de configuração local do Claude (CLAUDE_CONFIG_DIR, se definida). */
    private localClaudeDir?: string,
    /** Estado manual fica fora do cache de transcript e é aplicado ao resumir a lista. */
    private isManualPending: (hostId: string, sessionId: string, cwd?: string) => boolean = () => false,
  ) {}

  projectsDir(host: HostHandle, home: string) {
    if (host.kind === 'local' && this.localClaudeDir) return `${this.localClaudeDir.replace(/[\\/]+$/, '')}${host.platform === 'win32' ? '\\' : '/'}projects`;
    return host.platform === 'win32' ? `${home}\\.claude\\projects` : `${home}/.claude/projects`;
  }

  private join(host: HostHandle, a: string, b: string) {
    return host.platform === 'win32' ? `${a}\\${b}` : `${a}/${b}`;
  }

  async summarizeFile(host: HostHandle, file: string, size: number, mtime: number): Promise<SessionSummary> {
    const key = `${host.id}|${file}`;
    const id = file.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '');
    let s = this.cache.get(key, size, mtime);
    if (!s) {
      const head = await host.fs.readBytes(file, 0, Math.min(size, HEAD_BYTES));
      const tailStart = Math.max(0, size - TAIL_BYTES);
      const tail = tailStart > HEAD_BYTES ? await host.fs.readBytes(file, tailStart, size - tailStart) : Buffer.alloc(0);
      const headLines = splitLines(head, false, size > HEAD_BYTES);
      const tailLines = tail.length ? splitLines(tail, true, false) : headLines;
      const sum = summarizeLines(headLines, tailLines);
      s = { title: sum.title, firstPrompt: sum.firstPrompt, cwd: sum.cwd, sessionId: id };
      this.cache.set(key, size, mtime, s);
    }
    return { ...s, sessionId: id, file, size, mtime, archived: this.archived().has(id) };
  }

  /** Acrescenta o estado de UI depois do cache, que só guarda dados do transcript. */
  private withManualPending(hostId: string, summary: SessionSummary, listCwd?: string): SessionSummary {
    const markedInListedFolder = !!listCwd && this.isManualPending(hostId, summary.sessionId, listCwd);
    const markedInTranscriptFolder = !!summary.cwd && this.isManualPending(hostId, summary.sessionId, summary.cwd);
    return markedInListedFolder || markedInTranscriptFolder ? { ...summary, manualPending: true } : summary;
  }

  /** Conversas de uma pasta de projeto (mais recentes primeiro). */
  async listForCwd(host: HostHandle, home: string, cwd: string, limit = 200): Promise<SessionSummary[]> {
    const dir = this.join(host, this.projectsDir(host, home), encodeProjectDir(cwd));
    return this.listDir(host, dir, limit, cwd);
  }

  async listDir(host: HostHandle, dir: string, limit = 200, listCwd?: string): Promise<SessionSummary[]> {
    let entries;
    try {
      entries = await host.fs.list(dir);
    } catch {
      return [];
    }
    const files = entries
      .filter((e) => e.type === 'file' && e.name.endsWith('.jsonl') && /^[0-9a-f-]{36}\.jsonl$/i.test(e.name) && e.size > 0)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
    const out: SessionSummary[] = [];
    // Lotes de 6 para não afogar o SFTP.
    for (let i = 0; i < files.length; i += 6) {
      const batch = await Promise.all(
        files.slice(i, i + 6).map((f) => this.summarizeFile(host, this.join(host, dir, f.name), f.size, f.mtime).catch(() => null)),
      );
      for (const b of batch) if (b) out.push(this.withManualPending(host.id, b, listCwd));
    }
    return out.filter((s) => !!s.title);
  }

  /** Pendências marcadas pelo usuário, sem o corte normal de 200 conversas por pasta. */
  async listManualPending(host: HostHandle, home: string, records: readonly ManualPendingConversation[]): Promise<SessionSummary[]> {
    const own = records.filter((record) => record.hostId === host.id);
    const out: SessionSummary[] = [];
    // O mesmo limite de concorrência do histórico normal evita uma rajada de leituras SFTP.
    for (let i = 0; i < own.length; i += 6) {
      const batch = await Promise.all(
        own.slice(i, i + 6).map(async (record) => {
          const file = await this.findFile(host, home, record.sessionId, record.cwd);
          if (!file) return null;
          const stat = await host.fs.stat(file);
          const summary = await this.summarizeFile(host, file, stat.size, stat.mtime);
          // A chave de persistência usa o cwd que marcou a conversa, mesmo se o transcript antigo não o trouxer.
          return { ...summary, cwd: record.cwd, manualPending: true };
        }),
      );
      for (const summary of batch) if (summary?.title) out.push(summary);
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** Todas as pastas de projeto do servidor, com a conversa mais recente de cada. */
  async listProjects(host: HostHandle, home: string): Promise<{ dir: string; name: string; cwd?: string; mtime: number; count: number }[]> {
    const root = this.projectsDir(host, home);
    let dirs;
    try {
      dirs = (await host.fs.list(root)).filter((e) => e.type === 'dir');
    } catch {
      return [];
    }
    const out: { dir: string; name: string; cwd?: string; mtime: number; count: number }[] = [];
    for (let i = 0; i < dirs.length; i += 6) {
      const batch = await Promise.all(
        dirs.slice(i, i + 6).map(async (d) => {
          const dir = this.join(host, root, d.name);
          try {
            const files = (await host.fs.list(dir)).filter((e) => e.type === 'file' && /^[0-9a-f-]{36}\.jsonl$/i.test(e.name) && e.size > 0);
            if (!files.length) return null;
            files.sort((a, b) => b.mtime - a.mtime);
            const newest = await this.summarizeFile(host, this.join(host, dir, files[0].name), files[0].size, files[0].mtime);
            return { dir, name: d.name, cwd: newest.cwd, mtime: files[0].mtime, count: files.length };
          } catch {
            return null;
          }
        }),
      );
      for (const b of batch) if (b) out.push(b);
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** Acha o arquivo de uma sessão (pela pasta do cwd ou procurando em todas). */
  async findFile(host: HostHandle, home: string, sessionId: string, cwd?: string): Promise<string | null> {
    const root = this.projectsDir(host, home);
    if (cwd) {
      const f = this.join(host, this.join(host, root, encodeProjectDir(cwd)), `${sessionId}.jsonl`);
      if (await host.fs.exists(f)) return f;
    }
    try {
      for (const d of await host.fs.list(root)) {
        if (d.type !== 'dir') continue;
        const f = this.join(host, this.join(host, root, d.name), `${sessionId}.jsonl`);
        if (await host.fs.exists(f)) return f;
      }
    } catch {
      /* sem pasta de projetos */
    }
    return null;
  }

  /**
   * Página do transcript terminando em `before` (ou no fim do arquivo).
   * Devolve linhas já filtradas e com conteúdos gigantes cortados.
   */
  async loadPage(host: HostHandle, file: string, before?: number, maxBytes = 1_500_000, sidechain = false): Promise<{ lines: any[]; start: number; end: number; size: number }> {
    const st = await host.fs.stat(file);
    const end = Math.min(before ?? st.size, st.size);
    let want = maxBytes;
    let start = Math.max(0, end - want);
    let buf = await host.fs.readBytes(file, start, end - start);
    // Garante ao menos uma linha completa (linhas enormes: amplia a janela até 32 MB).
    while (start > 0 && buf.indexOf(10) === buf.lastIndexOf(10) && want < 32 * 1024 * 1024) {
      want *= 2;
      start = Math.max(0, end - want);
      buf = await host.fs.readBytes(file, start, end - start);
    }
    let cut = 0;
    if (start > 0) {
      const nl = buf.indexOf(10);
      cut = nl >= 0 ? nl + 1 : buf.length;
    }
    const body = buf.subarray(cut);
    const lines: any[] = [];
    for (const raw of body.toString('utf8').split('\n')) {
      if (!raw.startsWith('{')) continue;
      let o: any;
      try {
        o = JSON.parse(raw);
      } catch {
        continue;
      }
      const t = o.type;
      if (t !== 'user' && t !== 'assistant' && t !== 'system' && t !== 'summary' && t !== 'ai-title' && t !== 'custom-title') continue;
      if (o.isSidechain && !sidechain) continue;
      lines.push(trimLine(o));
    }
    return { lines, start: start + cut, end, size: st.size };
  }

  /** Título da conversa no fim do transcript: o nome dado pelo usuário vence o gerado pelo Claude. */
  async readTitle(host: HostHandle, file: string): Promise<string | undefined> {
    const st = await host.fs.stat(file);
    const start = Math.max(0, st.size - TAIL_BYTES);
    const buf = await host.fs.readBytes(file, start, st.size - start);
    const lines = splitLines(buf, start > 0, false);
    let ai: string | undefined;
    let custom: string | undefined;
    for (const l of lines) {
      if (!l.includes('"ai-title"') && !l.includes('"custom-title"')) continue;
      try {
        const o = JSON.parse(l);
        if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
        else if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle;
      } catch {
        /* ignora */
      }
    }
    return custom || ai;
  }

  /** Grava um nome dado pelo usuário no transcript (como o /rename do CLI faz). */
  async writeCustomTitle(host: HostHandle, file: string, sessionId: string, title: string) {
    await host.fs.append(file, Buffer.from(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId }) + '\n', 'utf8'));
  }
}

function trimText(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `\n… [cortado: ${Math.round(s.length / 1024)} KB no total]` : s;
}

function trimBlock(b: any): any {
  if (!b || typeof b !== 'object') return b;
  if (b.type === 'text' && typeof b.text === 'string') return { ...b, text: trimText(b.text) };
  if (b.type === 'thinking' && typeof b.thinking === 'string') return { ...b, thinking: trimText(b.thinking), signature: undefined };
  if (b.type === 'redacted_thinking') return { type: 'redacted_thinking' };
  if (b.type === 'image' && b.source?.type === 'base64' && (b.source.data?.length ?? 0) > MAX_IMAGE_B64) {
    return { type: 'text', text: '[imagem grande omitida]' };
  }
  if (b.type === 'tool_result') {
    const c = b.content;
    if (typeof c === 'string') return { ...b, content: trimText(c) };
    if (Array.isArray(c)) return { ...b, content: c.map(trimBlock) };
  }
  if (b.type === 'tool_use' && b.input && JSON.stringify(b.input).length > MAX_TEXT * 2) {
    const input: any = {};
    for (const [k, v] of Object.entries(b.input)) input[k] = typeof v === 'string' ? trimText(v) : v;
    return { ...b, input };
  }
  return b;
}

/** Corta conteúdos enormes (arquivos lidos, saídas longas) para não pesar na interface. */
export function trimLine(o: any): any {
  const out: any = { ...o };
  if (out.message && Array.isArray(out.message.content)) out.message = { ...out.message, content: out.message.content.map(trimBlock) };
  else if (out.message && typeof out.message.content === 'string') out.message = { ...out.message, content: trimText(out.message.content) };
  if (out.toolUseResult) {
    const r = out.toolUseResult;
    // Guarda só dados que a interface realmente mostra: diff de edições ou metadados do subagente ativo.
    if (r && typeof r === 'object' && (r.structuredPatch || r.filePath)) {
      const keep: any = { filePath: r.filePath, structuredPatch: r.structuredPatch, type: r.type };
      if (JSON.stringify(keep).length < 400_000) out.toolUseResult = keep;
      else delete out.toolUseResult;
    } else if (r && typeof r === 'object' && (typeof r.agentId === 'string' || r.status === 'async_launched')) {
      const keep: any = {};
      for (const key of ['status', 'isAsync', 'agentId', 'agentType', 'description', 'resolvedModel', 'modelsUsed', 'prompt']) {
        const value = r[key];
        if (typeof value === 'string') keep[key] = trimText(value);
        else if (typeof value === 'boolean') keep[key] = value;
        else if (Array.isArray(value) && key === 'modelsUsed') keep[key] = value.filter((m) => typeof m === 'string').map(trimText).slice(0, 10);
      }
      out.toolUseResult = Object.keys(keep).length ? keep : undefined;
    } else delete out.toolUseResult;
  }
  return out;
}

export function exists(p: string) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
