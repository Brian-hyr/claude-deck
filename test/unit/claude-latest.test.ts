// Consulta da versão mais nova do Claude Code (npm): cache, falha silenciosa e gancho de teste.
import { describe, expect, it, vi } from 'vitest';
import { LatestClaude, testOverride } from '../../src/server/claude/latest';

const ok = (version: unknown) => ({ ok: true, json: async () => ({ version }) });

describe('LatestClaude', () => {
  it('consulta o npm, devolve a versão e guarda em cache por 30 minutos', async () => {
    let t = 1_000;
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ok('2.1.293'));
    const latest = new LatestClaude(fetchMock as any, () => t);
    expect(latest.current).toBeUndefined();
    expect(await latest.ensure()).toBe('2.1.293');
    expect(latest.current).toBe('2.1.293');
    expect(fetchMock.mock.calls[0][0]).toBe('https://registry.npmjs.org/@anthropic-ai/claude-code/latest');
    t += 29 * 60_000;
    await latest.ensure();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    t += 2 * 60_000;
    await latest.ensure();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('consultas ao mesmo tempo viram uma só', async () => {
    const fetchMock = vi.fn(async () => ok('2.1.293'));
    const latest = new LatestClaude(fetchMock as any, () => 0);
    const [a, b, c] = await Promise.all([latest.ensure(), latest.ensure(), latest.ensure()]);
    expect([a, b, c]).toEqual(['2.1.293', '2.1.293', '2.1.293']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sem internet ou com resposta ruim: não rejeita, não inventa versão e só tenta de novo em 5 minutos', async () => {
    let t = 0;
    const fetchMock = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    const latest = new LatestClaude(fetchMock as any, () => t);
    await expect(latest.ensure()).resolves.toBeUndefined();
    expect(latest.current).toBeUndefined();
    t += 4 * 60_000;
    await latest.ensure();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    t += 2 * 60_000;
    await latest.ensure();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([[{ ok: false, json: async () => ({}) }], [ok('latest')], [ok('2.1')], [ok(undefined)], [ok('2.1.293; rm -rf /')]])('resposta inválida %#: ignora', async (resp) => {
    const latest = new LatestClaude((async () => resp) as any, () => 0);
    await expect(latest.ensure()).resolves.toBeUndefined();
    expect(latest.current).toBeUndefined();
  });

  it('uma falha depois de um sucesso mantém a última versão boa', async () => {
    let t = 0;
    let good = true;
    const latest = new LatestClaude((async () => (good ? ok('2.1.293') : Promise.reject(new Error('fora')))) as any, () => t);
    expect(await latest.ensure()).toBe('2.1.293');
    good = false;
    t += 31 * 60_000;
    expect(await latest.ensure()).toBe('2.1.293');
    expect(latest.current).toBe('2.1.293');
  });

  it('pede com tempo limite (a conexão com o servidor nunca fica esperando a internet)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return ok('2.1.293');
    });
    await new LatestClaude(fetchMock as any, () => 0).ensure();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('versão forçada (testes) dispensa a rede', async () => {
    const fetchMock = vi.fn();
    const latest = new LatestClaude(fetchMock as any, () => 0, '99.0.0');
    expect(latest.current).toBe('99.0.0');
    expect(await latest.ensure()).toBe('99.0.0');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('testOverride', () => {
  it('só vale com os ganchos de teste ligados e com versão X.Y.Z', () => {
    expect(testOverride({ CLAUDE_DECK_TEST_LATEST: '99.0.0' } as any)).toBeUndefined();
    expect(testOverride({ CLAUDE_DECK_TEST_HOOKS: '1', CLAUDE_DECK_TEST_LATEST: '99.0.0' } as any)).toBe('99.0.0');
    expect(testOverride({ CLAUDE_DECK_TEST_HOOKS: '1', CLAUDE_DECK_TEST_LATEST: 'abc' } as any)).toBeUndefined();
    expect(testOverride({ CLAUDE_DECK_TEST_HOOKS: '1' } as any)).toBeUndefined();
  });
});
