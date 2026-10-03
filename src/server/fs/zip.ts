// Gera um .zip em fluxo (nada vai para o disco): usado para baixar uma pasta inteira de qualquer servidor.
// Sem dependências: entradas com "data descriptor" (tamanho/CRC vêm depois dos dados) e zip64 quando preciso.
import path from 'node:path';
import { Readable, Transform, pipeline } from 'node:stream';
import zlib from 'node:zlib';
import type { FileEntry } from '../../shared/types';
import type { HostFs } from './hostfs';

export interface ZipItem {
  /** Caminho dentro do zip, com '/' e sem barra inicial. Pastas terminam em '/'. */
  name: string;
  dir?: boolean;
  /** Tamanho esperado do arquivo (decide se a entrada precisa de zip64). */
  size?: number;
  /** ms desde 1970. */
  mtime?: number;
  /** Abre o conteúdo (ausente em pastas). */
  open?: () => Promise<Readable>;
}

const U32_MAX = 0xffffffff;
/** Acima disso a entrada já nasce zip64 (o tamanho real só é conhecido no fim). */
const ZIP64_ENTRY_AT = 0xf0000000;
/** Já comprimidos: deflate só gastaria CPU. */
const STORE_EXT = /\.(zip|gz|tgz|bz2|xz|7z|rar|zst|jpe?g|png|gif|webp|avif|heic|mp3|m4a|aac|ogg|opus|flac|mp4|m4v|mkv|webm|mov|avi|pdf|docx|xlsx|pptx|jar|apk|woff2?)$/i;

let crcTable: Int32Array | null = null;
function crc32Fallback(buf: Uint8Array, prev: number): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
/** zlib.crc32 existe do Node 22.2 em diante; abaixo disso usa a tabela. */
export const crc32: (buf: Uint8Array, prev: number) => number = (zlib as any).crc32 ?? crc32Fallback;

function dosDateTime(ms?: number): { date: number; time: number } {
  const d = new Date(ms && ms > 0 ? ms : Date.now());
  const y = Math.min(2107, Math.max(1980, d.getFullYear()));
  return { date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) };
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(n))));
  return b;
}

interface CentralRec {
  name: Buffer;
  dir: boolean;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  zip64: boolean;
}

function localHeader(name: Buffer, dir: boolean, method: number, time: number, date: number, zip64: boolean): Buffer {
  const extra = zip64 && !dir ? Buffer.concat([Buffer.from([1, 0, 16, 0]), Buffer.alloc(16)]) : Buffer.alloc(0);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(zip64 && !dir ? 45 : 20, 4);
  h.writeUInt16LE(dir ? 0x0800 : 0x0808, 6); // bit 11: nomes em UTF-8; bit 3: tamanhos/CRC no descriptor
  h.writeUInt16LE(dir ? 0 : method, 8);
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  // crc/tamanhos: 0 (vêm no data descriptor); em zip64 os campos de tamanho marcam 0xFFFFFFFF.
  h.writeUInt32LE(zip64 && !dir ? U32_MAX : 0, 18);
  h.writeUInt32LE(zip64 && !dir ? U32_MAX : 0, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, name, extra]);
}

function dataDescriptor(crc: number, csize: number, usize: number, zip64: boolean): Buffer {
  if (!zip64) {
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeUInt32LE(csize, 8);
    d.writeUInt32LE(usize, 12);
    return d;
  }
  const d = Buffer.alloc(24);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(crc >>> 0, 4);
  d.writeBigUInt64LE(BigInt(csize), 8);
  d.writeBigUInt64LE(BigInt(usize), 16);
  return d;
}

