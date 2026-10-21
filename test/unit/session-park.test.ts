// Soltar o canal das conversas remotas (park) sem que elas reconectem sozinhas: é o que faz "Desconectar" e
// o fechamento de janela/aba realmente derrubarem a conexão SSH do servidor.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ClaudeSession, SessionManager } from '../../src/server/claude/session';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function makeMgr() {
  const registry = Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => ({ claude: {} })),
    ensureRunner: vi.fn(async () => {}),
    get: vi.fn(),
    status: vi.fn(() => ({ state: 'ready' })),
  });
  const store: any = {
    hosts: { caps: {} },
    paths: { sessionsFile: path.join(os.tmpdir(), `deck-park-${process.pid}-${crypto.randomUUID()}.json`) },
    settings: {},
  };
  const logs: string[] = [];
  const mgr = new SessionManager(registry as any, store, (m) => logs.push(m));
  return { mgr, registry, logs };
}

function addSession(mgr: SessionManager, over: Record<string, unknown> = {}) {
  const s = new ClaudeSession({ sid: crypto.randomUUID(), hostId: 'srv', cwd: '/x', runnerId: 'r1', wid: 'w1', createdAt: 1, ...over } as any, mgr);
  (mgr as any).add(s);
  return s;
}

function fakeTransport() {
  const t: any = new EventEmitter();
  t.alive = true;
  t.write = vi.fn(() => true);
  t.close = vi.fn(() => {
    if (!t.alive) return;
    t.alive = false;
    // Como o canal SSH de verdade: o fim chega depois, de forma assíncrona.
    void Promise.resolve().then(() => t.emit('end', { reason: 'killed' }));
  });
  return t;
}

/** Conversa remota ligada (canal vivo) e parada. */
function idleSession(mgr: SessionManager, over: Record<string, unknown> = {}) {
  const s = addSession(mgr, over);
  const t = fakeTransport();
  (s as any).attachTransport(t);
  (s as any).setPhase('idle');
  return { s, t };
}

describe('ClaudeSession.park', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('solta o canal, fica pausada e NÃO reconecta sozinha', async () => {
    const { mgr, registry } = makeMgr();
    const { s, t } = idleSession(mgr);
    expect(s.park()).toBe(true);
    await flush(); // o fim do canal chega depois: não pode valer como queda de rede
    expect(t.close).toHaveBeenCalled();
    expect(s.alive).toBe(false);
    expect(s.state.phase).toBe('dormant');
    vi.advanceTimersByTime(120_000);
    await flush();
    expect(registry.connect).not.toHaveBeenCalled();
    expect(s.state.phase).toBe('dormant');
  });

  it('sem park, a queda do canal agenda reconexão (o comportamento que park evita)', async () => {
    const { mgr, registry } = makeMgr();
    const { s, t } = idleSession(mgr);
    (s as any).attachRemote = vi.fn(async () => {
      throw new Error('sem rede');
    });
    t.emit('end', { reason: 'disconnect' });
    expect(s.state.phase).toBe('reconnecting');
    vi.advanceTimersByTime(600);
    await flush();
    expect(registry.connect).toHaveBeenCalled();
  });

  it('cancela a reconexão que já estava agendada', async () => {
    const { mgr, registry } = makeMgr();
    const { s, t } = idleSession(mgr);
    t.emit('end', { reason: 'disconnect' });
    expect(s.state.phase).toBe('reconnecting');
    expect(s.park()).toBe(true);
    vi.advanceTimersByTime(120_000);
    await flush();
    expect(registry.connect).not.toHaveBeenCalled();
    expect(s.state.phase).toBe('dormant');
  });

  it('um reanexo já em andamento não liga o canal de volta', async () => {
    const { mgr, registry } = makeMgr();
    const { s, t } = idleSession(mgr);
    let finishConnect!: () => void;
    registry.connect.mockReturnValue(new Promise((r) => (finishConnect = () => r({ claude: {} } as any))) as any);
    const attachRemote = vi.fn(async () => {});
    (s as any).attachRemote = attachRemote;
    t.emit('end', { reason: 'disconnect' });
    vi.advanceTimersByTime(600); // o reanexo começa e fica esperando a conexão
    await flush();
    expect(registry.connect).toHaveBeenCalledTimes(1);
    expect(s.park()).toBe(true);
    finishConnect();
    await flush();
    expect(attachRemote).not.toHaveBeenCalled();
    expect(s.alive).toBe(false);
    expect(s.state.phase).toBe('dormant');
  });

  it('um reanexo que já abriu o canal quando foi solto fecha esse canal', async () => {
    const { mgr } = makeMgr();
    const { s, t } = idleSession(mgr);
    let finishAttach!: () => void;
    const late = fakeTransport();
    (s as any).attachRemote = vi.fn(
      () =>
        new Promise<void>((r) => {
          finishAttach = () => {
            (s as any).attachTransport(late);
            r();
          };
        }),
    );
    t.emit('end', { reason: 'disconnect' });
    vi.advanceTimersByTime(600);
    await flush();
    expect(s.park()).toBe(true);
    finishAttach();
    await flush();
    expect(late.close).toHaveBeenCalled();
    expect(s.alive).toBe(false);
    expect(s.state.phase).toBe('dormant');
  });

  it('pedidos de controle pendentes são recusados na hora (não esperam o tempo esgotar)', () => {
    const { mgr } = makeMgr();
    const { s } = idleSession(mgr);
    const reject = vi.fn();
    (s as any).controls.set('c1', { resolve: vi.fn(), reject, timer: setTimeout(() => {}, 60_000) });
    s.park();
    expect(reject).toHaveBeenCalledTimes(1);
    expect((s as any).controls.size).toBe(0);
  });

  it('o relógio de um turno em andamento sobrevive (a conversa só fica pausada)', () => {
    const { mgr } = makeMgr();
    const { s } = idleSession(mgr);
    (s as any).setPhase('running');
    const started = s.state.turnStartedAt;
    expect(started).toBeTruthy();
    expect(s.park()).toBe(true);
    expect(s.state.phase).toBe('dormant');
    expect(s.state.turnStartedAt).toBe(started);
  });

  it('conversa local não é solta, nem a que já está solta', () => {
    const { mgr } = makeMgr();
    const local = addSession(mgr, { hostId: 'local', runnerId: undefined });
    (local as any).attachTransport(fakeTransport());
    expect(local.park()).toBe(false);
    const { s } = idleSession(mgr);
    expect(s.park()).toBe(true);
    expect(s.park()).toBe(false);
  });

  it('parkIfIdle só solta conversa parada de verdade', () => {
    const { mgr } = makeMgr();
    const { s } = idleSession(mgr);
    (s as any).setPhase('running');
    expect(s.parkIfIdle()).toBe(false);
    expect(s.alive).toBe(true);
    (s as any).setPhase('idle');
    s.pendingPermissions.set('p1', {});
    expect(s.parkIfIdle()).toBe(false);
    s.pendingPermissions.clear();
    (s as any).inTurn = true;
    expect(s.parkIfIdle()).toBe(false);
    (s as any).inTurn = false;
    (s as any).outbox.push('{"type":"user"}');
    expect(s.parkIfIdle()).toBe(false);
    (s as any).outbox.length = 0;
    expect(s.parkIfIdle()).toBe(true);
    expect(s.alive).toBe(false);
  });
});

