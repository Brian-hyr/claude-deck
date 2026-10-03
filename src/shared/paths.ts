// Utilitários de caminho que funcionam para Windows (local) e POSIX (servidores).
import type { Platform } from './types';

export function sepOf(platform: Platform): string {
  return platform === 'win32' ? '\\' : '/';
}

export function normalize(platform: Platform, p: string): string {
  if (platform === 'win32') {
    let s = p.replace(/\//g, '\\');
    // C: -> C:\
    if (/^[A-Za-z]:$/.test(s)) s += '\\';
    const drive = /^[A-Za-z]:\\/.test(s) ? s.slice(0, 3) : s.startsWith('\\\\') ? '\\\\' : '';
    const rest = s.slice(drive.length).split('\\');
    const out: string[] = [];
    for (const part of rest) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return (drive || '') + out.join('\\');
  }
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}

export function join(platform: Platform, base: string, ...parts: string[]): string {
  const sep = sepOf(platform);
  let s = base;
  for (const p of parts) {
    if (!p) continue;
    if (isAbsolute(platform, p)) s = p;
    else s = s.endsWith(sep) || (platform === 'posix' && s.endsWith('/')) ? s + p : s + sep + p;
  }
  return normalize(platform, s);
}

export function isAbsolute(platform: Platform, p: string): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') : p.startsWith('/');
}

export function dirname(platform: Platform, p: string): string {
  const n = normalize(platform, p);
  const sep = sepOf(platform);
  const i = n.lastIndexOf(sep);
  if (platform === 'win32') {
    if (/^[A-Za-z]:\\?$/.test(n)) return n.slice(0, 2) + '\\';
    if (i <= 2) return n.slice(0, 3);
    return n.slice(0, i);
  }
  if (i <= 0) return '/';
  return n.slice(0, i);
}

export function basename(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

/** Caminho relativo de `p` dentro de `root` (ou null se estiver fora). */
export function relativeTo(platform: Platform, root: string, p: string): string | null {
  const r = normalize(platform, root);
  const n = normalize(platform, p);
  const sep = sepOf(platform);
  const cmp = (a: string) => (platform === 'win32' ? a.toLowerCase() : a);
  if (cmp(n) === cmp(r)) return '';
  const prefix = r.endsWith(sep) ? r : r + sep;
  if (cmp(n).startsWith(cmp(prefix))) return n.slice(prefix.length);
  return null;
}

/**
 * Por que `from` não pode ser movido para dentro de `destDir`: `'here'` (já está nessa pasta) ou
 * `'inside'` (uma pasta não vai para dentro de si mesma). `null` = pode.
 */
export function moveBlocked(platform: Platform, from: string, fromIsDir: boolean, destDir: string): 'here' | 'inside' | null {
  if (relativeTo(platform, dirname(platform, from), destDir) === '') return 'here';
  if (fromIsDir && relativeTo(platform, from, destDir) !== null) return 'inside';
  return null;
}

/**
 * Nome da pasta de projeto do Claude Code para um cwd:
 * todo caractere que não é letra/número vira '-'. Caminhos muito longos
 * ganham um sufixo de hash no CLI; nesses casos o servidor procura pelo id da sessão.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Exibe o caminho encurtando a pasta pessoal para ~. */
export function tildify(p: string, home?: string): string {
  if (!home) return p;
  if (p === home) return '~';
  const sep = p.includes('\\') ? '\\' : '/';
  if (p.startsWith(home + sep)) return '~' + p.slice(home.length);
  return p;
}
