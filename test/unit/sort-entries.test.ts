import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileEntry } from '../../src/shared/types';
import { sortEntries } from '../../src/server/fs/hostfs';
import { LocalFs } from '../../src/server/fs/localfs';

const e = (name: string, type: FileEntry['type'] = 'file', targetType?: FileEntry['targetType']): FileEntry => ({ name, type, size: 0, mtime: 0, targetType });

/** A regra antiga, palavra por palavra: a nova tem que dar exatamente a mesma ordem. */
const antiga = (items: FileEntry[]) =>
  [...items].sort((a, b) => {
    const da = a.type === 'dir' || a.targetType === 'dir' ? 0 : 1;
    const db = b.type === 'dir' || b.targetType === 'dir' ? 0 : 1;
    return da - db || a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base', numeric: true });
  });

describe('sortEntries', () => {
  it('pastas primeiro (inclusive link para pasta), depois arquivos', () => {
    const r = sortEntries([e('b.txt'), e('zeta', 'dir'), e('a.txt'), e('atalho', 'symlink', 'dir'), e('quebrado', 'symlink', 'missing'), e('alfa', 'dir')]);
    expect(r.map((x) => x.name)).toEqual(['alfa', 'atalho', 'zeta', 'a.txt', 'b.txt', 'quebrado']);
  });

  it('números por valor, sem distinguir maiúsculas nem acentos (pt-BR)', () => {
    const r = sortEntries([e('arquivo10.txt'), e('arquivo2.txt'), e('Arquivo1.txt'), e('árvore.txt'), e('arvore2.txt'), e('Zebra.txt'), e('ação.txt')]);
    expect(r.map((x) => x.name)).toEqual(['ação.txt', 'Arquivo1.txt', 'arquivo2.txt', 'arquivo10.txt', 'árvore.txt', 'arvore2.txt', 'Zebra.txt']);
    // "a" e "á" empatam na comparação (só a base conta): o empate mantém a ordem em que vieram.
    expect(sortEntries([e('acao.txt'), e('ação.txt')]).map((x) => x.name)).toEqual(['acao.txt', 'ação.txt']);
    expect(sortEntries([e('ação.txt'), e('acao.txt')]).map((x) => x.name)).toEqual(['ação.txt', 'acao.txt']);
  });

  it('mesma ordem da regra antiga em nomes variados (acentos, maiúsculas, números, pontos, espaços)', () => {
    const nomes = [
      'README.md', 'readme.txt', '.env', '.gitignore', 'a', 'A', 'á', 'b', 'B', 'ç', 'c', 'Ç', 'ñ', 'n', 'z', 'Z',
      '1.txt', '2.txt', '10.txt', '100.txt', '01.txt', 'file 1', 'file  1', 'file-1', 'file_1', 'file.1', 'File 2', 'file 10',
      'relatório final.pdf', 'relatorio final.pdf', 'Relatório_2024.pdf', 'relatorio_2023.pdf', 'ÓTIMO.txt', 'otimo.txt', 'ótimo.txt',
      '日本語.txt', 'عربى.txt', 'тест.txt', '~temp', '#nota', '(copia).txt', 'x y z', 'X-Y-Z',
    ];
    const items = nomes.flatMap((n, i) => [e(n, i % 5 === 0 ? 'dir' : 'file'), e(`${n}.lnk`, 'symlink', i % 3 === 0 ? 'dir' : 'file')]);
    // embaralha de forma determinística
    const emb = [...items].sort((a, b) => ((a.name.length * 31 + a.name.charCodeAt(0)) % 17) - ((b.name.length * 31 + b.name.charCodeAt(0)) % 17));
    expect(sortEntries([...emb]).map((x) => x.name)).toEqual(antiga(emb).map((x) => x.name));
  });

  it('5000 arquivos: bem abaixo do tempo da regra antiga', () => {
    const items = Array.from({ length: 5000 }, (_, i) => e(`arquivo-${String((i * 7919) % 5000).padStart(5, '0')}.txt`));
    const t0 = performance.now();
    sortEntries(items);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});

describe('LocalFs.list com muitos arquivos', () => {
  it('devolve todos, sem repetir nem perder, com tipo e tamanho certos (64 por vez)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-list-'));
    try {
      const N = 700;
      for (let i = 0; i < N; i++) fs.writeFileSync(path.join(dir, `f-${i}.txt`), 'x'.repeat(i % 7));
      fs.mkdirSync(path.join(dir, 'pasta'));
      const r = await new LocalFs().list(dir);
      expect(r).toHaveLength(N + 1);
      expect(new Set(r.map((x) => x.name)).size).toBe(N + 1);
      expect(r.find((x) => x.name === 'pasta')?.type).toBe('dir');
      const f5 = r.find((x) => x.name === 'f-5.txt')!;
      expect(f5.type).toBe('file');
      expect(f5.size).toBe(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pasta vazia e pasta inexistente', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-list-'));
    try {
      expect(await new LocalFs().list(dir)).toEqual([]);
      await expect(new LocalFs().list(path.join(dir, 'nao-existe'))).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
