import { describe, it, expect } from 'vitest';
import type { FileEntry } from '../../src/shared/types';
import { flattenTree, makeJoin, visibleRange, ROW_H, OVERSCAN, type DirLike, type FlattenOpts, type TreeRow } from '../../src/web/lib/treeRows';
import { join } from '../../src/shared/paths';

describe('makeJoin (igual ao join de caminhos, só mais barato por arquivo)', () => {
  const posix = ['/', '/home/usuario', '/home/usuario/', '/home//usuario/./proj', '/a/b/../c', '/tmp/pasta com espaço', '/x/y\\z'];
  const win = ['C:\\', 'C:', 'C:\\Users\\usuario', 'C:\\Users\\usuario\\', 'C:/Users/usuario/proj', 'C:\\a\\.\\b\\..\\c', '\\\\srv\\share', '\\\\srv\\share\\pasta'];
  const names = ['a.txt', 'sem-extensao', '.env', 'com espaço.md', 'ação-ç.txt', 'a b', "o'brien", 'x\\y'];
  it('posix', () => {
    for (const dir of posix) {
      const j = makeJoin('posix');
      for (const n of names) expect(j(dir, n)).toBe(join('posix', dir, n));
    }
  });
  it('windows', () => {
    for (const dir of win) {
      const j = makeJoin('win32');
      for (const n of names.filter((x) => !x.includes('\\'))) expect(j(dir, n)).toBe(join('win32', dir, n));
    }
  });
});

const f = (name: string): FileEntry => ({ name, type: 'file', size: 1, mtime: 0 });
const d = (name: string): FileEntry => ({ name, type: 'dir', size: 0, mtime: 0 });
const link = (name: string, targetType: FileEntry['targetType']): FileEntry => ({ name, type: 'symlink', size: 0, mtime: 0, targetType });

function opts(dirs: Record<string, DirLike>, extra: Partial<FlattenOpts> = {}): FlattenOpts {
  return {
    showHidden: true,
    filter: null,
    editing: null,
    joinPath: (dir, name) => `${dir.replace(/\/$/, '')}/${name}`,
    expanded: new Set(),
    getDir: (p) => dirs[p],
    ...extra,
  };
}
const names = (rows: TreeRow[]) => rows.map((r) => (r.t === 'entry' ? r.entry.name : r.t === 'input' ? `<input ${r.initial ?? 'novo'}>` : `<erro ${r.message}>`));

