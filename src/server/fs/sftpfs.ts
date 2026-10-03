// Arquivos de um servidor remoto via SFTP (mesma conexão SSH das conversas).
import { Readable, Writable } from 'node:stream';
import crypto from 'node:crypto';
import type { CopyFs, CopyStat } from './copyfs';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { FileEntry, SearchMatch, SearchResult } from '../../shared/types';
import type { SshHost } from '../hosts/ssh';
import { buildSnippet, FsConflictError, IGNORED_DIRS, MAX_MATCHES_PER_FILE, shq, toSearchRegex, type HostFs, type SearchOpts, type StatInfo } from './hostfs';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function typeOfMode(mode: number): StatInfo['type'] {
  const t = mode & S_IFMT;
  return t === S_IFDIR ? 'dir' : t === S_IFREG ? 'file' : t === S_IFLNK ? 'symlink' : 'other';
}

const p2 = <T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

const READ_CHUNK = 32 * 1024;
const READ_WINDOW = 16;

/**
 * Lê [start, start+length) com uma janela deslizante de pedidos em paralelo (sempre 16 no ar):
 * esconde a latência da rede. Leitura curta = fim do arquivo (encolheu depois do stat).
 */
function readWindowed(s: SFTPWrapper, h: Buffer, start: number, length: number, into?: Buffer): Promise<Buffer> {
  const buf = into ?? Buffer.alloc(length);
  if (!length) return Promise.resolve(buf.subarray(0, 0));
  return new Promise((resolve, reject) => {
    let next = 0;
    let inflight = 0;
    let end = length; // encolhe se o arquivo acabar antes
    let failed = false;
    const pump = () => {
      while (!failed && inflight < READ_WINDOW && next < end) {
        const o = next;
        const n = Math.min(READ_CHUNK, end - o);
        next += n;
        inflight++;
        s.read(h, buf, o, n, start + o, (err, got) => {
          inflight--;
          if (failed) return;
          if (err) {
            failed = true;
            return reject(err);
          }
          if ((got || 0) < n) end = Math.min(end, o + (got || 0));
          if (next >= end && inflight === 0) return resolve(buf.subarray(0, end));
          pump();
        });
      }
    };
    pump();
  });
}

/** Fluxo de leitura de [start, end] com leituras paralelas (o do ssh2 lê um pedaço por vez). */
class SftpRangeStream extends Readable {
  private pos: number;
  private reading = false;
  private done = false;
  constructor(
    private s: SFTPWrapper,
    private h: Buffer,
    start: number,
    private end: number,
  ) {
    super({ highWaterMark: 1024 * 1024 });
    this.pos = start;
  }
  _read() {
    if (this.reading || this.done) return;
    if (this.pos > this.end) {
      this.push(null);
      return;
    }
    this.reading = true;
    const len = Math.min(READ_CHUNK * READ_WINDOW, this.end - this.pos + 1);
    readWindowed(this.s, this.h, this.pos, len).then(
      (b) => {
        this.reading = false;
        if (this.done) return;
        this.pos += b.length;
        if (!b.length) {
          this.push(null);
          return;
        }
        if (this.push(b)) this._read();
      },
      (e) => {
        this.reading = false;
        this.destroy(e);
      },
    );
  }
  _destroy(err: Error | null, cb: (e?: Error | null) => void) {
    this.done = true;
    this.s.close(this.h, () => cb(err));
  }
}

function friendly(e: any, p: string): Error {
  const code = e?.code;
  if (code === 2) return Object.assign(new Error(`Não encontrado: ${p}`), { code: 'notfound' });
  if (code === 3) return Object.assign(new Error(`Sem permissão: ${p}`), { code: 'denied' });
  return e instanceof Error ? e : new Error(String(e));
}

export class SftpFs implements HostFs {
  readonly platform = 'posix' as const;
  constructor(private host: SshHost) {}

  private sftp(): Promise<SFTPWrapper> {
    return this.host.sftp();
  }

