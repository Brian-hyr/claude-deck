// RPC real, duas janelas autenticadas, dados temporários. Nenhuma conversa Claude é iniciada.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, connectWs, httpGet, type WsClient } from './helpers';

let env: Awaited<ReturnType<typeof startServer>>, root: string, source: WsClient, dest: WsClient;
let sourceWid: string, destWid: string;
const p = (...parts: string[]) => path.join(root, ...parts);
const finals = new Set(['completed', 'partial', 'failed', 'cancelled', 'uncertain']);
function ack(c: WsClient) {
  c.ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (m.event === 'fileCopy.reserve') void c.call('fileCopy.ack', { id: m.data.id, clean: true }).catch(() => {});
  });
}
async function copy(from: string, dir: string) {
  const clipboard = await source.call('fileClipboard.set', { hostId: 'local', path: from });
  return dest.call('fileCopy.start', { requestId: crypto.randomUUID(), clipboardId: clipboard.id, revision: clipboard.revision, hostId: 'local', dir });
}
async function wait(id: string, decision = false) {
  for (let i = 0; i < 500; i++) {
    const j = await dest.call('fileCopy.get', { id });
    if (finals.has(j.state) || decision && j.state === 'awaitingDecision') return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('cópia não terminou');
}
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-copy-it-'));
  await fs.mkdir(p('src')); await fs.mkdir(p('dst'));
  env = await startServer(); source = env.client; dest = await connectWs(env.server.port, env.cookie);
  sourceWid = (await source.call('window.attach', { wid: `w-${crypto.randomUUID()}`, target: { h: 'local', f: p('src') } })).wid;
  destWid = (await dest.call('window.attach', { wid: `w-${crypto.randomUUID()}`, target: { h: 'local', f: p('dst') } })).wid;
  ack(source); ack(dest);
});
afterAll(async () => {
  source?.close(); dest?.close(); await env?.server.stop();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('copiar/colar por RPC entre janelas', () => {
  it('capability e clipboard compartilhado; conteúdo binário íntegro e origem intacta', async () => {
    expect((await source.call('app.info')).fileCopy).toBe(1);
    const bytes = crypto.randomBytes(2 * 1024 * 1024);
    await fs.mkdir(p('src', 'árvore', 'vazia'), { recursive: true });
    await fs.writeFile(p('src', 'árvore', 'binário.bin'), bytes);
    await fs.writeFile(p('src', 'árvore', '.oculto'), 'h');
    const clipboard = await source.call('fileClipboard.set', { hostId: 'local', path: p('src', 'árvore') });
    expect((await dest.call('fileClipboard.get')).id).toBe(clipboard.id);
    const args = { requestId: crypto.randomUUID(), clipboardId: clipboard.id, revision: clipboard.revision, hostId: 'local', dir: p('dst') };
    const job = await dest.call('fileCopy.start', args);
    expect((await dest.call('fileCopy.start', args)).id).toBe(job.id);
    const result = await wait(job.id);
    expect(result.state).toBe('completed'); expect(result.copied).toBe(2);
    expect(await fs.readFile(p('dst', 'árvore', 'binário.bin'))).toEqual(bytes);
    expect(await fs.readFile(p('src', 'árvore', 'binário.bin'))).toEqual(bytes);
    expect(await fs.readdir(p('dst', 'árvore', 'vazia'))).toEqual([]);
    expect(source.events.some((m) => m.event === 'fs.changed')).toBe(true);
  });
  it('autorização não aceita host alheio, janela sem attach, job alheio ou travessia relativa', async () => {
    await expect(source.call('fileClipboard.set', { hostId: 'unknown', path: p('src') })).rejects.toMatchObject({ code: 'nohost' });
    await expect(source.call('fileClipboard.set', { hostId: 'local', path: '../src' })).rejects.toMatchObject({ code: 'bad' });
    const other = await connectWs(env.server.port, env.cookie);
    try { await expect(other.call('fileCopy.list')).rejects.toMatchObject({ code: 'otherwindow' }); }
    finally { other.close(); }
    const outsider = await connectWs(env.server.port, env.cookie);
    try {
      await outsider.call('window.attach', { wid: `w-${crypto.randomUUID()}`, target: { h: 'local', f: root } });
      const id = (await dest.call('fileCopy.list'))[0].id;
      await expect(outsider.call('fileCopy.get', { id })).rejects.toMatchObject({ code: 'notfound' });
    } finally { outsider.close(); }
  });
  it('dirty em outra janela bloqueia substituição, sem mudar conteúdo salvo ou rascunho', async () => {
    await fs.writeFile(p('src', 'dirty.txt'), 'novo'); await fs.writeFile(p('dst', 'dirty.txt'), 'velho');
    await source.call('fileCopy.edits', { revision: 1, files: [{ hostId: 'local', path: p('dst', 'dirty.txt'), dirty: true }] });
    const j = await wait((await copy(p('src', 'dirty.txt'), p('dst'))).id, true);
    await dest.call('fileCopy.resolve', { id: j.id, revision: j.revision, decision: 'replace' });
    const result = await wait(j.id);
    expect(result.state).toBe('partial'); expect(result.copied).toBe(0);
    expect(result.issues[0].message).toMatch(/não salvas/);
    expect(await fs.readFile(p('dst', 'dirty.txt'), 'utf8')).toBe('velho');
    await source.call('fileCopy.edits', { revision: 2, files: [] });
  });
  it('decisão pendente impede app.quit e entra no gate busy; cancelar libera', async () => {
    await fs.writeFile(p('src', 'gate.txt'), 'novo'); await fs.writeFile(p('dst', 'gate.txt'), 'velho');
    const j = await wait((await copy(p('src', 'gate.txt'), p('dst'))).id, true);
    const health = JSON.parse((await httpGet(`${env.base}/health`)).body.toString());
    expect(health.transfersBusy).toBe(1); expect(health.busy).toBeGreaterThanOrEqual(1);
    await expect(dest.call('app.quit')).rejects.toMatchObject({ code: 'busy' });
    await dest.call('fileCopy.cancel', { id: j.id }); expect((await wait(j.id)).state).toBe('cancelled');
    expect(JSON.parse((await httpGet(`${env.base}/health`)).body.toString()).transfersBusy).toBe(0);
  });
  it('reconexão recupera job e clipboard, não cria uma cópia extra', async () => {
    const before = await dest.call('fileCopy.list');
    const c = await dest.call('fileClipboard.get');
    dest.close(); await new Promise((r) => setTimeout(r, 30));
    dest = await connectWs(env.server.port, env.cookie); ack(dest);
    await dest.call('window.attach', { wid: destWid });
    expect((await dest.call('fileCopy.list')).map((j: any) => j.id)).toEqual(before.map((j: any) => j.id));
    expect((await dest.call('fileClipboard.get')).id).toBe(c.id);
    expect((await source.call('fileCopy.list')).length).toBe(before.length);
    expect(sourceWid).not.toBe(destWid);
  });
});
