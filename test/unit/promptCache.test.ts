import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatModel } from '../../src/web/lib/chatModel';
import { CACHE_TTL_MS, cachePillLabel, cacheTooltip, cacheWindowAt, formatIdle, inputTokensOf, markCacheCompacted, recordCacheFrame, ttlFromUsage } from '../../src/web/lib/promptCache';

const MIN = 60_000;
const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** `usage` como o CLI manda: gravou cache com a validade pedida (ou só leu, sem gravar). */
const usage = (o: { read?: number; create?: number; ttl?: '5m' | '1h'; input?: number } = {}) => ({
  input_tokens: o.input ?? 10,
  cache_read_input_tokens: o.read ?? 0,
  cache_creation_input_tokens: o.create ?? 0,
  output_tokens: 5,
  cache_creation: { ephemeral_5m_input_tokens: o.ttl === '5m' ? (o.create ?? 0) : 0, ephemeral_1h_input_tokens: o.ttl === '1h' ? (o.create ?? 0) : 0 },
});

describe('promptCache: funções puras', () => {
  it('ttlFromUsage: 1 h tem prioridade; sem gravação nova, desconhecido', () => {
    expect(ttlFromUsage(usage({ create: 100, ttl: '5m' }))).toBe('5m');
    expect(ttlFromUsage(usage({ create: 100, ttl: '1h' }))).toBe('1h');
    expect(ttlFromUsage({ cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 7 } })).toBe('1h');
    expect(ttlFromUsage(usage({ read: 500 }))).toBeUndefined();
    expect(ttlFromUsage({ input_tokens: 3 })).toBeUndefined();
    expect(ttlFromUsage(undefined)).toBeUndefined();
  });

  it('inputTokensOf: soma novo + lido + gravado; sem token nenhum, undefined', () => {
    expect(inputTokensOf(usage({ input: 10, read: 1000, create: 200 }))).toBe(1210);
    expect(inputTokensOf({ input_tokens: 0, cache_read_input_tokens: 0 })).toBeUndefined();
    expect(inputTokensOf({})).toBeUndefined();
    expect(inputTokensOf(null)).toBeUndefined();
  });

  it('cacheWindowAt: contagem regressiva em minutos (arredonda para cima) e vence no prazo', () => {
    const r = { messageId: 'm1', anchorAt: T0, ttl: '5m' as const, recacheTokens: 1234 };
    expect(cacheWindowAt(r, T0)).toMatchObject({ kind: 'warm', ttl: '5m', minutesLeft: 5, msLeft: 5 * MIN });
    expect(cacheWindowAt(r, T0 + 1)).toMatchObject({ kind: 'warm', minutesLeft: 5 });
    expect(cacheWindowAt(r, T0 + 4 * MIN + 1)).toMatchObject({ kind: 'warm', minutesLeft: 1 });
    expect(cacheWindowAt(r, T0 + 5 * MIN - 1)).toMatchObject({ kind: 'warm', minutesLeft: 1 });
    // No instante exato do prazo já venceu.
    expect(cacheWindowAt(r, T0 + 5 * MIN)).toEqual({ kind: 'cold', reason: 'expired', idleMs: 5 * MIN, recacheTokens: 1234 });
    expect(cacheWindowAt(r, T0 + 47 * MIN)).toMatchObject({ kind: 'cold', reason: 'expired', idleMs: 47 * MIN });
    // Relógio atrasado em relação à âncora: não passa do prazo cheio.
    expect(cacheWindowAt(r, T0 - 10 * MIN)).toMatchObject({ kind: 'warm', msLeft: 5 * MIN, minutesLeft: 5 });
  });

  it('cacheWindowAt: validade de 1 h', () => {
    const r = { anchorAt: T0, ttl: '1h' as const };
    expect(CACHE_TTL_MS['1h']).toBe(60 * MIN);
    expect(cacheWindowAt(r, T0 + 10 * MIN)).toMatchObject({ kind: 'warm', ttl: '1h', minutesLeft: 50 });
    expect(cacheWindowAt(r, T0 + 61 * MIN)).toMatchObject({ kind: 'cold', reason: 'expired' });
  });

  it('cacheWindowAt: sem registro, âncora ou validade → desconhecido (o contador não aparece)', () => {
    expect(cacheWindowAt(undefined, T0)).toEqual({ kind: 'unknown' });
    expect(cacheWindowAt({ ttl: '5m' }, T0)).toEqual({ kind: 'unknown' });
    expect(cacheWindowAt({ anchorAt: T0 }, T0)).toEqual({ kind: 'unknown' });
  });

  it('cacheWindowAt: conversa compactada vence na hora, mesmo com o prazo correndo', () => {
    const r = markCacheCompacted({ anchorAt: T0, ttl: '5m' }, T0 + MIN);
    expect(cacheWindowAt(r, T0 + 2 * MIN)).toEqual({ kind: 'cold', reason: 'compacted', idleMs: MIN });
    expect(cacheWindowAt(markCacheCompacted(undefined, T0), T0)).toMatchObject({ kind: 'cold', reason: 'compacted' });
  });

  it('recordCacheFrame: ancora no pedido quando ele veio antes da resposta; ignora pedido posterior', () => {
    const f = { messageId: 'm1', receivedAt: T0 + 20_000, usage: usage({ create: 900, ttl: '5m' }) };
    expect(recordCacheFrame(undefined, { ...f, requestAt: T0 })).toMatchObject({ anchorAt: T0, ttl: '5m', recacheTokens: 910 });
    expect(recordCacheFrame(undefined, { ...f, requestAt: T0 + 40_000 })!.anchorAt).toBe(T0 + 20_000);
    expect(recordCacheFrame(undefined, f)!.anchorAt).toBe(T0 + 20_000);
    // Ao vivo, o horário de recebimento vale mais que o `timestamp` do transcript.
    expect(recordCacheFrame(undefined, { ...f, timestamp: T0 - MIN })!.anchorAt).toBe(T0 + 20_000);
    expect(recordCacheFrame(undefined, { messageId: 'm2', timestamp: T0 + 5, usage: usage({ create: 1, ttl: '1h' }) })!.anchorAt).toBe(T0 + 5);
  });

  it('recordCacheFrame: várias linhas da mesma mensagem mantêm a âncora da primeira', () => {
    const first = recordCacheFrame(undefined, { messageId: 'm1', timestamp: T0, usage: usage({ create: 50, ttl: '5m' }) })!;
    const again = recordCacheFrame(first, { messageId: 'm1', timestamp: T0 + 30_000, usage: usage({ create: 50, ttl: '5m' }) })!;
    expect(again.anchorAt).toBe(T0);
    const next = recordCacheFrame(again, { messageId: 'm2', timestamp: T0 + 90_000, usage: usage({ read: 60, input: 5 }) })!;
    expect(next.anchorAt).toBe(T0 + 90_000);
  });

  it('recordCacheFrame: só leu o cache → herda a validade anterior; sem cache nenhum → desconhecida', () => {
    const base = recordCacheFrame(undefined, { messageId: 'm1', timestamp: T0, usage: usage({ create: 50, ttl: '1h' }) })!;
    const readOnly = recordCacheFrame(base, { messageId: 'm2', timestamp: T0 + MIN, usage: usage({ read: 50, input: 4 }) })!;
    expect(readOnly.ttl).toBe('1h');
    const noCache = recordCacheFrame(base, { messageId: 'm3', timestamp: T0 + 2 * MIN, usage: usage({ input: 900 }) })!;
    expect(noCache.ttl).toBeUndefined();
    expect(cacheWindowAt(noCache, T0 + 2 * MIN)).toEqual({ kind: 'unknown' });
    // Só leu o cache e nunca soube a validade (conversa retomada de um transcript sem gravação): desconhecida.
    expect(recordCacheFrame(undefined, { messageId: 'm9', timestamp: T0, usage: usage({ read: 70 }) })!.ttl).toBeUndefined();
  });

  it('recordCacheFrame: chamada sem token nenhum não muda nada', () => {
    const base = recordCacheFrame(undefined, { messageId: 'm1', timestamp: T0, usage: usage({ create: 50, ttl: '5m' }) });
    expect(recordCacheFrame(base, { messageId: 'm2', timestamp: T0 + MIN, usage: {} })).toBe(base);
    expect(recordCacheFrame(undefined, { messageId: 'm2', timestamp: T0, usage: undefined })).toBeUndefined();
  });

  it('recordCacheFrame: depois da compactação, só quadro posterior volta a valer', () => {
    const before = recordCacheFrame(undefined, { messageId: 'm1', timestamp: T0, usage: usage({ create: 50, ttl: '5m' }) })!;
    const compacted = markCacheCompacted(before, T0 + MIN);
    // Transcript: outra linha da mesma mensagem, ou uma anterior à compactação → continua compactado.
    expect(recordCacheFrame(compacted, { messageId: 'm1', timestamp: T0 + MIN + 5, usage: usage({ create: 50, ttl: '5m' }) })!.compactedAt).toBe(T0 + MIN);
    expect(recordCacheFrame(compacted, { messageId: 'm0', timestamp: T0 + 10, usage: usage({ create: 5, ttl: '5m' }) })!.compactedAt).toBe(T0 + MIN);
    // Transcript: mensagem nova depois da compactação → limpa.
    expect(recordCacheFrame(compacted, { messageId: 'm2', timestamp: T0 + 2 * MIN, usage: usage({ create: 5, ttl: '5m' }) })!.compactedAt).toBeUndefined();
    // Ao vivo: qualquer mensagem nova limpa.
    expect(recordCacheFrame(compacted, { messageId: 'm3', receivedAt: T0 + 3 * MIN, usage: usage({ create: 5, ttl: '5m' }) })!.compactedAt).toBeUndefined();
  });

  it('formatIdle e textos', () => {
    expect(formatIdle(0)).toBe('0m');
    expect(formatIdle(47 * MIN + 30_000)).toBe('47m');
    expect(formatIdle(125 * MIN)).toBe('2h 5m');
    expect(formatIdle((27 * 60 + 10) * MIN)).toBe('1d 3h');
    expect(cachePillLabel({ kind: 'warm', ttl: '5m', msLeft: 4 * MIN, minutesLeft: 4 })).toBe('4m');
    expect(cachePillLabel({ kind: 'cold', reason: 'expired', idleMs: 1 })).toBeUndefined();
    expect(cachePillLabel({ kind: 'unknown' })).toBeUndefined();
    expect(cacheTooltip({ kind: 'unknown' })).toBe('');
    expect(cacheTooltip({ kind: 'warm', ttl: '5m', msLeft: 30_000, minutesLeft: 1 })).toContain('cerca de 1 min restante');
    expect(cacheTooltip({ kind: 'warm', ttl: '1h', msLeft: 50 * MIN, minutesLeft: 50 })).toMatch(/cerca de 50 min restantes.*validade de 1 h/);
    const cold = cacheTooltip({ kind: 'cold', reason: 'expired', idleMs: 47 * MIN, recacheTokens: 120_000 });
    expect(cold).toContain('ocioso há 47m');
    expect(cold).toMatch(/recriar o cache de cerca de 120k tokens/);
    expect(cacheTooltip({ kind: 'cold', reason: 'expired', idleMs: MIN })).toContain('recriar o cache.');
    expect(cacheTooltip({ kind: 'cold', reason: 'compacted', idleMs: 0 })).toContain('compactada');
  });
});

