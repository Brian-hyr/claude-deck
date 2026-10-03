// Leitura do ~/.ssh/config no estilo do OpenSSH (primeiro valor encontrado vence).
// Diferença proposital: uma linha "Host Nome Com Espaços" sem curingas vira UM servidor
// com o nome inteiro — é assim que o VS Code (Remote-SSH) mostra e usa esses aliases.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SshBlock {
  /** Texto original após "Host". */
  raw: string;
  patterns: string[];
  options: Map<string, string[]>; // chave minúscula -> valores (vários p/ IdentityFile)
  line: number;
}

export interface SshEntry {
  alias: string; // nome exibido/usado como id
  block: SshBlock;
}

export interface ResolvedHost {
  alias: string;
  hostName: string;
  user: string;
  port: number;
  identityFiles: string[]; // já expandidos
  identityFilesExplicit: boolean;
  strictHostKeyChecking: 'yes' | 'no' | 'accept-new' | 'ask';
  userKnownHostsFiles: string[];
  proxyJump?: string;
  connectTimeout?: number;
  serverAliveInterval?: number;
  hostKeyAlias?: string;
  options: Record<string, string>;
}

const DEFAULT_KEYS = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_xmss', 'id_dsa'];

/** Divide argumentos respeitando aspas duplas. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of s) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

export function parseSshConfig(text: string): SshBlock[] {
  const blocks: SshBlock[] = [];
  // Opções antes do primeiro Host valem para todos (como "Host *").
  let cur: SshBlock = { raw: '*', patterns: ['*'], options: new Map(), line: 0 };
  let inMatch = false;
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.match(/^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'host') {
      if (cur.options.size || cur.line) blocks.push(cur);
      inMatch = false;
      cur = { raw: value, patterns: splitArgs(value), options: new Map(), line: idx + 1 };
      return;
    }
    if (key === 'match') {
      // Blocos Match não são suportados: as opções dentro deles são ignoradas.
      if (cur.options.size || cur.line) blocks.push(cur);
      inMatch = true;
      cur = { raw: '', patterns: [], options: new Map(), line: idx + 1 };
      return;
    }
    if (inMatch) return;
    const vals = cur.options.get(key) ?? [];
    vals.push(value.replace(/^"(.*)"$/, '$1'));
    cur.options.set(key, vals);
  });
  if (cur.options.size || cur.line) blocks.push(cur);
  return blocks;
}

function globToRegExp(p: string): RegExp {
  const esc = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

export function patternListMatches(patterns: string[], name: string): boolean {
  let matched = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globToRegExp(p.slice(1)).test(name)) return false;
    } else if (globToRegExp(p).test(name)) matched = true;
  }
  return matched;
}

const hasWildcard = (s: string) => /[*?!]/.test(s);

/** Servidores listáveis (sem curingas), na ordem do arquivo, sem duplicatas. */
export function listEntries(blocks: SshBlock[]): SshEntry[] {
  const seen = new Set<string>();
  const out: SshEntry[] = [];
  for (const b of blocks) {
    if (!b.line || !b.patterns.length) continue;
    if (b.patterns.some(hasWildcard)) continue;
    // "Host a b" sem aspas: o VS Code trata como um nome só; mantemos o mesmo comportamento.
    const alias = b.patterns.join(' ');
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ alias, block: b });
  }
  return out;
}

function expandTokens(v: string, ctx: { alias: string; hostName: string; user: string; port: number }): string {
  const home = os.homedir();
  let s = v.replace(/^~(?=$|[\\/])/, home);
  s = s.replace(/%([%dhpruln])/g, (_, t: string) => {
    switch (t) {
      case '%':
        return '%';
      case 'd':
        return home;
      case 'h':
        return ctx.hostName;
      case 'p':
        return String(ctx.port);
      case 'r':
        return ctx.user;
      case 'u':
        return os.userInfo().username;
      case 'n':
        return ctx.alias;
      case 'l':
        return os.hostname();
      default:
        return '';
    }
  });
  return s;
}

export function resolveHost(blocks: SshBlock[], alias: string, sshDir = path.join(os.homedir(), '.ssh')): ResolvedHost {
  const names = [alias, ...splitArgs(alias)];
  const opts = new Map<string, string[]>();
  for (const b of blocks) {
    const applies = b.line === 0 || b.patterns.join(' ').toLowerCase() === alias.toLowerCase() || names.some((n) => patternListMatches(b.patterns, n));
    if (!applies) continue;
    for (const [k, v] of b.options) {
      if (k === 'identityfile') {
        opts.set(k, [...(opts.get(k) ?? []), ...v]);
      } else if (!opts.has(k)) opts.set(k, v);
    }
  }
  const first = (k: string) => opts.get(k)?.[0];
  const hostName = first('hostname') ?? (splitArgs(alias)[0] || alias);
  const user = first('user') ?? os.userInfo().username;
  const port = Number(first('port') ?? 22) || 22;
  const ctx = { alias, hostName, user, port };
  const explicit = opts.has('identityfile');
  const identityFiles = explicit
    ? (opts.get('identityfile') ?? []).map((v) => expandTokens(v, ctx))
    : DEFAULT_KEYS.map((k) => path.join(sshDir, k));
  const shkcRaw = (first('stricthostkeychecking') ?? 'ask').toLowerCase();
  const strict: ResolvedHost['strictHostKeyChecking'] =
    shkcRaw === 'no' || shkcRaw === 'off' ? 'no' : shkcRaw === 'accept-new' ? 'accept-new' : shkcRaw === 'yes' ? 'yes' : 'ask';
  const ukh = first('userknownhostsfile');
  const userKnownHostsFiles = ukh ? splitArgs(ukh).map((v) => expandTokens(v, ctx)) : [path.join(sshDir, 'known_hosts'), path.join(sshDir, 'known_hosts2')];
  const flat: Record<string, string> = {};
  for (const [k, v] of opts) flat[k] = k === 'identityfile' ? v.join(', ') : v[0];
  const pj = first('proxyjump');
  const cto = first('connecttimeout');
  const sai = first('serveraliveinterval');
  return {
    alias,
    hostName,
    user,
    port,
    identityFiles,
    identityFilesExplicit: explicit,
    strictHostKeyChecking: strict,
    userKnownHostsFiles,
    proxyJump: pj && pj.toLowerCase() !== 'none' ? pj : undefined,
    connectTimeout: cto ? Number(cto) : undefined,
    serverAliveInterval: sai ? Number(sai) : undefined,
    hostKeyAlias: first('hostkeyalias'),
    options: flat,
  };
}

export function loadSshConfig(sshDir = path.join(os.homedir(), '.ssh')): SshBlock[] {
  try {
    return parseSshConfig(fs.readFileSync(path.join(sshDir, 'config'), 'utf8'));
  } catch {
    return [];
  }
}

/** Texto de um novo bloco Host para acrescentar ao config. */
export function formatHostBlock(h: { alias: string; hostName: string; user?: string; port?: number; identityFile?: string }): string {
  const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const lines = [`Host ${q(h.alias)}`, `    HostName ${h.hostName}`];
  if (h.user) lines.push(`    User ${h.user}`);
  if (h.port && h.port !== 22) lines.push(`    Port ${h.port}`);
  if (h.identityFile) lines.push(`    IdentityFile ${q(h.identityFile)}`);
  return lines.join('\n') + '\n';
}
