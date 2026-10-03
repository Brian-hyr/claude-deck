// O fluxo de mensagens de uma conversa (`session.msg`) vai só para a janela dona dela; estado e atenção
// continuam indo para todas. Claude falso, dados temporários, servidor real e três clientes WebSocket.
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
let ownerB: WsClient;
let noWindow: WsClient;

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-route-claude-'));
  cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-route-a-'));
  cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-route-b-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  env = await startServer({ settings: { localClaudePath: FAKE } });
  // Cliente A (env.client) = janela da pasta A, dona da conversa. B = janela de outra pasta. O terceiro nem anexou janela.
  await env.client.call('window.attach', { wid: crypto.randomUUID(), target: { h: 'local', f: cwdA } });
  ownerB = await connectWs(env.server.port, env.cookie);
  await ownerB.call('window.attach', { wid: crypto.randomUUID(), target: { h: 'local', f: cwdB } });
  noWindow = await connectWs(env.server.port, env.cookie);
});

afterAll(async () => {
  env?.client.close();
  ownerB?.close();
  noWindow?.close();
  await env?.server.stop();
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfig;
  try {
    for (const d of [configDir, cwdA, cwdB]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* limpeza de temporário */
  }
});

const msgsOf = (c: WsClient, sid: string, from: number) => c.events.slice(from).filter((e) => e.event === 'session.msg' && e.data.sid === sid);

describe('roteamento de session.msg', () => {
  it('a janela dona recebe o fluxo inteiro; outra janela não recebe nada dele, mas recebe estado e atenção', async () => {
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd: cwdA });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');

    const fromA = env.client.events.length;
    const fromB = ownerB.events.length;
    const fromN = noWindow.events.length;
    await env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slow 20' }], uuid: crypto.randomUUID() });
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= fromA, 30_000, 'fim do turno');
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle' && env.client.events.indexOf(e) >= fromA, 10_000, 'pronto');
    await new Promise((r) => setTimeout(r, 300)); // dá tempo de qualquer evento atrasado chegar às outras

    const doDono = msgsOf(env.client, s.sid, fromA);
    expect(doDono.length).toBeGreaterThan(5); // o turno inteiro: stream + resultado
    expect(doDono.some((e) => e.data.msg.type === 'result')).toBe(true);

    // Outra janela (com a própria pasta): zero mensagens da conversa que não é dela...
    expect(msgsOf(ownerB, s.sid, fromB)).toHaveLength(0);
    // ...mas continua sabendo que a conversa existe/mudou de estado (a lista de conversas e o selo dependem disso).
    expect(ownerB.events.slice(fromB).some((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle')).toBe(true);
    expect(ownerB.events.slice(fromB).some((e) => e.event === 'session.attention' && e.data.sid === s.sid)).toBe(true);

    // Cliente que ainda não anexou janela: na dúvida recebe tudo (pode estar carregando uma aba).
    expect(msgsOf(noWindow, s.sid, fromN).length).toBe(doDono.length);
  });

  it('sequência e conteúdo recebidos pelo dono são os mesmos de antes (sem perda)', async () => {
    const s = await env.client.call('sessions.create', { hostId: 'local', cwd: cwdA });
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');
    const fromA = env.client.events.length;
    const fromN = noWindow.events.length;
    await env.client.call('sessions.send', { sid: s.sid, content: [{ type: 'text', text: 'slow 15' }], uuid: crypto.randomUUID() });
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === s.sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= fromA, 30_000, 'fim do turno');
    await new Promise((r) => setTimeout(r, 300));

    // O cliente sem janela recebe tudo, então serve de referência: o dono tem de ter exatamente a mesma sequência.
    const dono = msgsOf(env.client, s.sid, fromA).map((e) => e.data.seq);
    const ref = msgsOf(noWindow, s.sid, fromN).map((e) => e.data.seq);
    expect(dono).toEqual(ref);
    expect(dono.length).toBeGreaterThan(5);
    for (let i = 1; i < dono.length; i++) expect(dono[i]).toBeGreaterThan(dono[i - 1]);
  });
});
