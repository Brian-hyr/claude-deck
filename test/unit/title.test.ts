import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store, resolvePaths } from '../../src/server/config';
import { ClaudeSession, SessionManager, type SessionRecord } from '../../src/server/claude/session';

// O nome da aba não some: conversa retomada/restaurada busca o título no transcript na hora
// (sem esperar o fim de um turno), e o nome do próprio usuário nunca é trocado nem apagado.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function fixture(opts: {
  rec?: Partial<SessionRecord>;
  real?: () => string | undefined;
  provisional?: () => string | undefined;
  hostState?: string;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-title-'));
  const store = new Store(resolvePaths(dir));
  const registry = Object.assign(new EventEmitter(), { status: () => ({ id: 'srv', state: opts.hostState ?? 'ready' }) });
  let writes = 0;
  const mgr = new SessionManager(
    registry as any,
    store,
    () => {},
    async () => opts.real?.(),
    async () => (writes++, true),
    async () => opts.provisional?.(),
  );
  const record: SessionRecord = { sid: 'unit-session', hostId: 'local', cwd: dir, sessionId: 'cli-1', createdAt: Date.now(), permissionMode: 'default', ...opts.rec };
  const session = new ClaudeSession(record, mgr);
  mgr.sessions.set(session.state.sid, session);
  cleanups.push(() => {
    if ((mgr as any).persistTimer) clearTimeout((mgr as any).persistTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { mgr, session, registry, writes: () => writes };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('nome da aba de conversa retomada', () => {
  it('busca o nome do transcript sem esperar um turno terminar', async () => {
    const f = fixture({ real: () => 'Gráficos picotando na Cyberpanel' });
    expect(f.session.state.title).toBeUndefined();
    f.mgr.ensureTitle(f.session);
    await tick();
    expect(f.session.state.title).toBe('Gráficos picotando na Cyberpanel');
    expect(f.session.titleFromPrompt).toBe(false);
  });

  it('sem nome no transcript, usa o começo do 1º pedido como provisório', async () => {
    const f = fixture({ provisional: () => 'veja essa duvida ai da svinter' });
    f.mgr.ensureTitle(f.session);
    await tick();
    expect(f.session.state.title).toBe('veja essa duvida ai da svinter');
    expect(f.session.titleFromPrompt).toBe(true);
  });

  it('o nome do Claude substitui o provisório quando aparece', async () => {
    let real: string | undefined;
    const f = fixture({ real: () => real, provisional: () => 'veja essa duvida' });
    f.mgr.ensureTitle(f.session);
    await tick();
    expect(f.session.state.title).toBe('veja essa duvida');
    real = 'Dúvida sobre a Svinter';
    await f.mgr.refreshTitle(f.session);
    expect(f.session.state.title).toBe('Dúvida sobre a Svinter');
    expect(f.session.titleFromPrompt).toBe(false);
  });

  it('o provisório sobrevive ao reinício do app e continua substituível', () => {
    const f = fixture({ rec: { title: 'veja essa duvida', titleFromPrompt: true } });
    expect(f.session.titleFromPrompt).toBe(true);
    expect(f.session.record().titleFromPrompt).toBe(true);
  });

  it('servidor remoto desconectado não é acessado; ao conectar, a aba ganha o nome', async () => {
    let connected = false;
    const f = fixture({ rec: { hostId: 'srv' }, real: () => 'Nome do servidor' });
    (f.mgr.registry as any).status = () => ({ id: 'srv', state: connected ? 'ready' : 'idle' });
    f.mgr.ensureTitle(f.session);
    await tick();
    expect(f.session.state.title).toBeUndefined();
    connected = true;
    f.registry.emit('status', { id: 'srv', state: 'ready' });
    await tick();
    expect(f.session.state.title).toBe('Nome do servidor');
  });

  it('não refaz a busca a cada chamada quando o transcript não tem nome', async () => {
    let reads = 0;
    const f = fixture({ real: () => (reads++, undefined) });
    f.mgr.ensureTitle(f.session);
    f.mgr.ensureTitle(f.session);
    f.mgr.ensureTitle(f.session);
    await tick();
    expect(reads).toBe(1);
  });
});

describe('nome dado pelo usuário', () => {
  it('não é trocado pelo título automático', async () => {
    const f = fixture({ real: () => 'Título do Claude' });
    f.session.setTitle('Meu nome', true);
    await f.mgr.refreshTitle(f.session);
    expect(f.session.state.title).toBe('Meu nome');
    expect(f.writes()).toBe(1); // gravado no transcript (uma vez)
    f.mgr.ensureTitle(f.session);
    await tick();
    expect(f.session.state.title).toBe('Meu nome');
  });
});
