// Filesystem de teste sem rede: hosts distintos, streams lentos/falhas e tamanhos virtuais.
import { Readable, Writable } from 'node:stream';
import type { CopyFs, CopyStage, CopyStat } from '../../src/server/fs/copyfs';

interface Node { st: CopyStat; data?: Buffer }
export class MemoryCopyFs implements CopyFs {
  platform = 'posix' as const;
  nodes = new Map<string, Node>([['/', { st: { type: 'dir', size: 0, mtime: 1 } }]]);
  failWrite = false;
  failClose = false;
  uncertain = false;
  delay = 0;
  maxBuffered = 0;
  closed = 0;
  published = 0;
  readBytes = 0;
  writeBytes = 0;
  private seq = 0;
  put(p: string, data: string | Buffer = '') { const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data); this.nodes.set(p, { st: { type: 'file', size: bytes.length, mtime: 1, mode: 0o755 }, data: bytes }); }
  virtual(p: string, size: number) { this.nodes.set(p, { st: { type: 'file', size, mtime: 1, mode: 0o755 } }); }
  link(p: string) { this.nodes.set(p, { st: { type: 'symlink', size: 0, mtime: 1 } }); }
  async lstat(p: string) { const n = this.nodes.get(p); if (!n) throw Object.assign(new Error(`missing ${p}`), { code: 'ENOENT' }); return { ...n.st }; }
  async *entries(p: string) { for (const name of this.nodes.keys()) if (name !== p && name.startsWith(`${p === '/' ? '' : p}/`) && !name.slice(p.length + (p === '/' ? 0 : 1)).includes('/')) yield name.slice(p.length + (p === '/' ? 0 : 1)); }
  async realpath(p: string) { await this.lstat(p); return p; }
  async mkdir(p: string) { if (this.nodes.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); this.nodes.set(p, { st: { type: 'dir', size: 0, mtime: 1 } }); }
  async source(p: string) {
    const n = this.nodes.get(p)!; let pos = 0; const fixture = this;
    const block = Buffer.alloc(1024 * 1024);
    const stream = new Readable({ highWaterMark: 1024 * 1024, autoDestroy: false, read() {
      if (pos >= n.st.size) { this.push(null); return; }
      const len = Math.min(block.length, n.st.size - pos);
      const data = n.data ? n.data.subarray(pos, pos + len) : block.subarray(0, len);
      pos += len; fixture.readBytes += len; this.push(data);
    } });
    let closed = false;
    return { stream, stat: () => this.lstat(p), close: async () => { if (!closed) { closed = true; this.closed++; } } };
  }
  async stage(p: string): Promise<CopyStage> {
    const part = `${p}.part-${++this.seq}`; const fixture = this;
    let bytes = 0, mode = 0o600, chunks: Buffer[] = [];
    this.nodes.set(part, { st: { type: 'file', size: 0, mtime: 1 } });
    const stream = new Writable({ highWaterMark: 1024 * 1024, write(data: Buffer, _e, cb) {
      fixture.maxBuffered = Math.max(fixture.maxBuffered, this.writableLength);
      if (fixture.failWrite) { cb(new Error('disco cheio')); return; }
      bytes += data.length; fixture.writeBytes += data.length;
      if (bytes <= 4 * 1024 * 1024) chunks.push(Buffer.from(data)); else chunks = [];
      fixture.delay ? setTimeout(cb, fixture.delay) : cb();
    } });
    return {
      path: part, stream,
      async finish(m) { if (fixture.failClose) throw new Error('close falhou'); mode = m ?? mode; fixture.closed++; },
      async publish(replace) {
        if (!replace && fixture.nodes.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        fixture.nodes.set(p, { st: { type: 'file', size: bytes, mtime: 1, mode }, data: chunks.length ? Buffer.concat(chunks) : undefined }); fixture.published++;
        if (fixture.uncertain) throw Object.assign(new Error('connection closed during commit'), { code: 'timeout' });
      },
      async discard() { stream.destroy(); fixture.nodes.delete(part); },
    };
  }
}
