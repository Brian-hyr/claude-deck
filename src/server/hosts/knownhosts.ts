// Verificação da chave do servidor contra o known_hosts (mesmo arquivo do OpenSSH).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export interface KnownKey {
  type: string;
  blob: Buffer;
  file: string;
  line: number;
  revoked: boolean;
}

function globToRegExp(p: string): RegExp {
  const esc = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** Nome como o OpenSSH grava: "host" na porta 22, "[host]:porta" nas demais. */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function hostFieldMatches(field: string, name: string): boolean {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    const h = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
    return h === hash;
  }
  let matched = false;
  for (const p of field.split(',')) {
    if (!p) continue;
    if (p.startsWith('!')) {
      if (globToRegExp(p.slice(1)).test(name)) return false;
    } else if (globToRegExp(p).test(name)) matched = true;
  }
  return matched;
}

export function lookupKnownKeys(files: string[], host: string, port: number): KnownKey[] {
  const name = knownHostsName(host, port);
  const out: KnownKey[] = [];
  for (const file of files) {
    if (!file || /^(\/dev\/null|nul)$/i.test(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const parts = line.split(/\s+/);
      let marker = '';
      if (parts[0].startsWith('@')) marker = parts.shift()!;
      if (marker === '@cert-authority') return; // certificados não suportados
      const [hosts, type, b64] = parts;
      if (!hosts || !type || !b64) return;
      if (!hostFieldMatches(hosts, name)) return;
      try {
        out.push({ type, blob: Buffer.from(b64, 'base64'), file, line: i + 1, revoked: marker === '@revoked' });
      } catch {
        /* linha inválida */
      }
    });
  }
  return out;
}

/** Tipo da chave a partir do blob SSH (string com tamanho no começo). */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'desconhecido';
  const len = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + len).toString('ascii');
}

export function fingerprintSha256(blob: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

export type HostKeyVerdict =
  | { kind: 'ok' }
  | { kind: 'unknown' } // nenhuma chave registrada para este servidor
  | { kind: 'mismatch'; expected: KnownKey[] } // chave diferente da registrada (possível ataque)
  | { kind: 'revoked' };

export function verifyHostKey(known: KnownKey[], blob: Buffer): HostKeyVerdict {
  if (known.some((k) => k.revoked && k.blob.equals(blob))) return { kind: 'revoked' };
  const valid = known.filter((k) => !k.revoked);
  if (valid.some((k) => k.blob.equals(blob))) return { kind: 'ok' };
  if (!valid.length) return { kind: 'unknown' };
  const type = keyTypeOf(blob);
  const sameType = valid.filter((k) => k.type === type);
  // Chave de outro tipo que ainda não conhecemos: o OpenSSH trata como nova, não como troca.
  if (!sameType.length) return { kind: 'unknown' };
  return { kind: 'mismatch', expected: sameType };
}

/**
 * Como o OpenSSH ("checking without port identifier"): numa porta diferente de 22 sem nenhuma
 * entrada "[host]:porta" do tipo da chave, aceita se a MESMA chave estiver registrada para o host
 * sem porta. Uma chave diferente sem porta não conta como troca: segue como desconhecida.
 */
export function verifyWithPortFallback(known: KnownKey[], bare: KnownKey[], blob: Buffer): HostKeyVerdict {
  const v = verifyHostKey(known, blob);
  if (v.kind !== 'unknown' || !bare.length) return v;
  return verifyHostKey(bare, blob).kind === 'ok' ? { kind: 'ok' } : v;
}

/** Acrescenta a chave ao known_hosts (como o OpenSSH faz ao aceitar). */
export function addKnownHost(file: string, host: string, port: number, blob: Buffer) {
  const type = keyTypeOf(blob);
  const line = `${knownHostsName(host, port)} ${type} ${blob.toString('base64')}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = '';
  try {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur.length && !cur.endsWith('\n')) prefix = '\n';
  } catch {
    /* arquivo novo */
  }
  fs.appendFileSync(file, prefix + line, 'utf8');
}

const RSA_ALGOS = ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'];
const DEFAULT_HOSTKEY_ALGOS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
];

/**
 * Ordem de algoritmos de chave do servidor: primeiro os tipos que já estão no known_hosts
 * (evita o servidor apresentar uma chave de outro tipo e parecer "desconhecido").
 */
export function preferredHostKeyAlgorithms(known: KnownKey[]): string[] {
  const pref: string[] = [];
  for (const k of known) {
    if (k.revoked) continue;
    const algos = k.type === 'ssh-rsa' ? RSA_ALGOS : [k.type];
    for (const a of algos) if (DEFAULT_HOSTKEY_ALGOS.includes(a) && !pref.includes(a)) pref.push(a);
  }
  return [...pref, ...DEFAULT_HOSTKEY_ALGOS.filter((a) => !pref.includes(a))];
}
