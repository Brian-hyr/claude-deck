import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { addKnownHost, knownHostsName, lookupKnownKeys, preferredHostKeyAlgorithms, verifyHostKey, verifyWithPortFallback, keyTypeOf, fingerprintSha256 } from '../../src/server/hosts/knownhosts';

function fakeKey(type: string, seed: string): Buffer {
  const t = Buffer.from(type);
  const body = crypto.createHash('sha256').update(seed).digest();
  const len = Buffer.alloc(4);
  len.writeUInt32BE(t.length);
  return Buffer.concat([len, t, body]);
}

describe('known_hosts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-kh-'));
  const file = path.join(dir, 'known_hosts');
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ed = fakeKey('ssh-ed25519', 'a');
  const ed2 = fakeKey('ssh-ed25519', 'b');
  const rsa = fakeKey('ssh-rsa', 'c');
  // Entrada com hash (|1|sal|hash) para 198.51.100.9
  const salt = crypto.randomBytes(20);
  const hash = crypto.createHmac('sha1', salt).update('198.51.100.9').digest('base64');
  fs.writeFileSync(
    file,
    [
      `server1,198.51.100.1 ssh-ed25519 ${ed.toString('base64')}`,
      `[198.51.100.2]:2222 ssh-rsa ${rsa.toString('base64')}`,
      `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${ed2.toString('base64')}`,
      `@revoked 198.51.100.3 ssh-ed25519 ${ed.toString('base64')}`,
      `*.example.com ssh-ed25519 ${ed.toString('base64')}`,
    ].join('\n') + '\n',
  );

  it('nome com porta segue o formato do OpenSSH', () => {
    expect(knownHostsName('h', 22)).toBe('h');
    expect(knownHostsName('h', 2222)).toBe('[h]:2222');
  });

  it('acha por nome, IP, porta, hash e curinga', () => {
    expect(lookupKnownKeys([file], 'server1', 22)).toHaveLength(1);
    expect(lookupKnownKeys([file], '198.51.100.1', 22)).toHaveLength(1);
    expect(lookupKnownKeys([file], '198.51.100.2', 2222)).toHaveLength(1);
    expect(lookupKnownKeys([file], '198.51.100.2', 22)).toHaveLength(0);
    expect(lookupKnownKeys([file], '198.51.100.9', 22)).toHaveLength(1);
    expect(lookupKnownKeys([file], 'x.example.com', 22)).toHaveLength(1);
  });

  it('verifica: ok, desconhecido, trocado e revogado', () => {
    expect(verifyHostKey(lookupKnownKeys([file], 'server1', 22), ed).kind).toBe('ok');
    expect(verifyHostKey(lookupKnownKeys([file], 'server1', 22), ed2).kind).toBe('mismatch');
    expect(verifyHostKey(lookupKnownKeys([file], 'novo', 22), ed).kind).toBe('unknown');
    // chave de outro tipo que ainda não conhecemos: é "nova", não "trocada"
    expect(verifyHostKey(lookupKnownKeys([file], 'server1', 22), rsa).kind).toBe('unknown');
    expect(verifyHostKey(lookupKnownKeys([file], '198.51.100.3', 22), ed).kind).toBe('revoked');
  });

  it('porta diferente de 22 cai para a entrada sem porta (como o OpenSSH), só com a MESMA chave', () => {
    const withPort = lookupKnownKeys([file], 'server1', 2200);
    const bare = lookupKnownKeys([file], 'server1', 22);
    expect(withPort).toHaveLength(0);
    expect(verifyWithPortFallback(withPort, bare, ed).kind).toBe('ok');
    // Chave diferente registrada sem porta: não é troca (outra porta pode ser outro serviço) — segue desconhecida.
    expect(verifyWithPortFallback(withPort, bare, ed2).kind).toBe('unknown');
    // Entrada com porta existe e diverge: continua sendo troca, mesmo que a sem porta confira.
    const rsaPort = lookupKnownKeys([file], '198.51.100.2', 2222);
    expect(verifyWithPortFallback(rsaPort, [], fakeKey('ssh-rsa', 'outra')).kind).toBe('mismatch');
  });

  it('prioriza os algoritmos já conhecidos', () => {
    const algos = preferredHostKeyAlgorithms(lookupKnownKeys([file], '198.51.100.2', 2222));
    expect(algos.slice(0, 3)).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
  });

  it('grava uma chave nova no formato certo', () => {
    const k = fakeKey('ecdsa-sha2-nistp256', 'z');
    addKnownHost(file, 'novo', 2200, k);
    const found = lookupKnownKeys([file], 'novo', 2200);
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe('ecdsa-sha2-nistp256');
    expect(keyTypeOf(k)).toBe('ecdsa-sha2-nistp256');
    expect(fingerprintSha256(k)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });
});
