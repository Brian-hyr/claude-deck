// Selo da barra de tarefas: o servidor soma as conversas que pedem você (terminaram e não vistas, erro,
// esperando resposta) só das janelas abertas. Aqui confere o número que ele calcularia (`test.badge`);
// o desenho no Windows é testado à parte (test/unit/taskbar.test.ts e a captura da barra de tarefas).
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
const saved = {
  config: process.env.CLAUDE_CONFIG_DIR,
  hooks: process.env.CLAUDE_DECK_TEST_HOOKS,
  delay: process.env.CLAUDE_DECK_UNSEEN_DELAY_MS,
  grace: process.env.CLAUDE_DECK_CLOSE_GRACE_MS,
};
const GRACE_MS = 1200;
let configDir: string;
let cwdA: string;
let cwdB: string;
let env: Awaited<ReturnType<typeof startServer>>;
let widA: string;

const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-badge-claude-'));
  cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-badge-a-'));
  cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-badge-b-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.CLAUDE_DECK_TEST_HOOKS = '1'; // liga `test.badge` (e mantém o selo sem desenhar na barra de tarefas de quem testa)
  process.env.CLAUDE_DECK_UNSEEN_DELAY_MS = '60';
  process.env.CLAUDE_DECK_CLOSE_GRACE_MS = String(GRACE_MS); // folga de "janela fechada" (em produção, 30 s)
  env = await startServer({ settings: { localClaudePath: FAKE, defaultPermissionMode: 'default' } });
  widA = (await env.client.call('window.attach', { wid: crypto.randomUUID(), target: { h: 'local', f: cwdA } })).wid;
});

afterAll(async () => {
  env?.client.close();
  await env?.server.stop();
  restore('CLAUDE_CONFIG_DIR', saved.config);
  restore('CLAUDE_DECK_TEST_HOOKS', saved.hooks);
  restore('CLAUDE_DECK_UNSEEN_DELAY_MS', saved.delay);
  restore('CLAUDE_DECK_CLOSE_GRACE_MS', saved.grace);
  for (const d of [configDir, cwdA, cwdB]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* limpeza de temporário */
    }
  }
});

const badge = (client: WsClient = env.client) => client.call('test.badge');
/** Espera o selo chegar a um valor (os avisos do servidor são assíncronos). */
async function until(pred: (b: any) => boolean, label: string, ms = 10_000) {
  const t0 = Date.now();
  let last: any;
  while (Date.now() - t0 < ms) {
    last = await badge();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`selo não chegou a "${label}" em ${ms} ms; último: ${JSON.stringify(last)}`);
}
const idle = (client: WsClient, sid: string, from: number) =>
  client.waitFor((e) => e.event === 'session.state' && e.data.sid === sid && e.data.phase === 'idle' && client.events.indexOf(e) >= from, 15_000, 'pronto');
const send = (client: WsClient, sid: string, text: string) => client.call('sessions.send', { sid, content: [{ type: 'text', text }], uuid: crypto.randomUUID() });
async function open(client: WsClient, cwd: string) {
  const s = await client.call('sessions.create', { hostId: 'local', cwd });
  await client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');
  return s.sid as string;
}

