// Árvore do explorador achatada em linhas de altura fixa + cálculo da janela visível.
// Lógica pura (sem DOM, sem signals): é o que permite montar só as linhas que aparecem na tela, em vez
// de uma por arquivo — uma pasta com milhares de arquivos virava dezenas de milhares de nós e travava o PC.
import type { FileEntry, Platform } from '../../shared/types';
import { join, sepOf } from '../../shared/paths';

/** Altura de uma linha da árvore, em px. Tem que ser igual a `.tree-row { height }` em styles.css. */
export const ROW_H = 22;
/** Linhas extras montadas acima e abaixo do que está à vista (rolagem rápida não mostra espaço vazio). */
export const OVERSCAN = 12;
/** A janela só muda de 4 em 4 linhas: menos renderizações enquanto rola. */
const QUANTUM = 4;

export interface TreeEdit {
  parent: string;
  kind: 'file' | 'folder' | 'rename';
  path?: string;
}

/** Resultado do filtro ao vivo (caminhos relativos à raiz). */
export interface TreeFilter {
  files: Set<string>;
  dirs: Set<string>;
}

export interface DirLike {
  items?: FileEntry[];
  loading: boolean;
  error?: string;
}

export type TreeRow =
  | { t: 'entry'; key: string; depth: number; dir: string; full: string; entry: FileEntry; folder: boolean; open: boolean; loading: boolean }
  /** Campo de nome: arquivo/pasta novos (`initial` ausente) ou renomear. */
  | { t: 'input'; key: string; depth: number; parent: string; initial?: string }
  | { t: 'error'; key: string; depth: number; message: string };

export interface FlattenOpts {
  showHidden: boolean;
  filter: TreeFilter | null;
  editing: TreeEdit | null;
  joinPath: (dir: string, name: string) => string;
  expanded: ReadonlySet<string>;
  getDir: (full: string) => DirLike | undefined;
}

export function isDirEntry(e: FileEntry): boolean {
  return e.type === 'dir' || (e.type === 'symlink' && e.targetType === 'dir');
}

/**
 * Mesmo resultado de `join(plat, dir, name)` para o nome de um item listado (nunca tem separador),
 * mas normaliza a pasta uma vez só em vez de uma vez por arquivo.
 */
export function makeJoin(plat: Platform): (dir: string, name: string) => string {
  const sep = sepOf(plat);
  const bases = new Map<string, string>();
  return (dir, name) => {
    let b = bases.get(dir);
    if (b === undefined) {
      b = join(plat, dir);
      if (!b.endsWith(sep)) b += sep;
      bases.set(dir, b);
    }
    return b + name;
  };
}

/**
 * Linhas visíveis da árvore da raiz `root`, na ordem em que aparecem (pastas abertas já expandidas).
 * Mesmas regras de antes da virtualização: ocultos, filtro (pastas com resultado abrem sozinhas),
 * campo de novo item no topo da pasta-pai, renomear no lugar da linha, erro da pasta aberta.
 */
export function flattenTree(root: string, items: FileEntry[], o: FlattenOpts): TreeRow[] {
  const out: TreeRow[] = [];
  const ed = o.editing;
  const walk = (dir: string, rel: string, depth: number, list: FileEntry[]) => {
    if (ed && ed.parent === dir && ed.kind !== 'rename') out.push({ t: 'input', key: `new:${dir}`, depth, parent: dir });
    for (const e of list) {
      if (!o.showHidden && e.name.startsWith('.')) continue;
      const folder = isDirEntry(e);
      // O caminho relativo só serve ao filtro: sem filtro, nada de montar uma string por arquivo.
      const entryRel = o.filter ? (rel ? `${rel}/${e.name}` : e.name) : '';
      if (o.filter && !(folder ? o.filter.dirs.has(entryRel) : o.filter.files.has(entryRel))) continue;
      const full = o.joinPath(dir, e.name);
      if (ed && ed.kind === 'rename' && ed.path === full) {
        out.push({ t: 'input', key: `ren:${full}`, depth, parent: dir, initial: e.name });
        continue;
      }
      // Enquanto filtra, pastas que levam a algum arquivo encontrado ficam abertas (sem mexer no estado salvo).
      const open = folder && (o.expanded.has(full) || (!!o.filter && o.filter.dirs.has(entryRel)));
      const child = open ? o.getDir(full) : undefined;
      out.push({ t: 'entry', key: full, depth, dir, full, entry: e, folder, open, loading: !!child?.loading });
      if (!open) continue;
      // `depth` do erro = o da pasta (o recuo extra do texto é do estilo da linha de erro).
      if (child?.error) out.push({ t: 'error', key: `err:${full}`, depth, message: child.error });
      if (child?.items) walk(full, entryRel, depth + 1, child.items);
    }
  };
  walk(root, '', 0, items);
  return out;
}

/**
 * Faixa de linhas [primeira, última) a montar.
 * `offset` = quanto a lista já passou do topo da área visível (px; negativo = a lista começa abaixo do topo);
 * `viewport` = altura da área visível.
 */
export function visibleRange(offset: number, viewport: number, count: number, rowH = ROW_H, overscan = OVERSCAN): [number, number] {
  if (count <= 0) return [0, 0];
  const top = Math.max(0, offset);
  const bottom = Math.max(0, offset + viewport);
  let first = Math.floor(top / rowH) - overscan;
  let last = Math.ceil(bottom / rowH) + overscan;
  first = Math.floor(Math.max(0, first) / QUANTUM) * QUANTUM;
  last = Math.ceil(last / QUANTUM) * QUANTUM;
  first = Math.min(first, count);
  last = Math.min(Math.max(last, first), count);
  return [first, last];
}
