// Sistema de arquivos por servidor: local (Windows) ou remoto via SFTP.
import type { Readable, Writable } from 'node:stream';
import type { FileEntry, Platform, SearchResult } from '../../shared/types';
import type { CopyFs } from './copyfs';

// Um coletor só, reaproveitado. `a.localeCompare(b, 'pt-BR', opções)` cria um coletor novo a CADA comparação:
// listar 5000 arquivos parava o servidor por ~330 ms (30000: 2,4 s) — junto com todas as conversas de todas as
// janelas, que passam por este mesmo processo. Pela especificação (ECMA-402) a ordem é a mesma.
const NAME_COLLATOR = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

/** Ordem da listagem de uma pasta: pastas (e links para pastas) primeiro; depois por nome (sem distinguir caixa/acento, números por valor). */
export function sortEntries(items: FileEntry[]): FileEntry[] {
  return items.sort((a, b) => {
    const da = a.type === 'dir' || a.targetType === 'dir' ? 0 : 1;
    const db = b.type === 'dir' || b.targetType === 'dir' ? 0 : 1;
    return da - db || NAME_COLLATOR.compare(a.name, b.name);
  });
}

export interface SearchOpts {
  caseSensitive: boolean;
  regex: boolean;
  limit: number;
}

export interface StatInfo {
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mtime: number;
}

export interface HostFs {
  readonly platform: Platform;
  /** Adaptador de cópia fixo a uma conexão, independente do rename usado para mover. */
  copyFs(): Promise<CopyFs>;
  list(dir: string): Promise<FileEntry[]>;
  stat(p: string): Promise<StatInfo>;
  exists(p: string): Promise<boolean>;
  /** Lê até maxBytes a partir do início. */
  read(p: string, maxBytes: number): Promise<{ data: Buffer; size: number; mtime: number; truncated: boolean }>;
  /** Lê um trecho [start, start+length). */
  readBytes(p: string, start: number, length: number): Promise<Buffer>;
  /** Fluxo de leitura de [start, end] (end inclusivo), para mídia com Range. */
  createReadStream(p: string, start: number, end: number): Promise<Readable>;
  /** Fluxo de escrita (upload). */
  createWriteStream(p: string): Promise<Writable>;
  write(p: string, data: Buffer, opts?: { expectedMtime?: number; expectedSize?: number; createOnly?: boolean }): Promise<StatInfo>;
  /** Acrescenta ao fim (O_APPEND: seguro mesmo com outro processo escrevendo junto). */
  append(p: string, data: Buffer): Promise<void>;
  mkdir(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(p: string): Promise<void>;
  realpath(p: string): Promise<string>;
  /** Lista arquivos (caminhos relativos) para o "abrir rápido" (Ctrl+P). */
  findFiles(root: string, limit: number): Promise<string[]>;
  /** Busca por conteúdo dentro dos arquivos (texto ou regex), a partir de uma raiz. */
  search(root: string, query: string, opts: SearchOpts): Promise<SearchResult>;
}

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.idea',
  '.vscode-server',
  'target',
  '.turbo',
  'coverage',
]);

export class FsConflictError extends Error {
  code = 'conflict';
  constructor(public currentMtime: number) {
    super('O arquivo foi alterado no disco desde que foi aberto.');
  }
}

/** Heurística de binário: byte nulo ou muitos caracteres de controle no começo. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (!n) return false;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) ctrl++;
  }
  return ctrl / n > 0.1;
}

/** Cria a pasta e os níveis acima que faltam (como `mkdir -p`); se já existir uma pasta ali, não faz nada. */
export async function mkdirp(fsx: HostFs, p: string): Promise<void> {
  const win = fsx.platform === 'win32';
  const sep = win ? '\\' : '/';
  const clean = p.replace(win ? /[\\/]+$/ : /\/+$/, '');
  if (!clean) return;
  const missing: string[] = [];
  let cur = clean;
  for (let guard = 0; guard < 200; guard++) {
    let st: StatInfo | null = null;
    try {
      st = await fsx.stat(cur);
    } catch {
      st = null;
    }
    if (st) {
      if (st.type !== 'dir') throw Object.assign(new Error(`Já existe um arquivo com o nome ${cur}.`), { code: 'exists' });
      break;
    }
    missing.push(cur);
    const i = cur.lastIndexOf(sep);
    // Chegou na raiz (/, C:\ ou \\servidor): não dá para criar mais acima.
    if (i <= 0) break;
    const parent = cur.slice(0, i);
    // "C:" sozinho é a pasta atual da unidade; a raiz é "C:\".
    cur = win && /^[A-Za-z]:$/.test(parent) ? parent + sep : parent;
  }
  for (const d of missing.reverse()) {
    try {
      await fsx.mkdir(d);
    } catch (e) {
      // Outra requisição pode ter criado a mesma pasta no meio do caminho.
      let ok = false;
      try {
        ok = (await fsx.stat(d)).type === 'dir';
      } catch {
        ok = false;
      }
      if (!ok) throw e;
    }
  }
}

/** Aspas simples seguras para shell POSIX. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ------------------------------------------------------------------ busca por conteúdo

/** Arquivo maior que isso não é lido para busca (evita travar em binários grandes/logs). */
export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
/** No máximo essas ocorrências por arquivo (arquivo gerado com 1 padrão repetido não afoga o resto). */
export const MAX_MATCHES_PER_FILE = 20;
/** Teto de arquivos varridos na busca local, além do limite de profundidade/pastas ignoradas. */
export const MAX_SEARCH_FILES_SCANNED = 20000;

/** Constrói a expressão regular da busca: literal (texto escapado) ou regex do usuário. */
export function toSearchRegex(query: string, caseSensitive: boolean, useRegex: boolean): RegExp {
  const src = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(src, caseSensitive ? 'g' : 'gi');
}

/** Recorta uma linha longa ao redor do trecho encontrado, mantendo os índices de destaque válidos. */
export function buildSnippet(line: string, matchStart: number, matchLen: number): { text: string; hlStart: number; hlLen: number } {
  const MAX = 300;
  if (line.length <= MAX) return { text: line, hlStart: matchStart, hlLen: matchLen };
  const pad = 80;
  let start = Math.max(0, matchStart - pad);
  let end = Math.min(line.length, matchStart + matchLen + pad);
  // Sobrou espaço até MAX? Estica dos dois lados (extra decresce sempre: termina em no máx. MAX passos).
  let extra = MAX - (end - start);
  while (extra > 0 && (start > 0 || end < line.length)) {
    if (start > 0) {
      start--;
      extra--;
    }
    if (extra > 0 && end < line.length) {
      end++;
      extra--;
    }
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  return { text: prefix + line.slice(start, end) + suffix, hlStart: matchStart - start + prefix.length, hlLen: matchLen };
}
