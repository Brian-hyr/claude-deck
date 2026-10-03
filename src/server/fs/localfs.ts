// Arquivos do próprio computador (Windows).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import crypto from 'node:crypto';
import type { CopyFs, CopyStat } from './copyfs';
import type { FileEntry, SearchMatch, SearchResult } from '../../shared/types';
import {
  buildSnippet,
  FsConflictError,
  IGNORED_DIRS,
  looksBinary,
  MAX_MATCHES_PER_FILE,
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_FILES_SCANNED,
  toSearchRegex,
  type HostFs,
  type SearchOpts,
  type StatInfo,
} from './hostfs';

function typeOf(st: fs.Stats): StatInfo['type'] {
  return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other';
}

export class LocalFs implements HostFs {
  readonly platform = process.platform === 'win32' ? ('win32' as const) : ('posix' as const);

  async copyFs(): Promise<CopyFs> {
    const platform = this.platform;
    const info = (st: fs.Stats): CopyStat => ({ type: typeOf(st), size: st.size, mtime: st.mtimeMs, mode: st.mode, identity: `${st.dev}:${st.ino}` });
    return {
      platform,
      lstat: async (p) => info(await fsp.lstat(p)),
      realpath: (p) => fsp.realpath(p),
      mkdir: (p) => fsp.mkdir(p).then(() => {}),
      async *entries(p) {
        const dir = await fsp.opendir(p);
        for await (const entry of dir) yield entry.name;
      },
      async source(p) {
        const h = await fsp.open(p, fs.constants.O_RDONLY | (platform === 'posix' ? fs.constants.O_NOFOLLOW : 0));
        try {
          const st = await h.stat();
          if (!st.isFile()) throw new Error('A origem deixou de ser um arquivo.');
          let pos = 0, closed = false;
          let closing: Promise<void> | undefined;
          const close = () => { if (!closed) { closed = true; closing = h.close(); } return closing!; };
          const stream = new Readable({
            highWaterMark: 256 * 1024, autoDestroy: false,
            read() {
              if (pos >= st.size) { this.push(null); return; }
              const data = Buffer.alloc(Math.min(256 * 1024, st.size - pos));
              h.read(data, 0, data.length, pos).then(({ bytesRead }) => { pos += bytesRead; this.push(bytesRead ? data.subarray(0, bytesRead) : null); }, (e) => this.destroy(e));
            },
            destroy(e, cb) { close().then(() => cb(e), (failure) => cb(e ?? failure)); },
          });
          return { stream, stat: async () => info(await h.stat()), close };
        } catch (e) { await h.close(); throw e; }
      },
      async stage(p) {
        const part = path.join(path.dirname(p), `.deck-copy-${crypto.randomUUID()}.part`);
        const h = await fsp.open(part, 'wx', 0o600);
        let closed = false, pos = 0;
        let closing: Promise<void> | undefined;
          const close = () => { if (!closed) { closed = true; closing = h.close(); } return closing!; };
        const stream = new Writable({
          highWaterMark: 256 * 1024, autoDestroy: false,
          write(data: Buffer, _enc, cb) {
            (async () => {
              for (let off = 0; off < data.length;) {
                const { bytesWritten } = await h.write(data, off, data.length - off, pos);
                if (!bytesWritten) throw new Error('A escrita do temporário não avançou.');
                off += bytesWritten; pos += bytesWritten;
              }
            })().then(() => cb(), cb);
          },
          destroy(e, cb) { close().then(() => cb(e), (failure) => cb(e ?? failure)); },
        });
        return {
          path: part, stream,
          async finish(mode) { if (mode !== undefined && platform === 'posix') await h.chmod(mode & 0o777); await close(); },
          async publish(replace) {
            if (!closed) throw new Error('Temporário ainda aberto.');
            if (replace) await fsp.rename(part, p);
            else await fsp.link(part, p);
          },
          async discard() { stream.destroy(); await close(); await fsp.unlink(part).catch((e) => { if (e.code !== 'ENOENT') throw e; }); },
        };
      },
    };
  }

  async list(dir: string): Promise<FileEntry[]> {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const out: FileEntry[] = new Array(ents.length);
    // No máximo 64 `lstat` por vez: uma chamada por arquivo ao mesmo tempo (30 mil numa pasta grande) enchia
    // a memória do servidor e a fila do sistema de arquivos sem terminar mais cedo.
    let next = 0;
    const worker = async () => {
      while (next < ents.length) {
        const i = next++;
        const e = ents[i];
        const full = path.join(dir, e.name);
        try {
          const lst = await fsp.lstat(full);
          const entry: FileEntry = { name: e.name, type: typeOf(lst), size: lst.size, mtime: lst.mtimeMs };
          if (lst.isSymbolicLink()) {
            try {
              const st = await fsp.stat(full);
              entry.targetType = st.isDirectory() ? 'dir' : 'file';
              entry.size = st.size;
            } catch {
              entry.targetType = 'missing';
            }
          }
          out[i] = entry;
        } catch {
          // Arquivos de sistema bloqueados (ex.: pagefile) aparecem sem detalhes.
          out[i] = { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: 0, mtime: 0 };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(64, ents.length) }, worker));
    return out;
  }

  async stat(p: string): Promise<StatInfo> {
    const st = await fsp.stat(p);
    return { type: typeOf(st), size: st.size, mtime: st.mtimeMs };
  }

