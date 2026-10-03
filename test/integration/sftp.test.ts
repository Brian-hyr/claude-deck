// SFTP contra o servidor de teste: latência, vazão (TCP_NODELAY + janela deslizante), conteúdo
// conferido por SHA-256, leitura de trechos (Range de vídeo) e cancelamento no meio.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, resolvePaths } from '../../src/server/config';
import { PromptBroker } from '../../src/server/prompts';
import { HostRegistry } from '../../src/server/hosts/registry';
import { TEST_HOST } from './helpers';

describe.skipIf(!TEST_HOST)('sftp', () => {
  it('mede e confere conteúdo', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-probe-'));
    const store = new Store(resolvePaths(dataDir));
    const registry = new HostRegistry(store, new PromptBroker(), () => {});
    let t = Date.now();
    await registry.connect(TEST_HOST);
    const log = (s: string) => process.stderr.write(`[sonda] ${s}\n`);
    log(`conectar + ler HOME + achar o Claude: ${Date.now() - t} ms`);
    const h = registry.get(TEST_HOST);
    const ssh = h.ssh!;
    const f = '/tmp/deck-sftp-probe.bin';
    const SIZE = 16 * 1048576 + 12345; // tamanho "torto" para testar o fim
    await ssh.run(`head -c ${SIZE} /dev/urandom > ${f}`);
    const remoteSha = (await ssh.run(`sha256sum ${f}`)).stdout.split(' ')[0];
    t = Date.now();
    for (let i = 0; i < 10; i++) await h.fs.stat(f);
    log(`stat: ${((Date.now() - t) / 10).toFixed(1)} ms cada`);
    t = Date.now();
    await h.fs.list('/usr/bin');
    log(`listar /usr/bin: ${Date.now() - t} ms`);
    t = Date.now();
    const b = await h.fs.readBytes(f, 0, SIZE);
    log(`readBytes (janela deslizante): ${(b.length / 1048576 / ((Date.now() - t) / 1000)).toFixed(1)} MB/s`);
    expect(crypto.createHash('sha256').update(b).digest('hex')).toBe(remoteSha);
    t = Date.now();
    const st = await h.fs.createReadStream(f, 0, SIZE - 1);
    const parts: Buffer[] = [];
    for await (const c of st) parts.push(c as Buffer);
    const all = Buffer.concat(parts);
    log(`stream (mídia): ${(all.length / 1048576 / ((Date.now() - t) / 1000)).toFixed(1)} MB/s`);
    expect(all.length).toBe(SIZE);
    expect(crypto.createHash('sha256').update(all).digest('hex')).toBe(remoteSha);
    // Trecho do meio (como um Range de vídeo) e trecho que passa do fim.
    const mid = await h.fs.createReadStream(f, 5_000_000, 5_000_999);
    const mparts: Buffer[] = [];
    for await (const c of mid) mparts.push(c as Buffer);
    expect(Buffer.concat(mparts).equals(b.subarray(5_000_000, 5_001_000))).toBe(true);
    const tail = await h.fs.readBytes(f, SIZE - 100, 1000);
    expect(tail.length).toBe(100);
    // Cancelar no meio não pode travar nem vazar.
    const cancel = await h.fs.createReadStream(f, 0, SIZE - 1);
    await new Promise<void>((res) => {
      cancel.once('data', () => {
        cancel.destroy();
        res();
      });
    });
    await h.fs.stat(f);
    await ssh.run(`rm -f ${f}`);
    registry.closeAll();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 180_000);
});
