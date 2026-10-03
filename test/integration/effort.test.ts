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

  it('rejeita nível inválido e não reinicia um turno em andamento', async () => {
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');
    await expect(env.client.call('sessions.setEffort', { sid: s.sid, effort: 'ultra-unsafe' })).rejects.toMatchObject({ code: 'bad' });
    const offset = env.client.events.length;
    await env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slow 20' }], uuid: crypto.randomUUID() });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'running' && env.client.events.indexOf(e) >= offset);
    await expect(env.client.call('sessions.setEffort', { sid: s.sid, effort: 'low' })).rejects.toMatchObject({ code: 'busy' });
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= offset);
    expect((await env.client.call('sessions.list')).find((x: any) => x.sid === s.sid).effort).toBeUndefined();
    await env.client.call('sessions.close', { sid: s.sid });
  }, 60_000);
});
