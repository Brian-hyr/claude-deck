// Uma conversa do CLI nunca fica em duas abas: retomar a que já está aberta devolve a mesma aba
// (nesta janela) ou recusa com "alreadyopen" (aberta em outra janela, a interface vai até ela).
// Claude falso, dados e pastas temporários.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectWs, startServer, type WsClient } from './helpers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = path.join(ROOT, 'test', 'fake-claude', 'fake-claude.mjs');
const originalConfig = process.env.CLAUDE_CONFIG_DIR;
let configDir: string;
let cwdA: string;
let cwdB: string;
let env: Awaited<ReturnType<typeof startServer>>;
let other: WsClient;
let widA: string;
let widB: string;

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-onetab-claude-'));
  cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-onetab-a-'));
  cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-onetab-b-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  env = await startServer({ settings: { localClaudePath: FAKE } });
  widA = (await env.client.call('window.attach', { wid: crypto.randomUUID(), target: { h: 'local', f: cwdA } })).wid;
  other = await connectWs(env.server.port, env.cookie);
  widB = (await other.call('window.attach', { wid: crypto.randomUUID(), target: { h: 'local', f: cwdB } })).wid;
  expect(widB).not.toBe(widA);
});

afterAll(async () => {
  other?.close();
  env?.client.close();
  await env?.server.stop();
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfig;
  for (const d of [configDir, cwdA, cwdB]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* limpeza de temporário */
    }
  }
});

const sameConversation = async (sessionId: string) => (await env.client.call('sessions.list')).filter((s: any) => s.sessionId === sessionId);

describe('uma aba por conversa', () => {
  it('retomar de novo na mesma janela devolve a aba que já existe (também com cliques simultâneos)', async () => {
    const sessionId = crypto.randomUUID();
    const first = await env.client.call('sessions.create', { hostId: 'local', cwd: cwdA, resume: sessionId, start: false });
    expect(first.wid).toBe(widA);
    const again = await env.client.call('sessions.create', { hostId: 'local', cwd: cwdA, resume: sessionId, start: false });
    expect(again.sid).toBe(first.sid);
    // Duplo clique: os dois pedidos chegam juntos.
    const both = await Promise.all([1, 2].map(() => env.client.call('sessions.create', { hostId: 'local', cwd: cwdA, resume: sessionId, start: false })));
    expect(both.map((s: any) => s.sid)).toEqual([first.sid, first.sid]);
    expect(await sameConversation(sessionId)).toHaveLength(1);
    await env.client.call('sessions.close', { sid: first.sid });
  });

  it('aberta em outra janela: recusa com "alreadyopen" e não cria a segunda aba', async () => {
    const sessionId = crypto.randomUUID();
    const mine = await env.client.call('sessions.create', { hostId: 'local', cwd: cwdA, resume: sessionId, start: false });
    // Pela pasta da conversa ou pela pasta da outra janela: nos dois casos, recusado.
    for (const cwd of [cwdA, cwdB]) {
      const err = await other.call('sessions.create', { hostId: 'local', cwd, resume: sessionId, start: false }).then(
        () => null,
        (e: any) => e,
      );
      expect(err?.code).toBe('alreadyopen');
    }
    const list = await sameConversation(sessionId);
    expect(list).toHaveLength(1);
    expect(list[0].wid).toBe(widA);
    await env.client.call('sessions.close', { sid: mine.sid });
  });

  it('ao reabrir durante um fechamento demorado, espera o processo antigo parar; dois cliques criam só uma aba', async () => {
    const sessionId = crypto.randomUUID();
    const a = await env.client.call('sessions.create', { hostId: 'local', cwd: cwdA, resume: sessionId, start: false });
    const session = (env.server as any).sessions.get(a.sid);
    const originalClose = session.close.bind(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    session.close = async () => {
      session.closing = true;
      await gate;
      await originalClose();
    };
    const closing = env.client.call('sessions.close', { sid: a.sid });
    const deadline = Date.now() + 3000;
    while (!session.isClosing && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(session.isClosing).toBe(true);
    let returned = false;
    const opens = Promise.all([1, 2].map(() => env.client.call('sessions.create', { hostId: 'local', cwd: cwdA, resume: sessionId, start: false })))
      .then((v) => { returned = true; return v; });
    await new Promise((r) => setTimeout(r, 100));
    expect(returned).toBe(false);
    expect(await sameConversation(sessionId)).toHaveLength(1);
    release();
    await closing;
    const [b, c] = await opens;
    expect(b.sid).not.toBe(a.sid);
    expect(c.sid).toBe(b.sid);
    expect(await sameConversation(sessionId)).toHaveLength(1);
    await env.client.call('sessions.close', { sid: b.sid });
  });

  it('depois de fechar a aba, retomar abre de novo; conversa nova (sem retomar) nunca é barrada', async () => {
    const sessionId = crypto.randomUUID();
    const a = await env.client.call('sessions.create', { hostId: 'local', cwd: cwdA, resume: sessionId, start: false });
    await env.client.call('sessions.close', { sid: a.sid });
    const b = await other.call('sessions.create', { hostId: 'local', cwd: cwdB, resume: sessionId, start: false });
    expect(b.sid).not.toBe(a.sid);
    expect(b.wid).toBe(widB);
    const n1 = await env.client.call('sessions.create', { hostId: 'local', cwd: cwdA, start: false });
    const n2 = await env.client.call('sessions.create', { hostId: 'local', cwd: cwdA, start: false });
    expect(n1.sid).not.toBe(n2.sid);
    for (const s of [b, n1, n2]) await env.client.call('sessions.close', { sid: s.sid });
  });
});
