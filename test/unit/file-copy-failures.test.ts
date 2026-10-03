import { describe, expect, it } from 'vitest';
import { FileTransfers, COPY_TERMINAL } from '../../src/server/fs/transfers';
import { MemoryCopyFs } from '../fixtures/copyfs';
import type { FileCopyJob } from '../../src/shared/types';

async function setup(opts: { limit?: number; confirmAbove?: number; sameHost?: boolean } = {}) {
  const a = new MemoryCopyFs(), b = new MemoryCopyFs();
  await a.mkdir('/src'); await b.mkdir('/dst');
  const manager = new FileTransfers({
    platform: () => 'posix', resolve: async (h) => ({ fs: h === 'A' ? a : b, identity: opts.sameHost ? 'one' : h }),
    update: () => {}, clipboard: () => {}, changed: () => {}, reserve: async () => () => {}, ...opts,
  });
  const start = (p = '/src/file') => {
    const c = manager.setClipboard('origin', 'A', p);
    return manager.start('dest', { requestId: crypto.randomUUID(), clipboardId: c.id, revision: c.revision, hostId: 'B', dir: '/dst' });
  };
  const wait = async (j: FileCopyJob, decision = false) => {
    for (let i = 0; i < 1500; i++) { const state = manager.get('dest', j.id); if (COPY_TERMINAL.has(state.state) || decision && state.state === 'awaitingDecision') return state; await new Promise((r) => setTimeout(r, 2)); }
    throw new Error('timeout cópia fake');
  };
  return { a, b, manager, start, wait };
}

describe('cópia entre dois hosts simulados, sem rede', () => {
  it('encaminha >4 GiB com backpressure e sem armazenar arquivo inteiro', async () => {
    const { a, b, start, wait, manager } = await setup();
    const size = 4 * 1024 ** 3 + 123;
    a.virtual('/src/file', size);
    const j = await wait(start());
    expect(j.state).toBe('completed'); expect(j.transferred).toBe(size);
    expect(b.nodes.get('/dst/file')?.st.size).toBe(size);
    expect(b.nodes.get('/dst/file')?.data).toBeUndefined();
    expect(b.maxBuffered).toBeLessThanOrEqual(1024 * 1024);
    expect(a.closed).toBe(1); expect(b.closed).toBe(1);
    await manager.shutdown();
  });
  it('falha na escrita/close preserva o antigo e remove temporário próprio', async () => {
    for (const failure of ['failWrite', 'failClose'] as const) {
      const { a, b, start, wait, manager } = await setup();
      a.put('/src/file', 'novo'); b.put('/dst/file', 'antigo'); b[failure] = true;
      const j = await wait(start(), true); manager.decide('dest', j.id, j.revision, 'replace');
      expect((await wait(j)).copied).toBe(0);
      expect(b.nodes.get('/dst/file')?.data?.toString()).toBe('antigo');
      expect([...b.nodes.keys()].some((p) => p.includes('.part'))).toBe(false);
      await manager.shutdown();
    }
  });
  it('cancelamento destrói os streams, não publica final e não apaga origem', async () => {
    const { a, b, start, wait, manager } = await setup();
    a.virtual('/src/file', 100 * 1024 * 1024); b.delay = 5;
    const j = start();
    for (let i = 0; i < 100; i++) { if (manager.get('dest', j.id).transferred) break; await new Promise((r) => setTimeout(r, 2)); }
    manager.cancel('dest', j.id);
    expect((await wait(j)).state).toBe('cancelled');
    expect(a.nodes.has('/src/file')).toBe(true); expect(b.nodes.has('/dst/file')).toBe(false);
    expect([...b.nodes.keys()].some((p) => p.includes('.part'))).toBe(false);
    await manager.shutdown();
  });
  it('commit com resposta perdida é incerto, sem apagar final nem repetir', async () => {
    const { a, b, start, wait, manager } = await setup();
    a.put('/src/file', 'novo'); b.uncertain = true;
    const j = await wait(start());
    expect(j.state).toBe('uncertain'); expect(b.published).toBe(1);
    expect(b.nodes.get('/dst/file')?.data?.toString()).toBe('novo');
    expect(j.issues.some((x) => x.message.includes('não confirmada'))).toBe(true);
    await manager.shutdown();
  });
  it('links internos são omitidos, raiz link é recusada; inclui pasta vazia', async () => {
    const { a, b, start, wait, manager } = await setup();
    a.put('/src/file', 'f'); a.link('/src/atalho'); await a.mkdir('/src/vazia');
    let j = await wait(start('/src'));
    expect(j.state).toBe('partial'); expect(j.omitted).toBe(1);
    expect(b.nodes.has('/dst/src/vazia')).toBe(true); expect(b.nodes.has('/dst/src/atalho')).toBe(false);
    j = await wait(start('/src/atalho')); expect(j.state).toBe('failed');
    await manager.shutdown();
  });
  it('limite e confirmação acontecem antes de qualquer byte/dir de destino', async () => {
    const { a, b, start, wait, manager } = await setup({ limit: 2 });
    a.put('/src/a', 'a'); a.put('/src/b', 'b');
    expect((await wait(start('/src'))).state).toBe('failed');
    expect([...b.nodes.keys()]).toEqual(['/', '/dst']);
    await manager.shutdown();
    const second = await setup({ confirmAbove: 0 }); second.a.put('/src/file', 'f');
    const j = await second.wait(second.start(), true);
    expect(j.state).toBe('awaitingDecision'); expect(second.b.writeBytes).toBe(0);
    await second.manager.shutdown();
  });
  it('erro arquivo↔pasta não apaga pasta nem começa seus descendentes', async () => {
    const { a, b, start, wait, manager } = await setup();
    await a.mkdir('/src/file'); a.put('/src/file/nested', 'n'); b.put('/dst/file', 'old');
    const j = await wait(start(), true); manager.decide('dest', j.id, j.revision, 'replace');
    expect((await wait(j)).state).toBe('partial'); expect(b.nodes.get('/dst/file')?.data?.toString()).toBe('old');
    expect(b.nodes.has('/dst/file/nested')).toBe(false);
    await manager.shutdown();
  });
});