  async exists(p: string) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async read(p: string, maxBytes: number) {
    const fh = await fsp.open(p, 'r');
    try {
      const st = await fh.stat();
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      let off = 0;
      while (off < len) {
        const { bytesRead } = await fh.read(buf, off, len - off, off);
        if (!bytesRead) break;
        off += bytesRead;
      }
      return { data: buf.subarray(0, off), size: st.size, mtime: st.mtimeMs, truncated: st.size > off };
    } finally {
      await fh.close();
    }
  }

  async readBytes(p: string, start: number, length: number) {
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(length);
      let off = 0;
      while (off < length) {
        const { bytesRead } = await fh.read(buf, off, length - off, start + off);
        if (!bytesRead) break;
        off += bytesRead;
      }
      return buf.subarray(0, off);
    } finally {
      await fh.close();
    }
  }

  async createReadStream(p: string, start: number, end: number): Promise<Readable> {
    return fs.createReadStream(p, { start, end, highWaterMark: 256 * 1024 });
  }

  async createWriteStream(p: string): Promise<Writable> {
    return fs.createWriteStream(p);
  }

  async write(p: string, data: Buffer, opts: { expectedMtime?: number; expectedSize?: number; createOnly?: boolean } = {}) {
    if (opts.createOnly && (await this.exists(p))) throw Object.assign(new Error('Já existe um item com esse nome.'), { code: 'exists' });
    if (opts.expectedMtime) {
      try {
        const st = await fsp.stat(p);
        if (Math.abs(st.mtimeMs - opts.expectedMtime) > 1) throw new FsConflictError(st.mtimeMs);
        if (opts.expectedSize !== undefined && st.size !== opts.expectedSize) throw new FsConflictError(st.mtimeMs);
      } catch (e) {
        if (e instanceof FsConflictError) throw e;
      }
    }
    await fsp.writeFile(p, data);
    return this.stat(p);
  }

  async mkdir(p: string) {
    await fsp.mkdir(p, { recursive: false });
  }

  /** Renomeia ou move (`to` pode estar em outra pasta). Nunca sobrescreve o que já existe. */
  async rename(from: string, to: string) {
    if (await this.exists(to)) throw Object.assign(new Error('Já existe um item com esse nome.'), { code: 'exists' });
    try {
      await fsp.rename(from, to);
    } catch (e: any) {
      if (e?.code !== 'EXDEV') throw e;
      // Outro disco: o sistema não move entre discos. Copia tudo e só apaga a origem com a cópia completa.
      try {
        await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
      } catch (err) {
        await fsp.rm(to, { recursive: true, force: true }).catch(() => {}); // `to` não existia: tudo ali é cópia parcial nossa
        throw err;
      }
      await fsp.rm(from, { recursive: true, force: false });
    }
  }

  async remove(p: string) {
    await fsp.rm(p, { recursive: true, force: false });
  }

  async append(p: string, data: Buffer) {
    await fsp.appendFile(p, data);
  }

  async realpath(p: string) {
    return fsp.realpath(p);
  }

  async findFiles(root: string, limit: number): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string, depth: number) => {
      if (out.length >= limit || depth > 14) return;
      let ents: fs.Dirent[];
      try {
        ents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (out.length >= limit) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name) || e.name.startsWith('$') || e.name === 'AppData') continue;
          await walk(path.join(dir, e.name), r, depth + 1);
        } else if (e.isFile()) out.push(r);
      }
    };
    await walk(root, '', 0);
    return out;
  }

  async search(root: string, query: string, opts: SearchOpts): Promise<SearchResult> {
    const re = toSearchRegex(query, opts.caseSensitive, opts.regex);
    const matches: SearchMatch[] = [];
    const filesWithMatches = new Set<string>();
    let truncated = false;
    let scanned = 0;

    // true = pare (limite atingido).
    const walk = async (dir: string, rel: string, depth: number): Promise<boolean> => {
      if (matches.length >= opts.limit || depth > 14) return matches.length >= opts.limit;
      let ents: fs.Dirent[];
      try {
        ents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const e of ents) {
        if (matches.length >= opts.limit) {
          truncated = true;
          return true;
        }
        const r = rel ? `${rel}/${e.name}` : e.name;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name) || e.name.startsWith('$') || e.name === 'AppData') continue;
          if (await walk(full, r, depth + 1)) return true;
          continue;
        }
        if (!e.isFile()) continue;
        if (scanned >= MAX_SEARCH_FILES_SCANNED) {
          truncated = true;
          return true;
        }
        scanned++;
        let st: fs.Stats;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        if (!st.size || st.size > MAX_SEARCH_FILE_BYTES) continue;
        let buf: Buffer;
        try {
          buf = await fsp.readFile(full);
        } catch {
          continue;
        }
        if (looksBinary(buf)) continue;
        const lines = buf.toString('utf8').split(/\r\n|\r|\n/);
        let perFile = 0;
        for (let i = 0; i < lines.length; i++) {
          if (perFile >= MAX_MATCHES_PER_FILE || matches.length >= opts.limit) break;
          re.lastIndex = 0;
          const m = re.exec(lines[i]);
          if (!m) continue;
          const snip = buildSnippet(lines[i], m.index, m[0].length || 1);
          matches.push({ file: r, line: i + 1, text: snip.text, hlStart: snip.hlStart, hlLen: snip.hlLen });
          filesWithMatches.add(r);
          perFile++;
        }
        if (matches.length >= opts.limit) {
          truncated = true;
          return true;
        }
      }
      return false;
    };
    await walk(root, '', 0);
    return { matches, filesWithMatches: filesWithMatches.size, truncated };
  }
}