describe('promptCache: ChatModel', () => {
  afterEach(() => vi.useRealTimers());
  const live = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  };
  const asst = (id: string, u: any, extra: any = {}) => ({ type: 'assistant', uuid: `a-${id}`, message: { id, model: 'claude-x', content: [{ type: 'text', text: 'oi' }], usage: u }, parent_tool_use_id: null, ...extra });
  const userMsg = (uuid: string, extra: any = {}) => ({ type: 'user', uuid, message: { role: 'user', content: 'oi' }, parent_tool_use_id: null, ...extra });
  const win = (m: ChatModel, at: number) => cacheWindowAt(m.promptCache, at);

  it('ao vivo: pedido enviado → resposta; a contagem parte do pedido, não da resposta', () => {
    live();
    const m = new ChatModel();
    m.addPendingUser('u1', 'oi', [], T0); // clique
    vi.setSystemTime(T0 + 20_000);
    m.apply(asst('m1', usage({ create: 800, ttl: '5m' })));
    expect(m.promptCache).toMatchObject({ messageId: 'm1', anchorAt: T0, ttl: '5m', recacheTokens: 810 });
    expect(win(m, T0 + 2 * MIN)).toMatchObject({ kind: 'warm', minutesLeft: 3 });
    expect(win(m, T0 + 5 * MIN)).toMatchObject({ kind: 'cold', reason: 'expired' });
  });

  it('ao vivo: resultado de ferramenta também é um pedido novo (renova a contagem)', () => {
    live();
    const m = new ChatModel();
    m.addPendingUser('u1', 'oi', [], T0);
    m.apply(asst('m1', usage({ create: 800, ttl: '5m' })));
    vi.setSystemTime(T0 + 3 * MIN);
    m.apply({ type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, parent_tool_use_id: null });
    vi.setSystemTime(T0 + 3 * MIN + 10_000);
    m.apply(asst('m2', usage({ read: 810, input: 3 })));
    expect(m.promptCache).toMatchObject({ messageId: 'm2', anchorAt: T0 + 3 * MIN, ttl: '5m' });
    expect(win(m, T0 + 6 * MIN)).toMatchObject({ kind: 'warm', minutesLeft: 2 });
  });

  it('stream_event message_start já conta (a resposta longa ainda está sendo gerada)', () => {
    live();
    const m = new ChatModel();
    m.addPendingUser('u1', 'oi', [], T0);
    vi.setSystemTime(T0 + 5_000);
    m.apply({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'claude-x', content: [], usage: usage({ create: 500, ttl: '1h' }) } }, parent_tool_use_id: null });
    expect(m.promptCache).toMatchObject({ messageId: 'm1', anchorAt: T0, ttl: '1h' });
    // O assistant completo da mesma mensagem chega depois: mesma âncora.
    vi.setSystemTime(T0 + 50_000);
    m.apply(asst('m1', usage({ create: 500, ttl: '1h' })));
    expect(m.promptCache!.anchorAt).toBe(T0);
  });

  it('subagente, mensagem sintética e uso vazio não mexem no contador', () => {
    live();
    const m = new ChatModel();
    m.addPendingUser('u1', 'oi', [], T0);
    m.apply(asst('m1', usage({ create: 800, ttl: '5m' })));
    const before = m.promptCache;
    vi.setSystemTime(T0 + MIN);
    m.apply(asst('sub', usage({ create: 9, ttl: '1h' }), { parent_tool_use_id: 'task1' }));
    m.apply({ type: 'stream_event', event: { type: 'message_start', message: { id: 'sub2', usage: usage({ create: 9, ttl: '1h' }) } }, parent_tool_use_id: 'task1' });
    m.apply({ type: 'assistant', uuid: 'syn', message: { id: 'syn', model: '<synthetic>', content: [{ type: 'text', text: 'x' }], usage: usage({ create: 9, ttl: '1h' }) }, parent_tool_use_id: null });
    m.apply(asst('vazio', {}));
    expect(m.promptCache).toEqual(before);
  });

  it('transcript (history): usa o timestamp das linhas, pedido = linha do usuário', () => {
    live();
    vi.setSystemTime(T0 + 30 * MIN); // abriu a conversa meia hora depois
    const m = new ChatModel();
    m.apply(userMsg('u1', { timestamp: iso(T0) }), { history: true });
    m.apply(asst('m1', usage({ create: 800, ttl: '5m' }), { timestamp: iso(T0 + 25_000) }), { history: true });
    // Segunda linha da mesma mensagem (bloco de texto depois do de raciocínio): mesma âncora.
    m.apply(asst('m1', usage({ create: 800, ttl: '5m' }), { uuid: 'a-m1b', timestamp: iso(T0 + 40_000) }), { history: true });
    expect(m.promptCache).toMatchObject({ messageId: 'm1', anchorAt: T0 });
    expect(win(m, Date.now())).toMatchObject({ kind: 'cold', reason: 'expired', idleMs: 30 * MIN, recacheTokens: 810 });
  });

  it('transcript recente: conversa aberta logo depois continua com o cache ativo', () => {
    live();
    vi.setSystemTime(T0 + 2 * MIN);
    const m = new ChatModel();
    m.apply(userMsg('u1', { timestamp: iso(T0) }), { history: true });
    m.apply(asst('m1', usage({ create: 800, ttl: '5m' }), { timestamp: iso(T0 + 25_000) }), { history: true });
    expect(win(m, Date.now())).toMatchObject({ kind: 'warm', minutesLeft: 3 });
  });

  it('replay do buffer do servidor sem horário não inventa "agora"', () => {
    live();
    vi.setSystemTime(T0 + 40 * MIN);
    const m = new ChatModel();
    m.apply(asst('m1', usage({ create: 800, ttl: '5m' })), { replay: true });
    m.apply({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2', usage: usage({ create: 800, ttl: '5m' }) } }, parent_tool_use_id: null }, { replay: true });
    expect(m.promptCache).toBeUndefined();
    expect(win(m, Date.now())).toEqual({ kind: 'unknown' });
    // Com timestamp na própria mensagem, o replay conta pelo horário dela (e não pelo de agora).
    m.apply(asst('m3', usage({ create: 800, ttl: '5m' }), { timestamp: iso(T0) }), { replay: true });
    expect(m.promptCache).toMatchObject({ messageId: 'm3', anchorAt: T0 });
    expect(win(m, Date.now())).toMatchObject({ kind: 'cold', reason: 'expired' });
  });

  it('replay do mesmo trecho que o transcript já trouxe não bagunça a âncora', () => {
    live();
    vi.setSystemTime(T0 + 2 * MIN);
    const m = new ChatModel();
    m.apply(userMsg('u1', { timestamp: iso(T0) }), { history: true });
    m.apply(asst('m1', usage({ create: 800, ttl: '5m' }), { timestamp: iso(T0 + 25_000) }), { history: true });
    m.apply(asst('m1', usage({ create: 800, ttl: '5m' })), { replay: true }); // buffer do servidor, sem horário
    expect(m.promptCache!.anchorAt).toBe(T0);
  });

  it('compactação (ao vivo) vence o cache; a mensagem seguinte volta a contar', () => {
    live();
    const m = new ChatModel();
    m.addPendingUser('u1', 'oi', [], T0);
    m.apply(asst('m1', usage({ create: 800, ttl: '5m' })));
    vi.setSystemTime(T0 + MIN);
    m.apply({ type: 'system', subtype: 'compact_boundary', uuid: 'cb1' });
    expect(win(m, T0 + MIN)).toMatchObject({ kind: 'cold', reason: 'compacted' });
    vi.setSystemTime(T0 + 2 * MIN);
    m.addPendingUser('u2', 'continua', [], T0 + 2 * MIN);
    m.apply(asst('m2', usage({ create: 300, ttl: '5m' })));
    expect(m.promptCache!.compactedAt).toBeUndefined();
    expect(win(m, T0 + 2 * MIN)).toMatchObject({ kind: 'warm', minutesLeft: 5 });
  });

  it('compactação no transcript: marca pelo timestamp da linha de resumo', () => {
    live();
    vi.setSystemTime(T0 + 10 * MIN);
    const m = new ChatModel();
    m.apply(userMsg('u1', { timestamp: iso(T0) }), { history: true });
    m.apply(asst('m1', usage({ create: 800, ttl: '1h' }), { timestamp: iso(T0 + 10_000) }), { history: true });
    m.apply(userMsg('s1', { timestamp: iso(T0 + 5 * MIN), isCompactSummary: true }), { history: true });
    expect(win(m, Date.now())).toMatchObject({ kind: 'cold', reason: 'compacted' });
  });

  it('CLI/gateway que não informa cache: contador desconhecido, nunca "vencido"', () => {
    live();
    const m = new ChatModel();
    m.addPendingUser('u1', 'oi', [], T0);
    m.apply(asst('m1', { input_tokens: 50_408, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 779, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }));
    expect(m.promptCache?.ttl).toBeUndefined();
    expect(win(m, T0 + 60 * MIN)).toEqual({ kind: 'unknown' });
  });
});
