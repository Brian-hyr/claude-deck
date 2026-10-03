import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnippet, MAX_MATCHES_PER_FILE, toSearchRegex } from '../../src/server/fs/hostfs';
import { LocalFs } from '../../src/server/fs/localfs';

describe('toSearchRegex', () => {
  it('texto literal escapa metacaracteres', () => {
    const re = toSearchRegex('a.b(c)', false, false);
    expect(re.test('xa.b(c)y')).toBe(true);
    expect(toSearchRegex('a.b', false, false).test('axb')).toBe(false);
  });
  it('regex usa o padrão como está; caixa respeita o flag', () => {
    expect(toSearchRegex('a.b', false, true).test('AXB')).toBe(true);
    expect(toSearchRegex('a.b', true, true).test('AXB')).toBe(false);
  });
  it('regex inválida lança erro', () => {
    expect(() => toSearchRegex('(', false, true)).toThrow();
  });
});

describe('buildSnippet', () => {
  it('linha curta fica intacta', () => {
    expect(buildSnippet('abc def', 4, 3)).toEqual({ text: 'abc def', hlStart: 4, hlLen: 3 });
  });
  it('linha longa é recortada e o destaque continua apontando para o trecho certo', () => {
    const line = 'x'.repeat(1000) + 'ALVO' + 'y'.repeat(1000);
    const s = buildSnippet(line, 1000, 4);
    expect(s.text.length).toBeLessThanOrEqual(305);
    expect(s.text.substr(s.hlStart, s.hlLen)).toBe('ALVO');
    expect(s.text.startsWith('…') && s.text.endsWith('…')).toBe(true);
  });
  it('alvo no começo/fim da linha longa também aponta certo', () => {
    const a = buildSnippet('ALVO' + 'y'.repeat(1000), 0, 4);
    expect(a.text.substr(a.hlStart, a.hlLen)).toBe('ALVO');
    const line = 'x'.repeat(1000) + 'ALVO';
    const b = buildSnippet(line, 1000, 4);
    expect(b.text.substr(b.hlStart, b.hlLen)).toBe('ALVO');
  });
});

describe('LocalFs.search', () => {
  let root: string;
  const fsx = new LocalFs();
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-search-'));
    fs.mkdirSync(path.join(root, 'src', 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'primeira linha\nTem Alvo aqui\r\nfim\n');
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'alvo de novo\nalvo alvo\n');
    fs.writeFileSync(path.join(root, 'src', 'node_modules', 'pkg', 'x.js'), 'alvo ignorado\n');
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 97, 108, 118, 111, 0]));
    fs.writeFileSync(path.join(root, 'muitas.txt'), Array.from({ length: 100 }, () => 'alvo').join('\n'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('acha, com caminho relativo em "/", linha 1-based e destaque; ignora node_modules e binários', async () => {
    const r = await fsx.search(root, 'alvo', { caseSensitive: false, regex: false, limit: 500 });
    const files = new Set(r.matches.map((m) => m.file));
    expect(files).toEqual(new Set(['a.txt', 'sub/b.txt', 'muitas.txt']));
    const a = r.matches.find((m) => m.file === 'a.txt')!;
    expect(a.line).toBe(2); // \r\n não desloca a contagem
    expect(a.text.substr(a.hlStart, a.hlLen)).toBe('Alvo');
    expect(r.filesWithMatches).toBe(3);
  });
  it('limita ocorrências por arquivo e marca truncado ao estourar o limite total', async () => {
    const r = await fsx.search(root, 'alvo', { caseSensitive: false, regex: false, limit: 500 });
    expect(r.matches.filter((m) => m.file === 'muitas.txt').length).toBe(MAX_MATCHES_PER_FILE);
    const small = await fsx.search(root, 'alvo', { caseSensitive: false, regex: false, limit: 3 });
    expect(small.matches.length).toBe(3);
    expect(small.truncated).toBe(true);
  });
  it('diferenciar caixa e regex', async () => {
    expect((await fsx.search(root, 'ALVO', { caseSensitive: true, regex: false, limit: 50 })).matches.length).toBe(0);
    expect((await fsx.search(root, 'al.o', { caseSensitive: false, regex: false, limit: 50 })).matches.length).toBe(0);
    expect((await fsx.search(root, 'al.o', { caseSensitive: false, regex: true, limit: 50 })).matches.length).toBeGreaterThan(0);
  });
});