describe('flattenTree', () => {
  it('lista a raiz na ordem, tudo fechado', () => {
    const rows = flattenTree('/r', [d('a'), f('x'), f('y')], opts({}));
    expect(names(rows)).toEqual(['a', 'x', 'y']);
    expect(rows.every((r) => r.t === 'entry' && r.depth === 0)).toBe(true);
  });

  it('pasta aberta e carregada entra expandida, com a profundidade certa e o caminho completo', () => {
    const dirs = { '/r/a': { items: [d('b'), f('z')], loading: false }, '/r/a/b': { items: [f('fundo')], loading: false } };
    const rows = flattenTree('/r', [d('a'), f('x')], opts(dirs, { expanded: new Set(['/r/a', '/r/a/b']) }));
    expect(names(rows)).toEqual(['a', 'b', 'fundo', 'z', 'x']);
    const fundo = rows[2];
    expect(fundo.t === 'entry' && fundo.depth).toBe(2);
    expect(fundo.t === 'entry' && fundo.full).toBe('/r/a/b/fundo');
  });

  it('pasta aberta ainda sem listagem aparece só como linha (carrega ao entrar na tela)', () => {
    const rows = flattenTree('/r', [d('a')], opts({}, { expanded: new Set(['/r/a']) }));
    expect(rows).toHaveLength(1);
    expect(rows[0].t === 'entry' && rows[0].open).toBe(true);
  });

  it('pasta carregando marca a linha; erro vira uma linha logo abaixo da pasta', () => {
    const dirs = { '/r/a': { loading: true }, '/r/b': { loading: false, error: 'Sem permissão: /r/b' } };
    const rows = flattenTree('/r', [d('a'), d('b'), f('c')], opts(dirs, { expanded: new Set(['/r/a', '/r/b']) }));
    expect(names(rows)).toEqual(['a', 'b', '<erro Sem permissão: /r/b>', 'c']);
    expect(rows[0].t === 'entry' && rows[0].loading).toBe(true);
    expect(rows[2].depth).toBe(0);
  });

  it('esconde os ocultos quando pedido', () => {
    const rows = flattenTree('/r', [f('.env'), d('.git'), f('a')], opts({}, { showHidden: false }));
    expect(names(rows)).toEqual(['a']);
  });

  it('link simbólico para pasta se comporta como pasta', () => {
    const rows = flattenTree('/r', [link('atalho', 'dir'), link('quebrado', 'missing')], opts({ '/r/atalho': { items: [f('dentro')], loading: false } }, { expanded: new Set(['/r/atalho']) }));
    expect(names(rows)).toEqual(['atalho', 'dentro', 'quebrado']);
    expect(rows[0].t === 'entry' && rows[0].folder).toBe(true);
    expect(rows[2].t === 'entry' && rows[2].folder).toBe(false);
  });

  it('filtro: só o que bate, e pastas com resultado abrem sozinhas mesmo sem estar expandidas', () => {
    const dirs = { '/r/src': { items: [f('app.ts'), f('outro.ts')], loading: false } };
    const filter = { files: new Set(['src/app.ts']), dirs: new Set(['src']) };
    const rows = flattenTree('/r', [d('src'), d('docs'), f('README.md')], opts(dirs, { filter }));
    expect(names(rows)).toEqual(['src', 'app.ts']);
  });

  it('novo arquivo: campo no topo da pasta-pai (raiz ou subpasta)', () => {
    const dirs = { '/r/a': { items: [f('z')], loading: false } };
    const root = flattenTree('/r', [d('a'), f('x')], opts(dirs, { expanded: new Set(['/r/a']), editing: { parent: '/r', kind: 'file' } }));
    expect(names(root)).toEqual(['<input novo>', 'a', 'z', 'x']);
    const sub = flattenTree('/r', [d('a'), f('x')], opts(dirs, { expanded: new Set(['/r/a']), editing: { parent: '/r/a', kind: 'folder' } }));
    expect(names(sub)).toEqual(['a', '<input novo>', 'z', 'x']);
    expect(sub[1].depth).toBe(1);
  });

  it('renomear: o campo substitui a linha, no mesmo lugar, com o nome atual', () => {
    const rows = flattenTree('/r', [f('a'), f('b'), f('c')], opts({}, { editing: { parent: '/r', kind: 'rename', path: '/r/b' } }));
    expect(names(rows)).toEqual(['a', '<input b>', 'c']);
  });

  it('renomear uma pasta aberta não mostra o conteúdo dela enquanto o campo está aberto', () => {
    const dirs = { '/r/a': { items: [f('z')], loading: false } };
    const rows = flattenTree('/r', [d('a')], opts(dirs, { expanded: new Set(['/r/a']), editing: { parent: '/r', kind: 'rename', path: '/r/a' } }));
    expect(names(rows)).toEqual(['<input a>']);
  });

  it('chaves são únicas (o Preact reaproveita as linhas pela chave)', () => {
    const dirs = { '/r/a': { items: [f('x')], loading: false } };
    const rows = flattenTree('/r', [d('a'), f('x')], opts(dirs, { expanded: new Set(['/r/a']) }));
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('5000 arquivos: uma linha por arquivo, rápido', () => {
    const items = Array.from({ length: 5000 }, (_, i) => f(`arquivo-${i}.txt`));
    const t0 = performance.now();
    const rows = flattenTree('/r', items, opts({}));
    expect(rows).toHaveLength(5000);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('visibleRange', () => {
  const H = 600;
  it('lista vazia: nada', () => {
    expect(visibleRange(0, H, 0)).toEqual([0, 0]);
  });
  it('lista curta cabe inteira', () => {
    expect(visibleRange(0, H, 10)).toEqual([0, 10]);
  });
  it('no topo de uma lista grande: só o começo (tela + sobra)', () => {
    const [a, b] = visibleRange(0, H, 5000);
    expect(a).toBe(0);
    const visible = Math.ceil(H / ROW_H);
    expect(b).toBeGreaterThanOrEqual(visible + OVERSCAN);
    expect(b).toBeLessThan(visible + OVERSCAN + 8);
  });
  it('rolado: a faixa acompanha e cobre tudo o que está à vista', () => {
    const scrolled = 1000 * ROW_H + 5; // 1000 linhas e meia ficaram acima
    const [a, b] = visibleRange(scrolled, H, 5000);
    expect(a).toBeLessThanOrEqual(1000);
    expect(b).toBeGreaterThanOrEqual(1000 + Math.ceil(H / ROW_H));
    expect(b - a).toBeLessThan(Math.ceil(H / ROW_H) + 2 * OVERSCAN + 12);
  });
  it('no fim da lista não passa do total', () => {
    const [a, b] = visibleRange(4990 * ROW_H, H, 5000);
    expect(b).toBe(5000);
    expect(a).toBeLessThan(5000);
  });
  it('lista que começa abaixo do topo da tela (outra lista acima): só as primeiras linhas que cabem', () => {
    const [a, b] = visibleRange(-300, H, 5000); // começa 300px abaixo do topo: cabem 300px dela
    expect(a).toBe(0);
    expect(b).toBeGreaterThanOrEqual(Math.ceil((H - 300) / ROW_H));
    expect(b).toBeLessThan(Math.ceil((H - 300) / ROW_H) + OVERSCAN + 8);
  });
  it('lista totalmente abaixo da tela: só a sobra mínima', () => {
    const [a, b] = visibleRange(-5000, H, 5000);
    expect(a).toBe(0);
    expect(b).toBeLessThanOrEqual(OVERSCAN + 4);
  });
  it('lista totalmente rolada para fora (acima da tela): faixa vazia ou mínima, nunca fora dos limites', () => {
    const [a, b] = visibleRange(9999 * ROW_H, H, 50);
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(50);
    expect(a).toBeGreaterThanOrEqual(0);
  });
  it('lista que encolheu: a faixa nova nunca passa do total (a tela usa a antiga por um instante)', () => {
    const antiga = visibleRange(0, H, 5000);
    const nova = visibleRange(0, H, 32);
    expect(antiga[1]).toBeGreaterThan(32);
    expect(nova[1]).toBeLessThanOrEqual(32);
  });
  it('a faixa só muda em passos, não a cada linha', () => {
    const seen = new Set<string>();
    for (let px = 0; px < 10 * ROW_H; px += 3) seen.add(visibleRange(px, H, 5000).join('-'));
    expect(seen.size).toBeLessThanOrEqual(4);
  });
});
