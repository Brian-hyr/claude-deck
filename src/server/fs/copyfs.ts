// Contrato de cópia separado do mover/upload: handles fixos e publicação sem arquivo parcial.
import type { Readable, Writable } from 'node:stream';
import type { Platform } from '../../shared/types';
import type { StatInfo } from './hostfs';
import { DeckError } from '../../shared/protocol';
import { dirname, isAbsolute, normalize } from '../../shared/paths';

export interface CopyStat extends StatInfo {
  mode?: number;
  identity?: string;
}
export interface CopySource {
  stream: Readable;
  stat(): Promise<CopyStat>;
  close(): Promise<void>;
}
export interface CopyStage {
  path: string;
  stream: Writable;
  finish(mode?: number): Promise<void>;
  publish(replace: boolean): Promise<void>;
  discard(): Promise<void>;
}
export interface CopyFs {
  platform: Platform;
  lstat(p: string): Promise<CopyStat>;
  entries(p: string): AsyncIterable<string>;
  realpath(p: string): Promise<string>;
  mkdir(p: string): Promise<void>;
  source(p: string): Promise<CopySource>;
  stage(p: string): Promise<CopyStage>;
}

export function copyPath(platform: Platform, value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 32768 || /[\x00-\x1f]/.test(value) || !isAbsolute(platform, value))
    throw new DeckError('bad', 'Caminho absoluto inválido para copiar/colar.');
  if (platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(value) && !/^\\\\[^\\/]+[\\/][^\\/]+/.test(value)))
    throw new DeckError('bad', 'Caminho Windows inválido.');
  return normalize(platform, value);
}

export function copyName(platform: Platform, name: string): string {
  if (!name || name === '.' || name === '..' || /[\x00-\x1f/]/.test(name)) throw new DeckError('bad', `Nome inválido: ${name}`);
  if (platform === 'win32' && (/[\\<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)))
    throw new DeckError('bad', `O Windows não aceita este nome: ${name}`);
  return name;
}

export async function maybeStat(fs: CopyFs, p: string): Promise<CopyStat | null> {
  try { return await fs.lstat(p); }
  catch (e: any) {
    if (e?.code === 'ENOENT' || e?.code === 'notfound' || e?.code === 2) return null;
    throw e;
  }
}

/** Cada ancestral existente tem que ser diretório real (não link/junction). */
export async function checkParents(fs: CopyFs, p: string) {
  let cur = dirname(fs.platform, p);
  for (let i = 0; i < 256; i++) {
    const st = await fs.lstat(cur);
    if (st.type !== 'dir') throw new DeckError('bad', `O caminho passa por link ou item que não é pasta: ${cur}`);
    if (fs.platform === 'win32' && /^\\\\[^\\]+\\[^\\]+\\?$/.test(cur)) return;
    const parent = dirname(fs.platform, cur);
    if (parent === cur) return;
    cur = parent;
  }
  throw new DeckError('bad', 'Caminho profundo demais.');
}

export function sameCopyStat(a: CopyStat | null, b: CopyStat | null): boolean {
  return a === null || b === null ? a === b : a.type === b.type && a.size === b.size && a.mtime === b.mtime && a.identity === b.identity;
}
