import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store, resolvePaths } from '../../src/server/config';
import { ClaudeSession, SessionManager, type SessionRecord } from '../../src/server/claude/session';

// "Terminou e ainda não vi": o servidor guarda no estado da conversa, então sobrevive a recarregar
// a janela e a reiniciar o app.

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

/** `alive`: o processo do Claude já subiu (fase `idle`, como numa conversa em uso). Sem ele, a conversa nasce `dormant`, como logo após reiniciar o app. */
function fixture(rec?: Partial<SessionRecord>, alive = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-unseen-'));
  const store = new Store(resolvePaths(dir));
  const mgr = new SessionManager(new EventEmitter() as any, store, () => {});
  const record: SessionRecord = { sid: 'unit-session', hostId: 'local', cwd: dir, createdAt: Date.now(), permissionMode: 'default', ...rec };
  const session = new ClaudeSession(record, mgr);
  if (alive) session.state.phase = 'idle';
  mgr.sessions.set(session.state.sid, session);
  const states: any[] = [];
  session.on('state', (st) => states.push(st));
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
  return { session, mgr, store, states, receive, saved, dir, record };
}

const turnStarts = { type: 'stream_event', event: { type: 'message_start' } };
const ok = { type: 'result', subtype: 'success', is_error: false };
const failed = { type: 'result', subtype: 'error_during_execution', is_error: true };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('conversa terminou e ninguém viu', () => {
  it('não marca na hora: espera a pausa, para não avisar de um turno que emenda outro', async () => {
    const f = fixture();
    f.receive(turnStarts);
    expect(f.session.state.phase).toBe('running');
    f.receive(ok);
    expect(f.session.state.phase).toBe('idle');
    expect(f.session.state.unseen).toBeUndefined();
    await sleep(120);
    expect(f.session.state.unseen).toBe('done');
  });

  it('terminou com erro vira "error"', async () => {
    const f = fixture();
    f.receive(turnStarts);
    f.receive(failed);
    await sleep(120);
    expect(f.session.state.unseen).toBe('error');
  });

  it('o próximo passo começa dentro da pausa: nada é marcado (subagentes, hooks)', async () => {
    const f = fixture();
    f.receive(turnStarts);
    f.receive(ok);
    f.receive(turnStarts); // recomeçou antes de a pausa acabar
    expect(f.session.state.phase).toBe('running');
    await sleep(120);
    expect(f.session.state.unseen).toBeUndefined();
  });

  it('turno novo apaga o aviso do anterior', async () => {
    const f = fixture();
    f.receive(turnStarts);
    f.receive(ok);
    await sleep(120);
    expect(f.session.state.unseen).toBe('done');
    f.receive(turnStarts);
    expect(f.session.state.phase).toBe('running');
    expect(f.session.state.unseen).toBeUndefined();
    // e apagou numa única mudança de estado (a interface não vê "running com aviso" no meio)
    const last = f.states[f.states.length - 1];
    expect(last.phase).toBe('running');
    expect(last.unseen).toBeUndefined();
  });

  it('clearUnseen (a interface viu): apaga, avisa a interface e grava', async () => {
    const f = fixture();
    f.receive(turnStarts);
    f.receive(ok);
    await sleep(120);
    const before = f.states.length;
    f.session.clearUnseen();
    expect(f.session.state.unseen).toBeUndefined();
    expect(f.states.length).toBe(before + 1);
    expect(f.saved().unseen).toBeUndefined();
  });

  it('clearUnseen dentro da pausa cancela a marcação que ia acontecer', async () => {
    const f = fixture();
    f.receive(turnStarts);
    f.receive(ok);
    f.session.clearUnseen(); // já estava olhando
    await sleep(120);
    expect(f.session.state.unseen).toBeUndefined();
  });

  it('clearUnseen sem nada marcado não faz barulho', () => {
    const f = fixture();
    const before = f.states.length;
    f.session.clearUnseen();
    expect(f.states.length).toBe(before);
  });

  it('fica gravado em disco e volta depois de reiniciar o app', async () => {
    const f = fixture();
    f.receive(turnStarts);
    f.receive(failed);
    await sleep(120);
    const rec = f.saved();
    expect(rec.unseen).toBe('error');
    const reborn = fixture(rec, false);
    expect(reborn.session.state.unseen).toBe('error');
    expect(reborn.session.state.phase).toBe('dormant'); // sem processo, mas o aviso continua
  });

  it('valor estranho no arquivo é ignorado', () => {
    const f = fixture({ unseen: 'talvez' as any }, false);
    expect(f.session.state.unseen).toBeUndefined();
  });

  it('fechar a aba cancela a marcação pendente (nada de estado em conversa que já não existe)', async () => {
    const f = fixture();
    f.receive(turnStarts);
    f.receive(ok);
    await f.session.close();
    await sleep(120);
    expect(f.session.state.unseen).toBeUndefined();
  });
});
