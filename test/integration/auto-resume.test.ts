// Retomada automática: o processo do Claude é morto à força (código 137) no meio de uma tarefa e o Deck manda
// sozinho uma mensagem curta ("continue") para ele seguir. Claude falso, dados temporários, servidor real.
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
const originalDelay = process.env.CLAUDE_DECK_AUTORESUME_DELAY_MS;
let configDir: string;
let cwd: string;
let env: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-resume-claude-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-resume-cwd-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.env.CLAUDE_DECK_AUTORESUME_DELAY_MS = '150';
  env = await startServer({ settings: { localClaudePath: FAKE } });
  await env.client.call('window.attach', { wid: `w-${crypto.randomUUID()}` });
});

afterAll(async () => {
  env?.client.close();
  await env?.server.stop();
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfig;
  if (originalDelay === undefined) delete process.env.CLAUDE_DECK_AUTORESUME_DELAY_MS;
  else process.env.CLAUDE_DECK_AUTORESUME_DELAY_MS = originalDelay;
  try {
    fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* limpeza de temporário */
  }
});

// A 1ª mensagem de cada conversa leva um aviso de modo (<system-reminder>) colado no texto: fora da comparação.
const textOf = (e: { data: any }) =>
  (e.data.msg?.message?.content ?? [])
    .map((b: any) => b.text ?? '')
    .join('')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\n?/g, '')
    .trim();
const userEchoes = (sid: string, from: number) =>
  env.client.events.slice(from).filter((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'user' && e.data.msg.isReplay);
const deckEvents = (sid: string, name: string, from: number) =>
  env.client.events.slice(from).filter((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'deck_event' && e.data.msg.event === name);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newSession() {
  const s = await env.client.call('sessions.create', { hostId: 'local', cwd });
  await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === s.sid && e.data.phase === 'idle');
  return s.sid as string;
}

const send = (sid: string, text: string) => env.client.call('sessions.send', { sid, content: [{ type: 'text', text }], uuid: crypto.randomUUID() });

describe('retomada automática depois do código 137', () => {
  it('desligada (padrão): o processo cai no meio da tarefa e nada é enviado sozinho', async () => {
    const sid = await newSession();
    const from = env.client.events.length;
    await send(sid, 'kill137');
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === sid && e.data.phase === 'dormant' && env.client.events.indexOf(e) >= from, 15_000, 'conversa pausada');
    await wait(900); // bem mais que os 150 ms de espera configurados
    expect(deckEvents(sid, 'auto_resume', from)).toHaveLength(0);
    expect(userEchoes(sid, from).map(textOf)).toEqual(['kill137']);
    await env.client.call('sessions.close', { sid });
  }, 30_000);

  it('ligada: cai no meio da tarefa, espera, manda "continue" e o Claude responde', async () => {
    await env.client.call('settings.set', { autoResumeOnKill: true, autoResumeMessage: 'continue', autoResumeMax: 5 });
    const sid = await newSession();
    const from = env.client.events.length;
    await send(sid, 'kill137');
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= from, 30_000, 'turno retomado');
    const scheduled = deckEvents(sid, 'auto_resume', from);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].data.msg.attempt).toBe(1);
    expect(userEchoes(sid, from).map(textOf)).toEqual(['kill137', 'continue']);
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === sid && e.data.phase === 'idle' && env.client.events.indexOf(e) >= from, 10_000, 'pronto');
    await env.client.call('sessions.close', { sid });
  }, 45_000);

  it('usa a mensagem configurada', async () => {
    await env.client.call('settings.set', { autoResumeOnKill: true, autoResumeMessage: 'vai', autoResumeMax: 5 });
    const sid = await newSession();
    const from = env.client.events.length;
    await send(sid, 'kill137');
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= from, 30_000, 'turno retomado');
    expect(userEchoes(sid, from).map(textOf)).toEqual(['kill137', 'vai']);
    await env.client.call('sessions.close', { sid });
  }, 45_000);

  it('ligada, mas o processo estava parado entre tarefas: não manda nada', async () => {
    await env.client.call('settings.set', { autoResumeOnKill: true, autoResumeMessage: 'continue', autoResumeMax: 5 });
    const sid = await newSession();
    const from = env.client.events.length;
    await send(sid, 'kill137later');
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'result' && env.client.events.indexOf(e) >= from, 30_000, 'turno concluído');
    await env.client.waitFor((e) => e.event === 'session.state' && e.data.sid === sid && e.data.phase === 'dormant' && env.client.events.indexOf(e) >= from, 15_000, 'processo morto depois do turno');
    await wait(900);
    expect(deckEvents(sid, 'auto_resume', from)).toHaveLength(0);
    expect(userEchoes(sid, from).map(textOf)).toEqual(['kill137later']);
    await env.client.call('sessions.close', { sid });
  }, 45_000);

  it('Parar durante a espera cancela a retomada', async () => {
    process.env.CLAUDE_DECK_AUTORESUME_DELAY_MS = '1500';
    try {
      await env.client.call('settings.set', { autoResumeOnKill: true, autoResumeMessage: 'continue', autoResumeMax: 5 });
      const sid = await newSession();
      const from = env.client.events.length;
      await send(sid, 'kill137');
      await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'deck_event' && e.data.msg.event === 'auto_resume' && env.client.events.indexOf(e) >= from, 15_000, 'retomada agendada');
      await env.client.call('sessions.interrupt', { sid });
      await wait(2500);
      expect(userEchoes(sid, from).map(textOf)).toEqual(['kill137']);
      await env.client.call('sessions.close', { sid });
    } finally {
      process.env.CLAUDE_DECK_AUTORESUME_DELAY_MS = '150';
    }
  }, 45_000);

  it('desiste depois de quedas seguidas e avisa, sem laço infinito', async () => {
    // "kill137" volta a cair toda vez que é reenviado; aqui a mensagem de retomada É esse comando.
    await env.client.call('settings.set', { autoResumeOnKill: true, autoResumeMessage: 'kill137', autoResumeMax: 2 });
    const sid = await newSession();
    const from = env.client.events.length;
    await send(sid, 'kill137');
    await env.client.waitFor((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'deck_event' && e.data.msg.event === 'auto_resume_gave_up' && env.client.events.indexOf(e) >= from, 30_000, 'desistiu');
    await wait(600); // se houvesse laço, apareceriam mais tentativas
    expect(deckEvents(sid, 'auto_resume', from)).toHaveLength(2);
    expect(deckEvents(sid, 'auto_resume_gave_up', from)).toHaveLength(1);
    expect(userEchoes(sid, from).map(textOf)).toEqual(['kill137', 'kill137', 'kill137']);
    await env.client.call('sessions.close', { sid });
  }, 60_000);
});
