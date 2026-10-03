// Relógio do turno ("Trabalhando há X"): o servidor guarda quando o turno começou, para a contagem
// sobreviver a recarregar a janela e não recomeçar do zero. Claude falso, dados temporários.
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
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-clock-claude-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-clock-cwd-'));
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
  } catch {
    /* limpeza de temporário */
  }
});

const stateOf = async (sid: string) => (await env.client.call('sessions.list')).find((s: any) => s.sid === sid);

describe('relógio do turno', () => {
  it('nasce ao começar, fica estável durante o turno, é gravado em disco e some no fim; o turno seguinte tem outro', async () => {
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');
    expect((await stateOf(s.sid)).turnStartedAt).toBeUndefined();

    const before = Date.now();
    const from = env.client.events.length;
    await env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slow 40' }], uuid: crypto.randomUUID() });
    const running = await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'running' && env.client.events.indexOf(e) >= from, 15_000, 'trabalhando');
    const t0 = running.data.turnStartedAt as number;
    expect(typeof t0).toBe('number');
    expect(t0).toBeGreaterThanOrEqual(before - 50);
    expect(t0).toBeLessThanOrEqual(Date.now() + 50);

    // Várias atualizações de estado durante o turno: o horário de início nunca muda.
    await new Promise((r) => setTimeout(r, 1500));
    const during = env.client.events.filter((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'running' && env.client.events.indexOf(e) >= from);
    expect(during.length).toBeGreaterThan(0);
    expect(new Set(during.map((e) => e.data.turnStartedAt)).size).toBe(1);
    expect((await stateOf(s.sid)).turnStartedAt).toBe(t0);

    // Gravado em disco durante o turno (é o que faz a contagem sobreviver a reiniciar o app).
    await new Promise((r) => setTimeout(r, 800));
    const saved = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'sessions.json'), 'utf8'));
    expect(saved.find((x: any) => x.sid === s.sid).turnStartedAt).toBe(t0);

    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= from, 30_000, 'fim do turno');
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle' && env.client.events.indexOf(e) >= from, 10_000, 'pronto');
    expect((await stateOf(s.sid)).turnStartedAt).toBeUndefined();
    await new Promise((r) => setTimeout(r, 800));
    const savedAfter = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'sessions.json'), 'utf8'));
    expect(savedAfter.find((x: any) => x.sid === s.sid).turnStartedAt).toBeUndefined();

    // Outro turno: relógio novo, e depois do primeiro.
    await new Promise((r) => setTimeout(r, 50));
    const from2 = env.client.events.length;
    await env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slow 20' }], uuid: crypto.randomUUID() });
    const again = await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'running' && env.client.events.indexOf(e) >= from2, 15_000, 'trabalhando de novo');
    expect(again.data.turnStartedAt).toBeGreaterThan(t0);
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= from2, 30_000, 'fim do segundo turno');
    await env.client.call('sessions.close', { sid: s.sid });
  }, 90_000);

  it('eco da mensagem do usuário sem `timestamp` (CLI antigo) chega com a hora do envio, também no snapshot', async () => {
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');
    const uuid = crypto.randomUUID();
    const from = env.client.events.length;
    const before = Date.now();
    await env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slow 20' }], uuid });
    const after = Date.now();
    const echo = await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'user' && e.data.msg.uuid === uuid && env.client.events.indexOf(e) >= from, 15_000, 'eco');
    const t = Date.parse(echo.data.msg.timestamp);
    expect(t).toBeGreaterThanOrEqual(before - 5);
    expect(t).toBeLessThanOrEqual(after + 5);
    // Outra janela / recarregar no meio do turno: o buffer de reidratação tem a mesma hora.
    const snap = await env.client.call('sessions.snapshot', { sid: s.sid });
    const inSnap = snap.messages.find((m: any) => m.msg.type === 'user' && m.msg.uuid === uuid);
    expect(inSnap?.msg.timestamp).toBe(echo.data.msg.timestamp);
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= from, 30_000, 'fim do turno');
    await env.client.call('sessions.close', { sid: s.sid });
  }, 60_000);

  it('parar logo depois de enviar, com o Claude ainda iniciando, não deixa a mensagem rodar depois', async () => {
    // Conversa retomada/adormecida: a mensagem espera o processo subir. Parar nesse instante tem que valer.
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd, start: false });
    const from = env.client.events.length;
    const sending = env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slow' }], uuid: crypto.randomUUID() }).catch(() => null);
    await env.client.call('sessions.interrupt', { sid: s.sid });
    await sending;
    const t0 = Date.now();
    await env.client.waitFor(
      (e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle' && env.client.events.indexOf(e) >= from,
      15_000,
      'pronto depois de parar',
    );
    // Tempo para a mensagem "fantasma" começar a rodar, se escapasse (slow = 60 s de texto).
    await new Promise((r) => setTimeout(r, 1500));
    expect(Date.now() - t0).toBeLessThan(10_000);
    const st = (await env.client.call('sessions.list')).find((x: any) => x.sid === s.sid);
    expect(st.phase).toBe('idle');
    const late = env.client.events.filter((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'stream_event' && env.client.events.indexOf(e) >= from);
    // Ou nunca chegou ao Claude, ou chegou e foi interrompida: nada de 60 s de texto.
    expect(late.length).toBeLessThan(40);
    await env.client.call('sessions.close', { sid: s.sid });
  }, 60_000);

  it('interromper também apaga o relógio', async () => {
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');
    const from = env.client.events.length;
    await env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slow' }], uuid: crypto.randomUUID() });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'running' && env.client.events.indexOf(e) >= from, 15_000, 'trabalhando');
    expect((await stateOf(s.sid)).turnStartedAt).toBeGreaterThan(0);
    await env.client.call('sessions.interrupt', { sid: s.sid });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle' && env.client.events.indexOf(e) >= from, 15_000, 'pronto depois de interromper');
    expect((await stateOf(s.sid)).turnStartedAt).toBeUndefined();
    await env.client.call('sessions.close', { sid: s.sid });
  }, 60_000);
});