  async copyFs(): Promise<CopyFs> {
    const s = await this.sftp(); // Não readquirir SFTP durante um job após queda da conexão.
    const info = (st: Stats): CopyStat => ({ type: typeOfMode(st.mode), size: st.size, mtime: st.mtime * 1000, mode: st.mode });
    const op = <T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void) => new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('SFTP não confirmou a operação de cópia.'), { code: 'timeout' })), 30_000);
      try { fn((e, value) => { clearTimeout(timer); e ? reject(e) : resolve(value); }); }
      catch (e) { clearTimeout(timer); reject(e); }
    });
    const lst = async (p: string) => {
      try { return info(await op<Stats>((cb) => s.lstat(p, cb as any))); }
      catch (e) { throw friendly(e, p); }
    };
    return {
      platform: 'posix', lstat: lst,
      realpath: (p) => op<string>((cb) => s.realpath(p, cb as any)),
      mkdir: (p) => op<void>((cb) => s.mkdir(p, cb as any)),
      async *entries(p) {
        const h = await op<Buffer>((cb) => s.opendir(p, cb as any));
        try {
          for (;;) {
            const batch = await op<any>((cb) => s.readdir(h, cb as any));
            if (batch === false || !batch.length) break;
            for (const entry of batch) if (entry.filename !== '.' && entry.filename !== '..') yield entry.filename;
          }
        } finally { await op<void>((cb) => s.close(h, cb as any)); }
      },
      async source(p) {
        const h = await op<Buffer>((cb) => s.open(p, 'r', cb as any));
        let closed = false;
        let closing: Promise<void> | undefined;
        const close = () => { if (!closed) { closed = true; closing = op<void>((cb) => s.close(h, cb as any)); } return closing!; };
        try {
          const stat = info(await op<Stats>((cb) => s.fstat(h, cb as any)));
          if (stat.type !== 'file') throw new Error('A origem deixou de ser um arquivo.');
          let pos = 0;
          const stream = new Readable({
            highWaterMark: 512 * 1024, autoDestroy: false,
            read() {
              if (pos >= stat.size) { this.push(null); return; }
              readWindowed(s, h, pos, Math.min(512 * 1024, stat.size - pos)).then((data) => {
                pos += data.length;
                this.push(data.length ? data : null);
              }, (e) => this.destroy(e));
            },
            destroy(e, cb) { close().then(() => cb(e), (failure) => cb(e ?? failure)); },
          });
          return { stream, stat: async () => info(await op<Stats>((cb) => s.fstat(h, cb as any))), close };
        } catch (e) { await close(); throw e; }
      },
      async stage(p) {
        const part = `${p.slice(0, p.lastIndexOf('/') + 1)}.deck-copy-${crypto.randomUUID()}.part`;
        const h = await op<Buffer>((cb) => s.open(part, 'wx', { mode: 0o600 }, cb as any));
        let pos = 0, closed = false;
        let closing: Promise<void> | undefined;
        const close = () => { if (!closed) { closed = true; closing = op<void>((cb) => s.close(h, cb as any)); } return closing!; };
        const stream = new Writable({
          highWaterMark: 256 * 1024, autoDestroy: false,
          write(chunk: Buffer, _encoding, cb) {
            // Até 16 pedidos no ar por bloco: esconde a latência sem acumular arquivo inteiro.
            const base = pos; pos += chunk.length;
            const writes: Promise<void>[] = [];
            for (let off = 0; off < chunk.length; off += READ_CHUNK) {
              const at = off, len = Math.min(READ_CHUNK, chunk.length - off);
              writes.push(op<void>((done) => s.write(h, chunk, at, len, base + at, done as any)));
            }
            Promise.all(writes).then(() => cb(), cb);
          },
          destroy(e, cb) { close().then(() => cb(e), (failure) => cb(e ?? failure)); },
        });
        return {
          path: part, stream,
          async finish(mode) { if (mode !== undefined) await op<void>((cb) => s.fchmod(h, mode & 0o777, cb as any)); await close(); },
          async publish(replace) {
            if (!closed) throw new Error('Temporário ainda aberto.');
            try {
              if (replace) await op<void>((cb) => s.ext_openssh_rename(part, p, cb as any));
              else await op<void>((cb) => s.ext_openssh_hardlink(part, p, cb as any));
            } catch (e: any) {
              if (/does not support/.test(e.message)) throw Object.assign(new Error('Este SFTP não oferece publicação segura de cópias (extensão OpenSSH ausente).'), { code: 'unsupported' });
              throw friendly(e, p);
            }
          },
          async discard() {
            stream.destroy(); await close();
            await op<void>((cb) => s.unlink(part, cb as any)).catch((e: any) => { if (e.code !== 2) throw e; });
          },
        };
      },
    };
  }

  async list(dir: string): Promise<FileEntry[]> {
    const s = await this.sftp();
    let items: { filename: string; attrs: Stats }[];
    try {
      items = await p2((cb) => s.readdir(dir, cb as any));
    } catch (e) {
      throw friendly(e, dir);
    }
    const out: FileEntry[] = [];
    const links: FileEntry[] = [];
    for (const it of items) {
      if (it.filename === '.' || it.filename === '..') continue;
      const type = typeOfMode(it.attrs.mode);
      const entry: FileEntry = { name: it.filename, type, size: it.attrs.size, mtime: it.attrs.mtime * 1000 };
      if (type === 'symlink') links.push(entry);
      out.push(entry);
    }
    // Resolve o tipo do alvo dos links (em paralelo, poucos por pasta).
    await Promise.all(
      links.map(async (l) => {
        try {
          const st = await p2<Stats>((cb) => s.stat(`${dir.replace(/\/$/, '')}/${l.name}`, cb as any));
          l.targetType = typeOfMode(st.mode) === 'dir' ? 'dir' : 'file';
          l.size = st.size;
        } catch {
          l.targetType = 'missing';
        }
      }),
    );
    return out;
  }

  async stat(p: string): Promise<StatInfo> {
    const s = await this.sftp();
    try {
      const st = await p2<Stats>((cb) => s.stat(p, cb as any));
      return { type: typeOfMode(st.mode), size: st.size, mtime: st.mtime * 1000 };
    } catch (e) {
      throw friendly(e, p);
    }
  }

  async exists(p: string) {
    try {
      await this.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  private async withHandle<T>(p: string, flags: 'r' | 'w', fn: (s: SFTPWrapper, h: Buffer) => Promise<T>): Promise<T> {
    const s = await this.sftp();
    let h: Buffer;
    try {
      h = await p2<Buffer>((cb) => s.open(p, flags as any, cb as any));
    } catch (e) {
      throw friendly(e, p);
    }
    try {
      return await fn(s, h);
    } finally {
      await p2<void>((cb) => s.close(h, cb as any)).catch(() => {});
    }
  }

  private readInto(s: SFTPWrapper, h: Buffer, start: number, length: number): Promise<Buffer> {
    return readWindowed(s, h, start, length);
  }

  async read(p: string, maxBytes: number) {
    return this.withHandle(p, 'r', async (s, h) => {
      const st = await p2<Stats>((cb) => s.fstat(h, cb as any));
      const len = Math.min(st.size, maxBytes);
      const data = len ? await this.readInto(s, h, 0, len) : Buffer.alloc(0);
      return { data, size: st.size, mtime: st.mtime * 1000, truncated: st.size > data.length };
    });
  }

  async readBytes(p: string, start: number, length: number) {
    return this.withHandle(p, 'r', async (s, h) => {
      const st = await p2<Stats>((cb) => s.fstat(h, cb as any));
      const len = Math.max(0, Math.min(length, st.size - start));
      return len ? this.readInto(s, h, start, len) : Buffer.alloc(0);
    });
  }

  async createReadStream(p: string, start: number, end: number): Promise<Readable> {
    const s = await this.sftp();
    let h: Buffer;
    try {
      h = await p2<Buffer>((cb) => s.open(p, 'r', cb as any));
    } catch (e) {
      throw friendly(e, p);
    }
    return new SftpRangeStream(s, h, start, end);
  }

  async createWriteStream(p: string): Promise<Writable> {
    const s = await this.sftp();
    return s.createWriteStream(p) as unknown as Writable;
  }

  async write(p: string, data: Buffer, opts: { expectedMtime?: number; expectedSize?: number; createOnly?: boolean } = {}) {
    if (opts.createOnly && (await this.exists(p))) throw Object.assign(new Error('Já existe um item com esse nome.'), { code: 'exists' });
    if (opts.expectedMtime) {
      try {
        const st = await this.stat(p);
        // SFTP tem resolução de segundos: o tamanho pega mudanças feitas no mesmo segundo.
        if (Math.abs(st.mtime - Math.floor(opts.expectedMtime / 1000) * 1000) >= 1000) throw new FsConflictError(st.mtime);
        if (opts.expectedSize !== undefined && st.size !== opts.expectedSize) throw new FsConflictError(st.mtime);
      } catch (e) {
        if (e instanceof FsConflictError) throw e;
      }
    }
    await this.withHandle(p, 'w', async (s, h) => {
      let off = 0;
      const CHUNK = 32 * 1024;
      while (off < data.length) {
        const batch: Promise<void>[] = [];
        for (let i = 0; i < 8 && off < data.length; i++) {
          const o = off;
          const n = Math.min(CHUNK, data.length - o);
          batch.push(new Promise<void>((resolve, reject) => s.write(h, data, o, n, o, (err) => (err ? reject(err) : resolve()))));
          off += n;
        }
        await Promise.all(batch);
      }
    });
    return this.stat(p);
  }

  async append(p: string, data: Buffer) {
    const s = await this.sftp();
    let h: Buffer;
    try {
      h = await p2<Buffer>((cb) => s.open(p, 'a' as any, cb as any));
    } catch (e) {
      throw friendly(e, p);
    }
    try {
      // Com SSH_FXF_APPEND o servidor ignora o offset e grava no fim.
      await new Promise<void>((resolve, reject) => s.write(h, data, 0, data.length, 0, (err) => (err ? reject(err) : resolve())));
    } finally {
      await p2<void>((cb) => s.close(h, cb as any)).catch(() => {});
    }
  }

  async mkdir(p: string) {
    const s = await this.sftp();
    try {
      await p2<void>((cb) => s.mkdir(p, cb as any));
    } catch (e) {
      throw friendly(e, p);
    }
  }

  /** Renomeia ou move (`to` pode estar em outra pasta). Nunca sobrescreve o que já existe. */
  async rename(from: string, to: string) {
    if (await this.exists(to)) throw Object.assign(new Error('Já existe um item com esse nome.'), { code: 'exists' });
    const s = await this.sftp();
    try {
      await p2<void>((cb) => s.rename(from, to, cb as any));
    } catch (e: any) {
      if (e?.code !== 4) throw friendly(e, from);
      // "Falha" genérica do SFTP: é o que o servidor responde ao mover entre sistemas de arquivos (ex.: /tmp → /home).
      // `mv` sabe copiar e apagar; ele também diz o motivo real se for outra coisa.
      const r = await this.host.run(`mv -n -- ${shq(from)} ${shq(to)}`, { timeoutMs: 600_000 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || 'Falha ao mover.');
    }
  }

  async remove(p: string) {
    if (!p || p === '/' || p.split('/').filter(Boolean).length < 2) throw new Error('Recusado: caminho curto demais para apagar.');
    const r = await this.host.run(`rm -rf -- ${shq(p)}`, { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Falha ao apagar.');
  }

  async realpath(p: string) {
    const s = await this.sftp();
    return p2<string>((cb) => s.realpath(p, cb as any));
  }

  async findFiles(root: string, limit: number): Promise<string[]> {
    const prune = [...IGNORED_DIRS].map((d) => `-name ${shq(d)}`).join(' -o ');
    const cmd =
      `cd ${shq(root)} 2>/dev/null || exit 3; ` +
      `if command -v rg >/dev/null 2>&1; then rg --files --hidden -g '!.git' 2>/dev/null; ` +
      `else find . -maxdepth 14 \\( ${prune} \\) -prune -o -type f -print 2>/dev/null | sed 's|^\\./||'; fi | head -n ${limit}`;
    const r = await this.host.run(cmd, { timeoutMs: 30_000 });
    return r.stdout.split('\n').filter(Boolean);
  }

  async search(root: string, query: string, opts: SearchOpts): Promise<SearchResult> {
    // Valida a regex localmente antes de gastar uma ida e volta por SSH.
    const re = toSearchRegex(query, opts.caseSensitive, opts.regex);
    // Sem barra no glob: o rg casa o nome em qualquer profundidade (com "d/**" ele ancora na raiz
    // e não exclui um src/node_modules aninhado).
    const excludeGlobs = [...IGNORED_DIRS].map((d) => `--glob ${shq('!' + d)}`).join(' ');
    const excludeDirs = [...IGNORED_DIRS].map((d) => `--exclude-dir=${shq(d)}`).join(' ');
    const q = shq(query);
    const headN = Math.max(opts.limit * 3, 300);
    const cmd =
      `cd ${shq(root)} 2>/dev/null || exit 3; ` +
      `if command -v rg >/dev/null 2>&1; then ` +
      `rg --vimgrep --hidden -g '!.git' ${excludeGlobs} -m ${MAX_MATCHES_PER_FILE} ${opts.caseSensitive ? '' : '-i'} ${opts.regex ? '' : '-F'} -- ${q} . 2>/dev/null; ` +
      `else ` +
      `grep -rnI ${opts.caseSensitive ? '' : '-i'} ${opts.regex ? '-E' : '-F'} ${excludeDirs} -- ${q} . 2>/dev/null; ` +
      `fi | head -n ${headN}`;
    const r = await this.host.run(cmd, { timeoutMs: 30_000 });
    if (r.code === 3) throw Object.assign(new Error(`Não encontrado: ${root}`), { code: 'notfound' });
    const rawLines = r.stdout.split('\n').filter(Boolean);
    const matches: SearchMatch[] = [];
    const filesWithMatches = new Set<string>();
    const perFile = new Map<string, number>();
    // rg --vimgrep: caminho:linha:coluna:texto — grep -rn: caminho:linha:texto (sem coluna).
    // A coluna do rg não é usada: recalculamos a posição do destaque localmente, para os dois
    // formatos caírem no mesmo caminho e ficarem consistentes entre si.
    for (const raw of rawLines) {
      if (matches.length >= opts.limit) break;
      const mv = raw.match(/^(.+?):(\d+):(\d+):([\s\S]*)$/);
      const mg = mv ? null : raw.match(/^(.+?):(\d+):([\s\S]*)$/);
      const parsed = mv ? { file: mv[1], line: mv[2], text: mv[4] } : mg ? { file: mg[1], line: mg[2], text: mg[3] } : null;
      if (!parsed) continue;
      const file = parsed.file.replace(/^\.\//, '');
      if (!file) continue;
      const n = perFile.get(file) ?? 0;
      if (n >= MAX_MATCHES_PER_FILE) continue;
      re.lastIndex = 0;
      const m = re.exec(parsed.text);
      if (!m) continue; // saída inconsistente (raro): descarta a linha em vez de mostrar destaque errado
      const snip = buildSnippet(parsed.text, m.index, m[0].length || 1);
      matches.push({ file, line: Number(parsed.line), text: snip.text, hlStart: snip.hlStart, hlLen: snip.hlLen });
      perFile.set(file, n + 1);
      filesWithMatches.add(file);
    }
    return { matches, filesWithMatches: filesWithMatches.size, truncated: matches.length >= opts.limit || rawLines.length >= headN };
  }
}