describe('número do selo da barra de tarefas', () => {
  it('começa em zero, sem cor', async () => {
    expect(await badge()).toMatchObject({ count: 0, kind: null });
  });

  it('turno que terminou e ninguém viu: 1 concluída; abrir a conversa zera', async () => {
    const sid = await open(env.client, cwdA);
    const from = env.client.events.length;
    await send(env.client, sid, 'echo pronto');
    await idle(env.client, sid, from);
    const b = await until((x) => x.count === 1, '1 concluída');
    expect(b).toMatchObject({ kind: 'done', done: 1, waiting: 0, error: 0, description: '1 concluída' });
    await env.client.call('sessions.seen', { sid });
    await until((x) => x.count === 0, 'zero depois de ver');
    await env.client.call('sessions.close', { sid });
  }, 60_000);

  it('esperando permissão: conta e fica âmbar; respondida, deixa de esperar e vira concluída', async () => {
    const sid = await open(env.client, cwdA);
    const from = env.client.events.length;
    await send(env.client, sid, 'write badge.txt');
    const req = await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'control_request' && e.data.msg.request?.subtype === 'can_use_tool' && env.client.events.indexOf(e) >= from, 15_000, 'pedido de permissão');
    const b = await until((x) => x.waiting === 1, '1 esperando');
    expect(b).toMatchObject({ count: 1, kind: 'waiting', description: '1 esperando você' });

    await env.client.call('sessions.respond', { sid, requestId: req.data.msg.request_id, response: { behavior: 'allow', updatedInput: req.data.msg.request.input } });
    await idle(env.client, sid, from);
    // Respondeu: não espera mais; o turno acabou e ninguém viu: concluída (uma conversa conta uma vez só).
    const after = await until((x) => x.waiting === 0 && x.done === 1, 'concluída, sem esperar');
    expect(after).toMatchObject({ count: 1, kind: 'done' });
    await env.client.call('sessions.seen', { sid });
    await until((x) => x.count === 0, 'zero');
    await env.client.call('sessions.close', { sid });
  }, 60_000);

  it('turno que parou com erro (interrompido): conta como erro e fica vermelho', async () => {
    const sid = await open(env.client, cwdA);
    const from = env.client.events.length;
    await send(env.client, sid, 'slow');
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === sid && e.data.phase === 'running' && env.client.events.indexOf(e) >= from, 15_000, 'trabalhando');
    // Trabalhando não conta.
    expect(await badge()).toMatchObject({ count: 0 });
    await env.client.call('sessions.interrupt', { sid });
    await idle(env.client, sid, from);
    const b = await until((x) => x.error === 1, '1 com erro');
    expect(b).toMatchObject({ count: 1, kind: 'error', description: '1 com erro' });
    await env.client.call('sessions.seen', { sid });
    await until((x) => x.count === 0, 'zero');
    await env.client.call('sessions.close', { sid });
  }, 60_000);

  it('pendência manual só conta enquanto a aba está aberta e não duplica um término automático', async () => {
    const sessionId = crypto.randomUUID();
    const session = await env.client.call('sessions.create', { hostId: 'local', cwd: cwdA, resume: sessionId, start: false });
    await env.client.call('pending.set', { hostId: 'local', sessionId, cwd: cwdA, pending: true });
    const marked = await until((x) => x.pending === 1, '1 marcada para depois');
    expect(marked).toMatchObject({ count: 1, kind: 'pending', pending: 1, done: 0, description: '1 marcada para depois' });
    // Mesmo que uma marca automática chegue, a conversa continua uma só no selo.
    env.server.sessions.get(session.sid).state.unseen = 'done';
    expect(await badge()).toMatchObject({ count: 1, pending: 1, done: 0 });
    await env.client.call('sessions.close', { sid: session.sid });
    await until((x) => x.count === 0, 'pendência de aba fechada fora do selo');
    // Fechar a aba não apaga a marca persistida; apenas ela não tem mais onde aparecer na barra.
    expect(await env.client.call('pending.list', { hostId: 'local' })).toEqual([{ hostId: 'local', sessionId, cwd: cwdA }]);
    await env.client.call('pending.set', { hostId: 'local', sessionId, cwd: cwdA, pending: false });
  });

  it('várias conversas somam, e a cor é a do estado mais urgente', async () => {
    const a = await open(env.client, cwdA);
    const b = await open(env.client, cwdA);
    const c = await open(env.client, cwdA);
    const from = env.client.events.length;
    await send(env.client, a, 'echo um');
    await send(env.client, b, 'echo dois');
    await send(env.client, c, 'write soma.txt');
    const req = await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === c && e.data.msg.type === 'control_request' && env.client.events.indexOf(e) >= from, 15_000, 'permissão da 3ª');
    await idle(env.client, a, from);
    await idle(env.client, b, from);
    const sum = await until((x) => x.count === 3, '3 conversas pedindo você');
    expect(sum).toMatchObject({ kind: 'waiting', done: 2, waiting: 1, description: '2 concluídas, 1 esperando você' });
    await env.client.call('sessions.respond', { sid: c, requestId: req.data.msg.request_id, response: { behavior: 'deny', message: 'não' } });
    for (const sid of [a, b, c]) await env.client.call('sessions.seen', { sid });
    await until((x) => x.count === 0, 'zero');
    for (const sid of [a, b, c]) await env.client.call('sessions.close', { sid });
  }, 90_000);

  it('só conta o que tem janela aberta: a conversa de uma janela fechada sai do número', async () => {
    const other = await connectWs(env.server.port, env.cookie);
    const widB = (await other.call('window.attach', { wid: crypto.randomUUID(), target: { h: 'local', f: cwdB } })).wid;
    expect(widB).not.toBe(widA);
    const sidB = await open(other, cwdB);
    const from = other.events.length;
    await send(other, sidB, 'echo na outra janela');
    await idle(other, sidB, from);
    await until((x) => x.count === 1, 'a da outra janela conta');
    // Uma janela desconectada não entra no selo, mesmo durante a folga reservada a reconectar o estado.
    other.close();
    await until((x) => x.count === 0, 'sai do número ao fechar a janela');
    // Reabrir a mesma janela (mesmo id) faz a conversa voltar a contar.
    const back = await connectWs(env.server.port, env.cookie);
    await back.call('window.attach', { wid: widB });
    await until((x) => x.count === 1, 'volta a contar quando a janela volta');
    // Fechar mais uma vez remove imediatamente; o histórico ainda preserva o estado da conversa.
    back.close();
    await until((x) => x.count === 0, 'sai de novo ao fechar');
    const again = await connectWs(env.server.port, env.cookie);
    await again.call('window.attach', { wid: widB });
    await until((x) => x.count === 1, 'volta a contar quando a janela reabre');
    await again.call('sessions.seen', { sid: sidB });
    await until((x) => x.count === 0, 'zero');
    await again.call('sessions.close', { sid: sidB });
    again.close();
  }, 90_000);
});
