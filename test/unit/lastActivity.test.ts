import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store, resolvePaths } from '../../src/server/config';
import { ClaudeSession, SessionManager, type SessionRecord } from '../../src/server/claude/session';

// `lastActivityAt`: quando a conversa começou/terminou um turno pela última vez. A interface usa para
// ordenar as abas. Guardado pelo servidor, então sobrevive a recarregar a janela e a reiniciar o app.

const cleanups: (() => void)[] = [];
const oldDelay = process.env.CLAUDE_DECK_UNSEEN_DELAY_MS;
beforeEach(() => {
  process.env.CLAUDE_DECK_UNSEEN_DELAY_MS = '40';
});
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  if (oldDelay === undefined) delete process.env.CLAUDE_DECK_UNSEEN_DELAY_MS;
  else process.env.CLAUDE_DECK_UNSEEN_DELAY_MS = oldDelay;
});

function fixture(rec?: Partial<SessionRecord>, alive = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lastact-'));
  const store = new Store(resolvePaths(dir));
  const mgr = new SessionManager(new EventEmitter() as any, store, () => {});
  const record: SessionRecord = { sid: 'unit-session', hostId: 'local', cwd: dir, createdAt: Date.now(), permissionMode: 'default', ...rec };
  const session = new ClaudeSession(record, mgr);
  if (alive) session.state.phase = 'idle';
  mgr.sessions.set(session.state.sid, session);
  const receive = (msg: any) => (session as any).onLine(JSON.stringify(msg), JSON.stringify(msg).length + 1);
  cleanups.push(() => {
    (session as any).cancelUnseenTimer();
    if ((mgr as any).persistTimer) clearTimeout((mgr as any).persistTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const saved = () => {
    mgr.persistNow();
    return JSON.parse(fs.readFileSync(store.paths.sessionsFile, 'utf8'))[0];
  };
  return { session, receive, saved };
}

const turnStarts = { type: 'stream_event', event: { type: 'message_start' } };
const ok = { type: 'result', subtype: 'success', is_error: false };
const failed = { type: 'result', subtype: 'error_during_execution', is_error: true };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('lastActivityAt', () => {
  it('conversa que nunca trabalhou não tem horário (a interface cai na criação)', () => {
    const f = fixture();
    expect(f.session.state.lastActivityAt).toBeUndefined();
  });

  it('marca o começo e o fim do turno', async () => {
    const f = fixture();
    const t0 = Date.now();
    f.receive(turnStarts);
    const started = f.session.state.lastActivityAt!;
    expect(started).toBeGreaterThanOrEqual(t0);
    await sleep(15);
    f.receive(ok);
    const ended = f.session.state.lastActivityAt!;
    expect(ended).toBeGreaterThan(started);
  });

  it('turno que acaba em erro também conta', async () => {
    const f = fixture();
    f.receive(turnStarts);
    const started = f.session.state.lastActivityAt!;
    await sleep(15);
    f.receive(failed);
    expect(f.session.state.lastActivityAt!).toBeGreaterThan(started);
  });

  it('trechos de resposta no meio do turno não mexem no horário', async () => {
    const f = fixture();
    f.receive(turnStarts);
    const started = f.session.state.lastActivityAt!;
    await sleep(15);
    f.receive({ type: 'stream_event', event: { type: 'content_block_delta' } });
    f.receive({ type: 'assistant', message: { role: 'assistant', content: [] } });
    expect(f.session.state.lastActivityAt).toBe(started);
  });

  it('o "não visto" que aparece 3,5 s depois do fim não conta como atividade nova', async () => {
    const f = fixture();
    f.receive(turnStarts);
    f.receive(ok);
    const ended = f.session.state.lastActivityAt!;
    await sleep(120);
    expect(f.session.state.unseen).toBe('done');
    expect(f.session.state.lastActivityAt).toBe(ended);
  });

  it('fica gravado e volta depois de reiniciar o app', async () => {
    const f = fixture();
    f.receive(turnStarts);
    f.receive(ok);
    const ended = f.session.state.lastActivityAt!;
    const rec = f.saved();
    expect(rec.lastActivityAt).toBe(ended);
    const reborn = fixture(rec, false);
    expect(reborn.session.state.lastActivityAt).toBe(ended);
  });

  it('turno que já vinha rodando e foi reanexado depois de reiniciar o app não vira atividade nova', () => {
    const before = Date.now() - 600_000;
    const f = fixture({ turnStartedAt: before, lastActivityAt: before }, false);
    expect(f.session.state.phase).toBe('dormant');
    (f.session as any).setPhase('running'); // reanexou: dormant -> running, com o turno guardado = o mesmo turno
    expect(f.session.state.phase).toBe('running');
    expect(f.session.state.turnStartedAt).toBe(before);
    expect(f.session.state.lastActivityAt).toBe(before);
  });

  it('valor estranho no arquivo é ignorado', () => {
    expect(fixture({ lastActivityAt: 'ontem' as any }, false).session.state.lastActivityAt).toBeUndefined();
    expect(fixture({ lastActivityAt: -5 }, false).session.state.lastActivityAt).toBeUndefined();
  });
});
