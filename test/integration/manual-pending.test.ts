// Pendências manuais: independentes de turnos não vistos, persistidas por servidor + sessão (a pasta é só metadado).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from '../../src/server/config';
import { encodeProjectDir } from '../../src/shared/paths';
import { startServer, type WsClient } from './helpers';

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
let configDir: string;
let cwd: string;
let env: Awaited<ReturnType<typeof startServer>>;
let targetSessionId: string;
let visibleSessionId: string;

function transcript(sessionId: string, title: string, old = false) {
  const dir = path.join(configDir, 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'user', sessionId, cwd, message: { role: 'user', content: title } }) + '\n',
    'utf8',
  );
  if (old) fs.utimesSync(file, new Date(1_000), new Date(1_000));
}

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pending-claude-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pending-workspace-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  targetSessionId = crypto.randomUUID();
  visibleSessionId = crypto.randomUUID();
  // Esta pendência fica além do corte normal de 200 entradas da pasta.
  transcript(targetSessionId, 'pendência antiga fora da primeira página', true);
  for (let i = 0; i < 200; i++) transcript(crypto.randomUUID(), `conversa recente ${i}`);
  transcript(visibleSessionId, 'conversa que já está no histórico');
  env = await startServer();
});

afterAll(async () => {
  env?.client.close();
  await env?.server.stop();
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  for (const dir of [configDir, cwd]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* limpeza de temporário */
    }
  }
});

async function expectPendingChanged(client: WsClient, sessionId: string, pending: boolean) {
  return client.waitFor(
    (event) =>
      event.event === 'pending.changed' &&
      event.data.hostId === 'local' &&
      event.data.sessionId === sessionId &&
      event.data.cwd === cwd &&
      event.data.pending === pending,
    10_000,
    'evento de pendência',
  );
}

describe('pendências manuais de conversa', () => {
  it('anuncia a capacidade e rejeita entradas inválidas ou de outro host', async () => {
    expect((await env.client.call('app.info')).manualPending).toBe(true);
    await expect(env.client.call('pending.list', { hostId: 'servidor-inventado' })).rejects.toMatchObject({ code: 'nohost' });
    await expect(env.client.call('pending.set', { hostId: 'local', sessionId: 'não-é-uuid', cwd, pending: true })).rejects.toMatchObject({ code: 'bad' });
    await expect(env.client.call('pending.set', { hostId: 'servidor-inventado', sessionId: crypto.randomUUID(), cwd, pending: true })).rejects.toMatchObject({ code: 'nohost' });
  });

  it('persiste por chave composta, é idempotente e sobrepõe histórico já cacheado', async () => {
    const before = await env.client.call('history.list', { h: 'local', cwd });
    expect(before.find((summary: any) => summary.sessionId === visibleSessionId)).not.toHaveProperty('manualPending');

    const change = expectPendingChanged(env.client, visibleSessionId, true);
    await expect(env.client.call('pending.set', { hostId: 'local', sessionId: visibleSessionId, cwd, pending: true })).resolves.toBe(true);
    await change;
    const eventsBeforeRepeat = env.client.events.filter((event) => event.event === 'pending.changed').length;
    await expect(env.client.call('pending.set', { hostId: 'local', sessionId: visibleSessionId, cwd, pending: true })).resolves.toBe(true);
    expect(env.client.events.filter((event) => event.event === 'pending.changed')).toHaveLength(eventsBeforeRepeat);

    expect(await env.client.call('pending.list', { hostId: 'local' })).toEqual([{ hostId: 'local', sessionId: visibleSessionId, cwd }]);
    const after = await env.client.call('history.list', { h: 'local', cwd });
    expect(after.find((summary: any) => summary.sessionId === visibleSessionId)).toMatchObject({ manualPending: true });
    const dir = path.join(configDir, 'projects', encodeProjectDir(cwd));
    const fromDir = await env.client.call('history.listDir', { h: 'local', dir });
    expect(fromDir.find((summary: any) => summary.sessionId === visibleSessionId)).toMatchObject({ manualPending: true });

    // `flush` simula o processo fechar sem apagar hosts.json; a Store seguinte enxerga a mesma marca.
    env.server.store.flush();
    const restored = new Store(env.server.store.paths);
    expect(restored.listManualPending('local')).toEqual([{ hostId: 'local', sessionId: visibleSessionId, cwd }]);
  });

  it('localiza a pendência marcada fora do limite de 200, sem abrir uma aba', async () => {
    const change = expectPendingChanged(env.client, targetSessionId, true);
    await env.client.call('pending.set', { hostId: 'local', sessionId: targetSessionId, cwd, pending: true });
    await change;

    const regular = await env.client.call('history.list', { h: 'local', cwd });
    expect(regular).toHaveLength(200);
    expect(regular.some((summary: any) => summary.sessionId === targetSessionId)).toBe(false);

    const marked = await env.client.call('history.pending', { hostId: 'local' });
    expect(marked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: targetSessionId, cwd, manualPending: true }),
        expect.objectContaining({ sessionId: visibleSessionId, cwd, manualPending: true }),
      ]),
    );
  });

  it('remove apenas a chave exata e transmite a alteração uma vez', async () => {
    const change = expectPendingChanged(env.client, visibleSessionId, false);
    await expect(env.client.call('pending.set', { hostId: 'local', sessionId: visibleSessionId, cwd, pending: false })).resolves.toBe(true);
    await change;
    expect(await env.client.call('pending.list', { hostId: 'local' })).toEqual([{ hostId: 'local', sessionId: targetSessionId, cwd }]);
    const eventsBeforeRepeat = env.client.events.filter((event) => event.event === 'pending.changed').length;
    await env.client.call('pending.set', { hostId: 'local', sessionId: visibleSessionId, cwd, pending: false });
    expect(env.client.events.filter((event) => event.event === 'pending.changed')).toHaveLength(eventsBeforeRepeat);
  });
});
