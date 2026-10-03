import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { crc32, walkZipItems, zipChunks, type ZipItem } from '../../src/server/fs/zip';
import { mkdirp } from '../../src/server/fs/hostfs';
import { LocalFs } from '../../src/server/fs/localfs';

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of gen) parts.push(c);
  return Buffer.concat(parts);
}

async function* itemsOf(list: ZipItem[]): AsyncGenerator<ZipItem> {
  for (const i of list) yield i;
}

interface Entry {
  name: string;
  method: number;
  data: Buffer;
  crcOk: boolean;
  isDir: boolean;
}

/** Leitor independente: percorre o diretório central (com zip64) e confere CRC e tamanhos. */
function readZip(zip: Buffer): Entry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  expect(eocd).toBeGreaterThanOrEqual(0);
  let count = zip.readUInt16LE(eocd + 10);
  let cdOff = zip.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    expect(zip.readUInt32LE(loc)).toBe(0x07064b50);
    const z = Number(zip.readBigUInt64LE(loc + 8));
    expect(zip.readUInt32LE(z)).toBe(0x06064b50);
    count = Number(zip.readBigUInt64LE(z + 32));
    cdOff = Number(zip.readBigUInt64LE(z + 48));
  }
  const out: Entry[] = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    let csize = zip.readUInt32LE(p + 20);
    let usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const xlen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    let off = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const extra = zip.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
    for (let x = 0; x + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(x);
      const len = extra.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (off === 0xffffffff) off = Number(extra.readBigUInt64LE(q));
      }
      x += 4 + len;
    }
    // Cabeçalho local: dados começam depois do nome e do extra locais.
    expect(zip.readUInt32LE(off)).toBe(0x04034b50);
    const lnlen = zip.readUInt16LE(off + 26);
    const lxlen = zip.readUInt16LE(off + 28);
    const start = off + 30 + lnlen + lxlen;
    const raw = zip.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    out.push({ name, method, data, crcOk: data.length === usize && crc32(data, 0) === crc, isDir: name.endsWith('/') });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

describe('zip em fluxo', () => {
  it('gera um zip válido com pasta, arquivo vazio, acentos e compressão', async () => {
    const big = Buffer.from('linha repetida para comprimir bem\n'.repeat(5000));
    const zip = await collect(
      zipChunks(
        itemsOf([
          { name: 'pasta/', dir: true },
          { name: 'pasta/vazio.txt', size: 0, open: async () => Readable.from([]) },
          { name: 'pasta/grande.txt', size: big.length, open: async () => Readable.from([big.subarray(0, 70000), big.subarray(70000)]) },
          { name: 'pasta/já-não-é açúcar.txt', size: 3, open: async () => Readable.from([Buffer.from('oi\n')]) },
          { name: 'pasta/foto.png', size: 4, open: async () => Readable.from([Buffer.from([1, 2, 3, 4])]) },
          { name: 'pasta/sub/', dir: true },
        ]),
      ),
    );
    const es = readZip(zip);
    expect(es.map((e) => e.name)).toEqual(['pasta/', 'pasta/vazio.txt', 'pasta/grande.txt', 'pasta/já-não-é açúcar.txt', 'pasta/foto.png', 'pasta/sub/']);
    expect(es.every((e) => e.crcOk)).toBe(true);
    expect(es[1].data.length).toBe(0);
    expect(es[2].data.equals(big)).toBe(true);
    expect(es[2].method).toBe(8);
    expect(zip.length).toBeLessThan(big.length / 4); // comprimiu de verdade
    expect(es[3].data.toString()).toBe('oi\n');
    expect(es[4].method).toBe(0); // .png já vem comprimido: só armazenado
    expect(es[5].isDir).toBe(true);
  });

  it('entrada que anuncia mais de 4 GB usa zip64 e continua legível', async () => {
    const zip = await collect(zipChunks(itemsOf([{ name: 'x/', dir: true }, { name: 'x/enorme.bin', size: 0xf0000001, open: async () => Readable.from([Buffer.from('pequeno')]) }])));
    const es = readZip(zip);
    expect(es[1].name).toBe('x/enorme.bin');
    expect(es[1].data.toString()).toBe('pequeno');
    expect(es[1].crcOk).toBe(true);
  });

  it('arquivo ilegível é pulado e listado num LEIA-ME dentro do zip', async () => {
    const skipped: string[] = [];
    const zip = await collect(
      zipChunks(
        itemsOf([
          { name: 'a/', dir: true },
          { name: 'a/ok.txt', size: 2, open: async () => Readable.from([Buffer.from('ok')]) },
          {
            name: 'a/negado.txt',
            size: 5,
            open: async () => {
              throw new Error('Sem permissão');
            },
          },
          {
            name: 'a/quebra-no-meio.txt',
            size: 5,
            open: async () =>
              new Readable({
                read() {
                  this.destroy(new Error('EBUSY'));
                },
              }),
          },
        ]),
        skipped,
      ),
    );
    const es = readZip(zip);
    expect(es.map((e) => e.name)).toEqual(['a/', 'a/ok.txt', 'LEIA-ME-itens-nao-incluidos.txt']);
    expect(es[2].data.toString()).toContain('a/negado.txt');
    expect(es[2].data.toString()).toContain('a/quebra-no-meio.txt');
    expect(es.every((e) => e.crcOk)).toBe(true);
  });

  it('conjunto vazio ainda gera um zip válido', async () => {
    const zip = await collect(zipChunks(itemsOf([])));
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });
});

