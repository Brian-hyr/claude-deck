// Nível de esforço real no protocolo do Deck, com Claude falso e dados locais temporários.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer, type WsClient } from './helpers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = path.join(ROOT, 'test', 'fake-claude', 'fake-claude.mjs');
const originalConfig = process.env.CLAUDE_CONFIG_DIR;
let configDir: string;
let cwd: string;
let env: Awaited<ReturnType<typeof startServer>>;
let wid: string;

async function turn(client: WsClient, sid: string, text: string) {
  const start = client.events.length;
  await client.call('sessions.send', { sid, content: [{ type: 'text', text }], uuid: crypto.randomUUID() });
  await client.waitFor((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'result' && client.events.indexOf(e) >= start, 30_000, `resultado de ${text}`);
  return client.events.slice(start).filter((e) => e.event === 'session.msg' && e.data.sid === sid).map((e) => e.data.msg);
}

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-effort-claude-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-effort-cwd-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  env = await startServer({ settings: { localClaudePath: FAKE } });
  wid = (await env.client.call('window.attach', { wid: `w-${crypto.randomUUID()}` })).wid;
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

describe('esforço por conversa', () => {
  it('troca o esforço, retoma o mesmo transcript e não altera outra aba', async () => {
    const one = await env.client.call('sessions.create', { hostId: 'local', cwd });
    const two = await env.client.call('sessions.create', { hostId: 'local', cwd });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === one.sid && e.data.phase === 'idle');
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === two.sid && e.data.phase === 'idle');
    const initial = await turn(env.client, one.sid, 'effort');
    expect(initial.some((m) => m.type === 'assistant' && m.message?.content?.some((b: any) => b.text?.includes('esforço=default')))).toBe(true);
    const oldSessionId = (await env.client.call('sessions.list')).find((s: any) => s.sid === one.sid).sessionId;
    await env.client.call('sessions.setEffort', { sid: one.sid, effort: 'high' });
    const states = await env.client.call('sessions.list');
    expect(states.find((s: any) => s.sid === one.sid)).toMatchObject({ effort: 'high', sessionId: oldSessionId, wid });
    expect(states.find((s: any) => s.sid === two.sid).effort).toBeUndefined();
    const changed = await turn(env.client, one.sid, 'effort');
    expect(changed.some((m) => m.type === 'assistant' && m.message?.content?.some((b: any) => b.text?.includes(`esforço=high sessão=${oldSessionId}`)))).toBe(true);
    const other = await turn(env.client, two.sid, 'effort');
    expect(other.some((m) => m.type === 'assistant' && m.message?.content?.some((b: any) => b.text?.includes('esforço=default')))).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'sessions.json'), 'utf8'));
    expect(saved.find((s: any) => s.sid === one.sid).effort).toBe('high');
    expect(saved.find((s: any) => s.sid === two.sid).effort).toBeUndefined();
    await env.client.call('sessions.setEffort', { sid: one.sid, effort: null });
    const reset = await turn(env.client, one.sid, 'effort');
    expect(reset.some((m) => m.type === 'assistant' && m.message?.content?.some((b: any) => b.text?.includes(`esforço=default sessão=${oldSessionId}`)))).toBe(true);
    await env.client.call('sessions.close', { sid: one.sid });
    await env.client.call('sessions.close', { sid: two.sid });
  }, 90_000);

  it('rejeita nível inválido', async () => {
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');
    await expect(env.client.call('sessions.setEffort', { sid: s.sid, effort: 'ultra-unsafe' })).rejects.toMatchObject({ code: 'bad' });
    expect((await env.client.call('sessions.list')).find((x: any) => x.sid === s.sid).effort).toBeUndefined();
    await env.client.call('sessions.close', { sid: s.sid });
  }, 30_000);

  it('troca o esforço no meio de uma tarefa: vale na próxima ação, sem reiniciar nem interromper', async () => {
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');
    await turn(env.client, s.sid, 'echo oi'); // o sessionId só existe depois da primeira conversa
    const sessionId = (await env.client.call('sessions.list')).find((x: any) => x.sid === s.sid).sessionId;
    expect(sessionId).toBeTruthy();
    const offset = env.client.events.length;
    await env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slowfx 30' }], uuid: crypto.randomUUID() });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'running' && env.client.events.indexOf(e) >= offset);
    await env.client.call('sessions.setEffort', { sid: s.sid, effort: 'low' });
    const during = (await env.client.call('sessions.list')).find((x: any) => x.sid === s.sid);
    expect(during).toMatchObject({ effort: 'low', phase: 'running', sessionId });
    const result = await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= offset, 20_000, 'fim da tarefa');
    expect(result.data.msg.is_error).toBeFalsy();
    const text = env.client.events.slice(offset).filter((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'assistant').map((e) => JSON.stringify(e.data.msg)).join('\n');
    expect(text).toContain('esforço-na-próxima-ação=low');
    // Voltar ao padrão também vale no meio da tarefa, e o processo segue o mesmo.
    const second = env.client.events.length;
    await env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slowfx 30' }], uuid: crypto.randomUUID() });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'running' && env.client.events.indexOf(e) >= second);
    await env.client.call('sessions.setEffort', { sid: s.sid, effort: null });
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= second, 20_000, 'fim da segunda tarefa');
    expect(JSON.stringify(env.client.events.slice(second).filter((e) => e.event === 'session.msg').map((e) => e.data.msg))).toContain('esforço-na-próxima-ação=default');
    expect((await env.client.call('sessions.list')).find((x: any) => x.sid === s.sid)).toMatchObject({ sessionId });
    expect((await env.client.call('sessions.list')).find((x: any) => x.sid === s.sid).effort).toBeUndefined();
    await env.client.call('sessions.close', { sid: s.sid });
  }, 60_000);

  describe('Claude Code antigo, sem apply_flag_settings', () => {
    beforeAll(() => { process.env.FAKE_NO_FLAG_SETTINGS = '1'; });
    afterAll(() => { delete process.env.FAKE_NO_FLAG_SETTINGS; });

    it('entre tarefas reinicia com --effort (como antes); no meio da tarefa explica e não reinicia', async () => {
      const s = await env.client.call('sessions.create', { hostId: 'local', cwd });
      await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');
      await turn(env.client, s.sid, 'echo oi'); // o sessionId só existe depois da primeira conversa
      const sessionId = (await env.client.call('sessions.list')).find((x: any) => x.sid === s.sid).sessionId;
      expect(sessionId).toBeTruthy();
      await env.client.call('sessions.setEffort', { sid: s.sid, effort: 'high' });
      const changed = await turn(env.client, s.sid, 'effort');
      expect(changed.some((m) => m.type === 'assistant' && m.message?.content?.some((b: any) => b.text?.includes(`esforço=high sessão=${sessionId}`)))).toBe(true);
      const offset = env.client.events.length;
      await env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slow 20' }], uuid: crypto.randomUUID() });
      await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'running' && env.client.events.indexOf(e) >= offset);
      await expect(env.client.call('sessions.setEffort', { sid: s.sid, effort: 'low' })).rejects.toMatchObject({ code: 'busy', message: expect.stringMatching(/antigo/) });
      await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= offset);
      expect((await env.client.call('sessions.list')).find((x: any) => x.sid === s.sid).effort).toBe('high');
      await env.client.call('sessions.close', { sid: s.sid });
    }, 60_000);
  });
});