function centralHeader(r: CentralRec): Buffer {
  const bigOffset = r.offset >= U32_MAX;
  const fields: Buffer[] = [];
  if (r.zip64) fields.push(u64(r.usize), u64(r.csize));
  if (bigOffset) fields.push(u64(r.offset));
  const extra = fields.length ? Buffer.concat([Buffer.from([1, 0]), (() => { const l = Buffer.alloc(2); l.writeUInt16LE(fields.length * 8); return l; })(), ...fields]) : Buffer.alloc(0);
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE((3 << 8) | 45, 4); // criado no Unix, zip 4.5
  h.writeUInt16LE(r.zip64 || bigOffset ? 45 : 20, 6);
  h.writeUInt16LE(r.flags, 8);
  h.writeUInt16LE(r.method, 10);
  h.writeUInt16LE(r.time, 12);
  h.writeUInt16LE(r.date, 14);
  h.writeUInt32LE(r.crc >>> 0, 16);
  h.writeUInt32LE(r.zip64 ? U32_MAX : r.csize, 20);
  h.writeUInt32LE(r.zip64 ? U32_MAX : r.usize, 24);
  h.writeUInt16LE(r.name.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt32LE((((r.dir ? 0o40755 : 0o100644) << 16) | (r.dir ? 0x10 : 0)) >>> 0, 38);
  h.writeUInt32LE(bigOffset ? U32_MAX : r.offset, 42);
  return Buffer.concat([h, r.name, extra]);
}

function endRecords(count: number, cdSize: number, cdOffset: number): Buffer {
  const need64 = count > 0xfffe || cdSize >= U32_MAX || cdOffset >= U32_MAX;
  const parts: Buffer[] = [];
  if (need64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(need64 ? 0xffff : count, 8);
  e.writeUInt16LE(need64 ? 0xffff : count, 10);
  e.writeUInt32LE(need64 ? U32_MAX : cdSize, 12);
  e.writeUInt32LE(need64 ? U32_MAX : cdOffset, 16);
  parts.push(e);
  return Buffer.concat(parts);
}

/**
 * Transforma os itens em pedaços de um .zip. `skipped` recebe o que não pôde ser lido
 * (sem permissão, arquivo em uso...): vira um LEIA-ME dentro do zip em vez de derrubar o download.
 */
export async function* zipChunks(items: AsyncIterable<ZipItem>, skipped: string[] = []): AsyncGenerator<Buffer> {
  let offset = 0;
  const central: CentralRec[] = [];

  async function* one(it: ZipItem): AsyncGenerator<Buffer> {
    const name = Buffer.from(it.name, 'utf8');
    const { date, time } = dosDateTime(it.mtime);
    if (it.dir) {
      const hdr = localHeader(name, true, 0, time, date, false);
      central.push({ name, dir: true, flags: 0x0800, method: 0, time, date, crc: 0, csize: 0, usize: 0, offset, zip64: false });
      offset += hdr.length;
      yield hdr;
      return;
    }
    const zip64 = (it.size ?? 0) >= ZIP64_ENTRY_AT;
    const method = STORE_EXT.test(it.name) || !it.size ? 0 : 8;
    let src: Readable;
    try {
      src = await it.open!();
    } catch (e: any) {
      skipped.push(`${it.name}: ${e?.message ?? e}`);
      return;
    }
    let crc = 0;
    let usize = 0;
    let csize = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        crc = crc32(chunk, crc);
        usize += chunk.length;
        cb(null, chunk);
      },
    });
    const last: Readable = method === 8 ? (pipeline(src, tap, zlib.createDeflateRaw({ level: 3 }), () => {}) as unknown as Readable) : (pipeline(src, tap, () => {}) as unknown as Readable);
    const iter = last[Symbol.asyncIterator]();
    try {
      // O primeiro pedaço é lido antes de gravar o cabeçalho: se o arquivo não abre de verdade
      // (permissão, em uso), dá para pular a entrada sem deixar lixo no zip.
      let first: IteratorResult<Buffer>;
      try {
        first = await iter.next();
      } catch (e: any) {
        skipped.push(`${it.name}: ${e?.message ?? e}`);
        return;
      }
      const start = offset;
      const hdr = localHeader(name, false, method, time, date, zip64);
      offset += hdr.length;
      yield hdr;
      let cur = first;
      while (!cur.done) {
        const chunk = cur.value;
        csize += chunk.length;
        offset += chunk.length;
        yield chunk;
        cur = await iter.next();
      }
      if (!zip64 && (usize >= U32_MAX || csize >= U32_MAX)) throw new Error(`Arquivo cresceu além de 4 GB durante o download: ${it.name}`);
      const dd = dataDescriptor(crc, csize, usize, zip64);
      offset += dd.length;
      yield dd;
      central.push({ name, dir: false, flags: 0x0808, method, time, date, crc, csize, usize, offset: start, zip64 });
    } finally {
      src.destroy();
      last.destroy();
    }
  }

  for await (const it of items) yield* one(it);
  if (skipped.length) {
    const txt = Buffer.from(
      `Estes itens não puderam ser lidos e não estão neste zip:\r\n\r\n${skipped.join('\r\n')}\r\n`,
      'utf8',
    );
    yield* one({ name: 'LEIA-ME-itens-nao-incluidos.txt', size: txt.length, open: async () => Readable.from([txt]) });
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const r of central) {
    const h = centralHeader(r);
    cdSize += h.length;
    yield h;
  }
  yield endRecords(central.length, cdSize, cdOffset);
}

/** Máximo de itens (arquivos + pastas) numa pasta baixada: trava contra pasta acidental gigante (ex.: a raiz do disco). */
export const ZIP_MAX_ITEMS = 500_000;

/** Percorre a pasta em profundidade, produzindo os itens do zip à medida que descobre (o download começa já). */
export async function* walkZipItems(fsx: HostFs, root: string, top: string, skipped: string[]): AsyncGenerator<ZipItem> {
  const pj = fsx.platform === 'win32' ? path.win32 : path.posix;
  let count = 0;

  async function* rec(dir: string, prefix: string, mtime?: number): AsyncGenerator<ZipItem> {
    yield { name: prefix, dir: true, mtime };
    let list: FileEntry[];
    try {
      list = await fsx.list(dir);
    } catch (e: any) {
      skipped.push(`${prefix}: ${e?.message ?? e}`);
      return;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      if (++count > ZIP_MAX_ITEMS) throw new Error(`Pasta grande demais para baixar de uma vez (mais de ${ZIP_MAX_ITEMS} itens).`);
      const full = pj.join(dir, e.name);
      if (e.type === 'dir') {
        yield* rec(full, `${prefix}${e.name}/`, e.mtime);
      } else if (e.type === 'file' || (e.type === 'symlink' && e.targetType === 'file')) {
        const size = e.size;
        yield {
          name: `${prefix}${e.name}`,
          size,
          mtime: e.mtime,
          // Arquivo vazio não abre fluxo (intervalo [0,-1] é inválido).
          open: size > 0 ? () => fsx.createReadStream(full, 0, size - 1) : async () => Readable.from([]),
        };
      }
      // link para pasta (evita laço), soquetes e pipes (travariam a leitura) ficam de fora.
    }
  }

  yield* rec(root, `${top}/`);
}