describe('percorrer pasta real + mkdirp', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-zip-'));
  });
  afterAll(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* limpeza de temporário: não derruba o teste */
    }
  });

  it('zipa uma pasta com subpastas, vazia incluída, pelo HostFs', async () => {
    const root = path.join(tmp, 'origem');
    fs.mkdirSync(path.join(root, 'sub', 'fundo'), { recursive: true });
    fs.mkdirSync(path.join(root, 'vazia'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'A\n');
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'B\n');
    fs.writeFileSync(path.join(root, 'sub', 'fundo', 'c.txt'), 'C\n');
    fs.writeFileSync(path.join(root, 'zero.bin'), '');
    const skipped: string[] = [];
    const zip = await collect(zipChunks(walkZipItems(new LocalFs(), root, 'origem', skipped), skipped));
    const es = readZip(zip);
    expect(es.map((e) => e.name).sort()).toEqual(['origem/', 'origem/a.txt', 'origem/sub/', 'origem/sub/b.txt', 'origem/sub/fundo/', 'origem/sub/fundo/c.txt', 'origem/vazia/', 'origem/zero.bin']);
    expect(es.find((e) => e.name === 'origem/sub/fundo/c.txt')!.data.toString()).toBe('C\n');
    expect(es.every((e) => e.crcOk)).toBe(true);
    expect(skipped).toEqual([]);
  });

  it('mkdirp cria os níveis que faltam, aceita pasta existente e recusa arquivo no caminho', async () => {
    const lfs = new LocalFs();
    const fundo = path.join(tmp, 'x', 'y', 'z');
    await mkdirp(lfs, fundo);
    expect(fs.statSync(fundo).isDirectory()).toBe(true);
    await mkdirp(lfs, fundo + path.sep); // de novo, com barra final: sem erro
    fs.writeFileSync(path.join(tmp, 'arquivo'), 'x');
    await expect(mkdirp(lfs, path.join(tmp, 'arquivo', 'dentro'))).rejects.toThrow(/arquivo/i);
    // Duas criações simultâneas da mesma árvore não brigam.
    const par = path.join(tmp, 'par', 'a', 'b');
    await Promise.all([mkdirp(lfs, par), mkdirp(lfs, par), mkdirp(lfs, par)]);
    expect(fs.statSync(par).isDirectory()).toBe(true);
  });
});