describe('SessionManager: soltar por servidor / por janela e reanexar', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('parkHost solta só as conversas do servidor (todas, ou só as paradas)', () => {
    const { mgr } = makeMgr();
    const a = idleSession(mgr, { hostId: 'srv' }).s;
    const b = idleSession(mgr, { hostId: 'srv' }).s;
    const other = idleSession(mgr, { hostId: 'outro' }).s;
    (b as any).setPhase('running');
    expect(mgr.parkHost('srv', true)).toBe(1); // só a parada
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(true);
    expect(other.alive).toBe(true);
    expect(mgr.parkHost('srv')).toBe(1); // "Desconectar": agora a que trabalhava também
    expect(b.alive).toBe(false);
    expect(other.alive).toBe(true);
  });

  it('parkIdleOfWindow solta as paradas da janela e devolve os servidores que ela usava', () => {
    const { mgr } = makeMgr();
    const idle = idleSession(mgr, { hostId: 'srv', wid: 'w1' }).s;
    const working = idleSession(mgr, { hostId: 'srv2', wid: 'w1' }).s;
    const elsewhere = idleSession(mgr, { hostId: 'srv', wid: 'w2' }).s;
    const local = addSession(mgr, { hostId: 'local', runnerId: undefined, wid: 'w1' });
    (working as any).setPhase('running');
    const hosts = mgr.parkIdleOfWindow('w1');
    expect(hosts.sort()).toEqual(['srv', 'srv2']);
    expect(idle.alive).toBe(false);
    expect(working.alive).toBe(true); // trabalhando: segue ligada para avisar quando terminar
    expect(elsewhere.alive).toBe(true);
    expect(local.state.hostId).toBe('local');
  });

  it('resumeRemote com sids reanexa as da janela e as que estavam no meio de um turno', () => {
    const { mgr } = makeMgr();
    const mine = addSession(mgr);
    const otherIdle = addSession(mgr);
    const otherMidTurn = addSession(mgr, { turnStartedAt: Date.now() - 5000 });
    for (const s of [mine, otherIdle, otherMidTurn]) s.reattach = vi.fn(async () => {});
    mgr.resumeRemote([mine.state.sid]);
    expect(mine.reattach).toHaveBeenCalled();
    expect(otherMidTurn.reattach).toHaveBeenCalled(); // acompanhada até o fim para avisar
    expect(otherIdle.reattach).not.toHaveBeenCalled(); // de outra janela e parada: continua solta
  });

  it('resumeRemote sem sids (interface antiga) reanexa todas, como antes', () => {
    const { mgr } = makeMgr();
    const a = addSession(mgr);
    const b = addSession(mgr);
    for (const s of [a, b]) s.reattach = vi.fn(async () => {});
    mgr.resumeRemote();
    expect(a.reattach).toHaveBeenCalled();
    expect(b.reattach).toHaveBeenCalled();
  });
});
