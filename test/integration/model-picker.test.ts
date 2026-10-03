// Troca de modelo no seletor (sessions.setModel): o breadcrumb ecoado pelo CLI
// não deve marcar a conversa como "trabalhando" nem entrar no chat como mensagem do usuário.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = path.join(ROOT, 'test', 'fake-claude', 'fake-claude.mjs');
const originalConfig = process.env.CLAUDE_CONFIG_DIR;
let configDir: string;
let cwd: string;
let env: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-model-claude-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-model-cwd-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  env = await startServer({ settings: { localClaudePath: FAKE } });
  await env.client.call('window.attach', { wid: `w-${crypto.randomUUID()}` });
});

afterAll(async () => {
  env?.client.close();
  await env?.server.stop();
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfig;
  try {
    fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
});

const stateOf = async (sid: string) => (await env.client.call('sessions.list')).find((s: any) => s.sid === sid);

describe('seletor de modelo (sessions.setModel)', () => {
  it('troca o modelo sem entrar em fase running e descarta o breadcrumb do CLI', async () => {
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');

    const from = env.client.events.length;
    // Troca para claude-3-5-sonnet
    await env.client.call('sessions.setModel', { sid: s.sid, model: 'claude-3-5-sonnet' });

    // O estado deve atualizar o modelo para claude-3-5-sonnet
    const updated = await stateOf(s.sid);
    expect(updated.model).toBe('claude-3-5-sonnet');
    expect(updated.phase).toBe('idle');

    // Nenhuma mensagem user (breadcrumb) deve ter sido emitida para a interface
    const newEvents = env.client.events.slice(from);
    const userMsgs = newEvents.filter((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'user');
    expect(userMsgs).toHaveLength(0);

    // E nenhum evento de estado deve ter mudado a fase para 'running'
    const runningEvents = newEvents.filter((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'running');
    expect(runningEvents).toHaveLength(0);

    // Troca de volta para padrão (null)
    await env.client.call('sessions.setModel', { sid: s.sid, model: null });
    const reset = await stateOf(s.sid);
    expect(reset.model).toBeUndefined();
    expect(reset.phase).toBe('idle');
  });
});
