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

  it('modo automático: mostra a escolha do gateway e ela sobrevive ao "init" de cada pedido', async () => {
    // O hook do gateway deixa o aviso só no transcript (pasta temporária do CLAUDE_CONFIG_DIR); nada é gravado
    // na pasta pessoal de verdade.
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd, model: 'auto[1m]' });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle', 20_000, 'pronto');
    const send = (text: string) => env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text }], uuid: crypto.randomUUID() });
    const turns = () => env.client.events.filter((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'result').length;

    await send('olá');
    const picked = await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && !!e.data.autoPick, 20_000, 'escolha do gateway');
    // O CLI continua no automático; a escolha fica à parte, casada com o seletor ("Fake Opus" → fake-opus).
    expect(picked.data.model).toBe('auto[1m]');
    expect(picked.data.autoPick).toMatchObject({ model: 'fake-opus', effort: 'medium' });
    expect(picked.data.effort).toBeUndefined(); // nada de --effort imposto à conversa

    // 2º pedido: o CLI repete o "init" com o modelo automático. Antes, isso apagava o que estava no seletor.
    await env.client.waitFor(() => turns() >= 1, 20_000, '1º turno');
    const from = env.client.events.length;
    await send('reinit de novo');
    await env.client.waitFor(() => turns() >= 2, 20_000, '2º turno');
    const reinit = env.client.events.slice(from).filter((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.subtype === 'init');
    expect(reinit.length).toBeGreaterThan(0);
    const after = await stateOf(s.sid);
    expect(after.model).toBe('auto[1m]');
    expect(after.autoPick).toMatchObject({ model: 'fake-opus', effort: 'medium' });

    // Trocou de modelo no seletor: a escolha do gateway deixa de valer.
    await env.client.call('sessions.setModel', { sid: s.sid, model: 'fake-sonnet' });
    const manual = await stateOf(s.sid);
    expect(manual.model).toBe('fake-sonnet');
    expect(manual.autoPick).toBeUndefined();
  });
});
