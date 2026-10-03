// Mapa de agentes: parar uma tarefa pelo id certo e ler o transcript do filho só na conversa dona.
// Claude falso e CLAUDE_CONFIG_DIR temporário — sem usar nenhuma conversa real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectWs, startServer, type WsClient } from './helpers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = path.join(ROOT, 'test', 'fake-claude', 'fake-claude.mjs');
const oldConfig = process.env.CLAUDE_CONFIG_DIR;
let config: string;
let cwd: string;
let env: Awaited<ReturnType<typeof startServer>>;
let other: WsClient;
let sid: string;
let ids: string[];

beforeAll(async () => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agent-map-cfg-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agent-map-cwd-'));
  process.env.CLAUDE_CONFIG_DIR = config;
  env = await startServer({ settings: { localClaudePath: FAKE } });
  await env.client.call('window.attach', { wid: crypto.randomUUID(), target: { h: 'local', f: cwd } });
  other = await connectWs(env.server.port, env.cookie);
  await other.call('window.attach', { wid: crypto.randomUUID(), target: { h: 'local', f: os.tmpdir() } });
  const s = await env.client.call('sessions.create', { hostId: 'local', cwd });
  sid = s.sid;
  await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === sid && e.data.phase === 'idle');
  const from = env.client.events.length;
  await env.client.call('sessions.send', { sid, content: [{ type: 'text', text: 'bgagent 2' }], uuid: crypto.randomUUID() });
  await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= from);
  ids = env.client.events.filter((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'user' && e.data.msg.tool_use_result?.agentId && env.client.events.indexOf(e) >= from)
    .map((e) => e.data.msg.tool_use_result.agentId);
});

afterAll(async () => {
  if (sid) await env?.client.call('sessions.close', { sid }).catch(() => {});
  other?.close();
  env?.client.close();
  await env?.server.stop();
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = oldConfig;
  for (const p of [config, cwd]) if (p) {
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch { /* processo no Windows ainda liberando a pasta temporária */ }
  }
});

describe('mapa de agentes', () => {
  it('transcrito do agente do próprio CLI é paginado, reduzido e não inclui a conversa mãe', async () => {
    expect(ids).toEqual(['agent1', 'agent2']);
    const page = await env.client.call('history.agent', { sid, agentId: ids[0] });
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0].message.content[0].text).toContain('Transcrito do agente agent1');
    expect(page.lines[0].message.content[0].text).not.toContain('bgagent 2');
    expect((await env.client.call('history.agent', { sid, agentId: ids[0], before: page.start })).lines).toHaveLength(0);
  });
  it('não permite ids que escapam da pasta, nem outra janela lendo ou parando o agente', async () => {
    for (const agentId of ['../settings', 'agent1/../../../x', '']) {
      const e = await env.client.call('history.agent', { sid, agentId }).catch((err) => err);
      expect(e.code).toBe('bad');
    }
    for (const taskId of ['../settings', 'x/../../x', '', 42]) {
      const e = await env.client.call('sessions.stopTask', { sid, taskId }).catch((err) => err);
      expect(e.code).toBe('bad');
    }
    const r = await other.call('history.agent', { sid, agentId: ids[0] }).catch((err) => err);
    expect(r.code).toBe('otherwindow');
    const stop = await other.call('sessions.stopTask', { sid, taskId: ids[0] }).catch((err) => err);
    expect(stop.code).toBe('otherwindow');
  });
  it('para um só agente, sem interromper o turno nem o outro', async () => {
    const from = env.client.events.length;
    await env.client.call('sessions.stopTask', { sid, taskId: ids[0] });
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.subtype === 'task_updated' && e.data.msg.task_id === ids[0] && env.client.events.indexOf(e) >= from);
    const err = await env.client.call('sessions.stopTask', { sid, taskId: ids[0] }).catch((e) => e);
    expect(err.code).toBe('control');
    expect((await env.client.call('sessions.list')).find((s: any) => s.sid === sid).phase).toBe('idle');
    const later = env.client.events.length;
    await env.client.call('sessions.send', { sid, content: [{ type: 'text', text: 'agentdone' }], uuid: crypto.randomUUID() });
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= later);
    const done = env.client.events.filter((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'user' && JSON.stringify(e.data.msg).includes('<task-notification>') && env.client.events.indexOf(e) >= later);
    expect(done).toHaveLength(1);
    expect(JSON.stringify(done[0].data.msg)).toContain(ids[1]);
  });
});
