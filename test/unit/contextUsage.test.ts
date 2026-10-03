import { describe, expect, it } from 'vitest';
import { ChatModel } from '../../src/web/lib/chatModel';
import {
  EMPTY_CONTEXT as EMPTY,
  autoCompactFromResponse,
  compactAction,
  contextAriaLabel,
  contextMeter,
  contextTooltip,
  contextUnknownTooltip,
  effectiveContextWindow,
  isCompactCommand,
  pickModelUsage,
  pieStroke,
  usedTokensOf,
  windowFromModelUsage,
} from '../../src/web/lib/contextUsage';

describe('contextUsage: funções puras', () => {
  it('usedTokensOf soma entrada, cache lido, cache gravado e saída; lixo vira 0', () => {
    expect(usedTokensOf({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 5 })).toBe(1215);
    expect(usedTokensOf({ input_tokens: 7 })).toBe(7);
    expect(usedTokensOf({})).toBe(0);
    expect(usedTokensOf(undefined)).toBe(0);
    expect(usedTokensOf({ input_tokens: 'x', output_tokens: -3, cache_read_input_tokens: NaN })).toBe(0);
  });

  it('effectiveContextWindow: janela − min(saída, 20k) − 13k', () => {
    expect(effectiveContextWindow(1_000_000, 64_000)).toBe(967_000); // saída limitada a 20k
    expect(effectiveContextWindow(200_000, 8_192)).toBe(178_808);
    expect(effectiveContextWindow(200_000, 0)).toBe(187_000); // saída desconhecida: só a folga do compactador
    expect(effectiveContextWindow(0, 0)).toBeLessThanOrEqual(0);
  });

  it('contextMeter: porcentagem sobre a janela útil, limitada a 100; janela desconhecida → undefined', () => {
    const m = contextMeter({ usedTokens: 83_000, contextWindow: 100_000, maxOutputTokens: 4_000 })!; // útil = 83.000
    expect(m.effectiveWindow).toBe(83_000);
    expect(m.percentUsed).toBeCloseTo(100, 5);
    expect(contextMeter({ usedTokens: 60_000, contextWindow: 100_000, maxOutputTokens: 4_000 })!.percentUsed).toBeCloseTo(72.29, 1);
    const over = contextMeter({ usedTokens: 150_000, contextWindow: 100_000, maxOutputTokens: 4_000 })!;
    expect(over.percentUsed).toBe(100);
    expect(over.percentRemaining).toBe(0);
    expect(contextMeter({ usedTokens: 50_000, contextWindow: 0, maxOutputTokens: 0 })).toBeUndefined();
    expect(contextMeter({ usedTokens: 50_000, contextWindow: 10_000, maxOutputTokens: 0 })).toBeUndefined(); // janela menor que a folga
  });

  it('contextMeter com 0 tokens em uso existe: 0% usado, 100% restante, anel vazio (a pizza fica sempre visível)', () => {
    const m = contextMeter({ usedTokens: 0, contextWindow: 113_000, maxOutputTokens: 0 })!; // útil = 100.000
    expect(m.percentUsed).toBe(0);
    expect(m.percentRemaining).toBe(100);
    expect(pieStroke(m.percentUsed).filled).toBe(0);
  });

  it('textos: restante arredondado, dica de compactar e detalhe em tokens', () => {
    const m = contextMeter({ usedTokens: 60_000, contextWindow: 100_000, maxOutputTokens: 4_000 })!;
    const tip = contextTooltip(m);
    // Sem a informação do Claude sobre a compactação automática: base é a janela útil do modelo.
    expect(tip.split('\n')).toEqual([
      'Contexto: 60k de 83k tokens usados (72%).',
      '28% restante da janela útil do modelo.',
      'Janela do modelo: 100k tokens (menos a reserva para a resposta e para o compactador).',
      'Compactação automática: o Claude ainda não informou o valor configurado.',
      'Clique para compactar agora (/compact).',
    ]);
    expect(contextAriaLabel(m)).toBe('72% do contexto usado — clique para compactar');
    const full = contextMeter({ usedTokens: 999_999, contextWindow: 100_000, maxOutputTokens: 4_000 })!;
    expect(contextTooltip(full)).toContain('0% restante da janela útil do modelo');
    // Janela ainda desconhecida: a pizza existe mesmo assim, e a dica diz o que falta saber.
    const none = contextUnknownTooltip({ usedTokens: 0, contextWindow: 0, maxOutputTokens: 0 });
    expect(none.split('\n')[0]).toBe('Contexto: ainda sem dados desta conversa.');
    expect(none).toContain('aparecem quando o próximo turno terminar');
    expect(none.split('\n').at(-1)).toBe('Clique para compactar agora (/compact).');
    expect(contextUnknownTooltip({ usedTokens: 305_191, contextWindow: 0, maxOutputTokens: 0 }).split('\n')[0]).toBe('Contexto: 305k tokens em uso.');
    expect(contextAriaLabel(undefined)).toBe('Uso do contexto ainda desconhecido — clique para compactar');
  });

  it('pieStroke: contorno proporcional, com limites', () => {
    const c = 2 * Math.PI * 7;
    expect(pieStroke(0).filled).toBe(0);
    expect(pieStroke(50).filled).toBeCloseTo(c / 2, 5);
    expect(pieStroke(100).filled).toBeCloseTo(c, 5);
    expect(pieStroke(250).filled).toBeCloseTo(c, 5);
    expect(pieStroke(-5).filled).toBe(0);
    expect(pieStroke(NaN).filled).toBe(0);
  });

  it('pickModelUsage: casa o modelo principal (com ou sem [1m]); entre vários, nunca chuta', () => {
    const mu = { 'sonnet5[1m]': { contextWindow: 1_000_000 }, 'gpt-6-luna[1m]': { contextWindow: 200_000 } };
    // O assistant diz "sonnet5"; o resultado, "sonnet5[1m]".
    expect(pickModelUsage(mu, ['sonnet5'])).toBe(mu['sonnet5[1m]']);
    expect(pickModelUsage(mu, ['sonnet5[1m]'])).toBe(mu['sonnet5[1m]']);
    // Mais recente primeiro: se o primeiro nome não casa, tenta o seguinte.
    expect(pickModelUsage(mu, [undefined, 'desconhecido', 'sonnet5[1m]'])).toBe(mu['sonnet5[1m]']);
    // Vários itens e nenhum casa: não adivinha (o auxiliar poderia ser pego por engano).
    expect(pickModelUsage(mu, ['outro-modelo'])).toBeUndefined();
    expect(pickModelUsage(mu, [])).toBeUndefined();
    // Um item só: é ele.
    const one = { fake: { contextWindow: 5 } };
    expect(pickModelUsage(one, ['outro'])).toBe(one.fake);
    expect(pickModelUsage(one, [])).toBe(one.fake);
    // Igual exato vence o sem sufixo.
    const both = { sonnet5: { contextWindow: 200_000 }, 'sonnet5[1m]': { contextWindow: 1_000_000 } };
    expect(pickModelUsage(both, ['sonnet5'])).toBe(both.sonnet5);
    expect(pickModelUsage(null, ['x'])).toBeUndefined();
    expect(pickModelUsage('lixo', ['x'])).toBeUndefined();
  });

  it('windowFromModelUsage: precisa de janela > 0', () => {
    expect(windowFromModelUsage({ a: { contextWindow: 200_000, maxOutputTokens: 32_000 } }, ['a'])).toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000 });
    expect(windowFromModelUsage({ a: { contextWindow: 200_000 } }, ['a'])).toEqual({ contextWindow: 200_000, maxOutputTokens: 0 });
    expect(windowFromModelUsage({ a: { inputTokens: 5 } }, ['a'])).toBeUndefined();
    expect(windowFromModelUsage({ a: { contextWindow: 0 } }, ['a'])).toBeUndefined();
    expect(windowFromModelUsage(undefined, ['a'])).toBeUndefined();
  });
});

describe('contextUsage: compactação automática definida pelo usuário', () => {
  // Modelo de 1M, compactação em 500k (limite = 500k − min(64k, 20k) − 13k = 467k).
  const resp500 = { totalTokens: 305_000, maxTokens: 500_000, rawMaxTokens: 500_000, autocompactSource: 'env', autoCompactThreshold: 467_000, isAutoCompactEnabled: true };

  it('autoCompactFromResponse: lê janela, limite e origem; sem os campos (Claude Code antigo) → undefined', () => {
    expect(autoCompactFromResponse(resp500)).toEqual({ enabled: true, window: 500_000, threshold: 467_000, source: 'env' });
    expect(autoCompactFromResponse({ ...resp500, autocompactSource: 'settings' })).toMatchObject({ source: 'settings' });
    expect(autoCompactFromResponse({ isAutoCompactEnabled: false, maxTokens: 1_000_000 })).toEqual({ enabled: false });
    // Sem `isAutoCompactEnabled` (versão antiga): não inventa nada.
    expect(autoCompactFromResponse({ totalTokens: 1, maxTokens: 200_000, percentage: 6 })).toBeUndefined();
    expect(autoCompactFromResponse(undefined)).toBeUndefined();
    expect(autoCompactFromResponse('lixo')).toBeUndefined();
    // Ligada mas sem o limite: nada confiável para mostrar.
    expect(autoCompactFromResponse({ isAutoCompactEnabled: true, maxTokens: 500_000, autocompactSource: 'env' })).toBeUndefined();
    // `maxTokens` só vira "janela" quando o Claude informa de onde ela vem.
    expect(autoCompactFromResponse({ isAutoCompactEnabled: true, autoCompactThreshold: 100_000, maxTokens: 123 })).toEqual({ enabled: true, window: undefined, threshold: 100_000, source: undefined });
  });

  it('a porcentagem passa a ser sobre o limite da compactação automática, não sobre a janela do modelo', () => {
    const ac = autoCompactFromResponse(resp500);
    const m = contextMeter({ usedTokens: 305_000, contextWindow: 1_000_000, maxOutputTokens: 64_000, autoCompact: ac })!;
    expect(m.basis).toBe('autocompact');
    expect(m.effectiveWindow).toBe(467_000);
    expect(Math.round(m.percentUsed)).toBe(65); // com a janela do modelo daria 32%
    expect(contextMeter({ usedTokens: 305_000, contextWindow: 1_000_000, maxOutputTokens: 64_000 })!.basis).toBe('model');
    // 250k: limite 217k.
    const m250 = contextMeter({ usedTokens: 108_500, contextWindow: 1_000_000, maxOutputTokens: 64_000, autoCompact: { enabled: true, window: 250_000, threshold: 217_000, source: 'env' } })!;
    expect(m250.percentUsed).toBeCloseTo(50, 5);
    // Acima do limite: trava em 100 (o Claude já está para compactar).
    expect(contextMeter({ usedTokens: 600_000, contextWindow: 1_000_000, maxOutputTokens: 64_000, autoCompact: ac })!.percentUsed).toBe(100);
  });

  it('a compactação automática dá porcentagem mesmo sem saber a janela do modelo (conversa recém-aberta)', () => {
    const ac = autoCompactFromResponse(resp500);
    const m = contextMeter({ usedTokens: 305_000, contextWindow: 0, maxOutputTokens: 0, autoCompact: ac })!;
    expect(m.basis).toBe('autocompact');
    expect(Math.round(m.percentUsed)).toBe(65);
    const tip = contextTooltip(m);
    expect(tip).toContain('Janela do modelo: ainda desconhecida (aparece quando o próximo turno terminar).');
  });

  it('desligada: a base volta a ser a janela do modelo e a dica diz que está desligada', () => {
    const m = contextMeter({ usedTokens: 100_000, contextWindow: 1_000_000, maxOutputTokens: 64_000, autoCompact: { enabled: false } })!;
    expect(m.basis).toBe('model');
    expect(contextTooltip(m)).toContain('Compactação automática: desligada.');
    // Desligada e sem janela do modelo: não há base para a porcentagem.
    expect(contextMeter({ usedTokens: 100_000, contextWindow: 0, maxOutputTokens: 0, autoCompact: { enabled: false } })).toBeUndefined();
  });

  it('dica: mostra as duas coisas, a janela do modelo (1M) e a compactação definida (500k), com a origem', () => {
    const m = contextMeter({ usedTokens: 305_000, contextWindow: 1_000_000, maxOutputTokens: 64_000, autoCompact: autoCompactFromResponse(resp500) })!;
    expect(contextTooltip(m).split('\n')).toEqual([
      'Contexto: 305k de 467k tokens usados (65%).',
      '35% restante até a compactação automática.',
      'Janela do modelo: 1M tokens.',
      'Compactação automática: definida em 500k (variável de ambiente). Compacta em 467k, já descontada a reserva para a resposta e para o compactador.',
      'Clique para compactar agora (/compact).',
    ]);
    expect(contextAriaLabel(m)).toBe('65% do limite de compactação automática usado — clique para compactar');
    const viaSettings = contextMeter({ usedTokens: 1, contextWindow: 1_000_000, maxOutputTokens: 64_000, autoCompact: { enabled: true, window: 400_000, threshold: 367_000, source: 'settings' } })!;
    expect(contextTooltip(viaSettings)).toContain('definida em 400k (configurações do Claude Code)');
    // Padrão do Claude Code (sem o usuário ter definido nada): não finge que foi escolha dele.
    const dflt = contextMeter({ usedTokens: 1, contextWindow: 1_000_000, maxOutputTokens: 64_000, autoCompact: { enabled: true, window: 1_000_000, threshold: 967_000, source: 'model-default' } })!;
    expect(contextTooltip(dflt)).toContain('janela de 1M (padrão do Claude Code)');
    expect(contextTooltip(dflt)).not.toContain('definida em');
  });

  it('dica sem porcentagem: acrescenta a compactação automática quando já se sabe', () => {
    const tip = contextUnknownTooltip({ usedTokens: 0, contextWindow: 0, maxOutputTokens: 0, autoCompact: { enabled: false } });
    expect(tip).toContain('Compactação automática: desligada.');
    expect(contextUnknownTooltip({ usedTokens: 0, contextWindow: 0, maxOutputTokens: 0 })).not.toContain('Compactação automática');
  });

  it('ChatModel: setAutoCompact guarda a informação sem apagar uso nem janela; limpar com undefined', () => {
    const m = new ChatModel();
    m.apply({ type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'sonnet5', content: [{ type: 'text', text: 'oi' }], usage: { input_tokens: 300_000, output_tokens: 5 } }, parent_tool_use_id: null });
    m.apply({ type: 'result', subtype: 'success', is_error: false, uuid: 'r1', total_cost_usd: 0.01, usage: { input_tokens: 1 }, modelUsage: { 'sonnet5[1m]': { contextWindow: 1_000_000, maxOutputTokens: 64_000 } } });
    const v = m.version;
    m.setAutoCompact(autoCompactFromResponse(resp500));
    expect(m.version).toBeGreaterThan(v);
    expect(m.contextUsage).toEqual({ usedTokens: 300_005, contextWindow: 1_000_000, maxOutputTokens: 64_000, autoCompact: { enabled: true, window: 500_000, threshold: 467_000, source: 'env' } });
    // Mensagens e resultados seguintes não perdem a informação.
    m.apply({ type: 'assistant', uuid: 'a2', message: { id: 'm2', model: 'sonnet5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 310_000, output_tokens: 5 } }, parent_tool_use_id: null });
    m.apply({ type: 'system', subtype: 'compact_boundary', uuid: 'cb1' });
    expect(m.contextUsage.autoCompact?.threshold).toBe(467_000);
    expect(m.contextUsage.usedTokens).toBe(0);
    m.setAutoCompact(undefined);
    expect(m.contextUsage.autoCompact).toBeUndefined();
  });
});

describe('contextUsage: ChatModel', () => {
  const usage = (total: number) => ({ input_tokens: total - 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 });
  const asst = (id: string, u: any, extra: any = {}, model = 'sonnet5') => ({ type: 'assistant', uuid: `a-${id}`, message: { id, model, content: [{ type: 'text', text: 'oi' }], usage: u }, parent_tool_use_id: null, ...extra });
  const result = (uuid: string, modelUsage: any) => ({ type: 'result', subtype: 'success', is_error: false, uuid, total_cost_usd: 0.01, usage: usage(10), modelUsage });
  const boundary = (uuid: string) => ({ type: 'system', subtype: 'compact_boundary', uuid });
  const MU = { 'sonnet5[1m]': { contextWindow: 1_000_000, maxOutputTokens: 64_000 }, 'gpt-6-luna[1m]': { contextWindow: 200_000, maxOutputTokens: 32_000 } };

  it('começa vazio: nada a mostrar', () => {
    const m = new ChatModel();
    expect(m.contextUsage).toEqual({ usedTokens: 0, contextWindow: 0, maxOutputTokens: 0 });
    expect(contextMeter(m.contextUsage)).toBeUndefined();
  });

  it('uso vem da última chamada do agente principal (não é soma)', () => {
    const m = new ChatModel();
    m.apply(asst('m1', usage(120_000)));
    m.apply(asst('m2', usage(150_000)));
    expect(m.contextUsage.usedTokens).toBe(150_000);
    // Chamada menor depois (ex.: cache de prompt diferente): vale a última.
    m.apply(asst('m3', usage(90_000)));
    expect(m.contextUsage.usedTokens).toBe(90_000);
  });

  it('subagente, mensagem sintética e uso zerado não mexem no uso', () => {
    const m = new ChatModel();
    m.apply(asst('m1', usage(120_000)));
    m.apply(asst('sub', usage(999_000), { parent_tool_use_id: 'task1' }));
    m.apply(asst('syn', usage(999_000), {}, '<synthetic>'));
    m.apply(asst('zero', { input_tokens: 0, output_tokens: 0 }));
    m.apply(asst('semuso', undefined));
    expect(m.contextUsage.usedTokens).toBe(120_000);
  });

  it('janela vem do resultado, pelo modelo principal (mesmo com [1m] e com modelo auxiliar na lista)', () => {
    const m = new ChatModel();
    m.apply({ type: 'system', subtype: 'init', model: 'sonnet5[1m]', uuid: 'i1' });
    m.apply(asst('m1', usage(500_000)));
    expect(m.contextUsage.contextWindow).toBe(0); // ainda não terminou nenhum turno
    m.apply(result('r1', MU));
    expect(m.contextUsage).toEqual({ usedTokens: 500_000, contextWindow: 1_000_000, maxOutputTokens: 64_000 });
    expect(Math.round(contextMeter(m.contextUsage)!.percentUsed)).toBe(52); // 500k de 967k
  });

  it('trocou de modelo no meio: vale o modelo da última mensagem, não o do init', () => {
    const m = new ChatModel();
    m.apply({ type: 'system', subtype: 'init', model: 'sonnet5[1m]', uuid: 'i1' });
    m.apply(asst('m1', usage(10_000), {}, 'gpt-6-luna')); // agora o principal é outro
    m.apply(result('r1', MU));
    expect(m.contextUsage.contextWindow).toBe(200_000);
  });

  it('resultado sem janela conhecida mantém a anterior; vários modelos sem casar não chutam', () => {
    const m = new ChatModel();
    m.apply(asst('m1', usage(10_000), {}, 'sonnet5'));
    m.apply(result('r1', MU));
    expect(m.contextUsage.contextWindow).toBe(1_000_000);
    m.apply(result('r2', { 'modelo-novo[1m]': {}, 'outro[1m]': {} }));
    m.apply(result('r3', undefined));
    expect(m.contextUsage.contextWindow).toBe(1_000_000);
    const fresh = new ChatModel();
    fresh.apply(asst('x', usage(10_000), {}, 'inexistente'));
    fresh.apply(result('r1', MU));
    expect(fresh.contextUsage.contextWindow).toBe(0);
  });

  it('compactação zera o uso; a próxima chamada volta a contar', () => {
    const m = new ChatModel();
    m.apply(asst('m1', usage(800_000)));
    m.apply(boundary('cb1'));
    expect(m.contextUsage.usedTokens).toBe(0);
    m.apply(asst('m2', usage(6_000)));
    expect(m.contextUsage.usedTokens).toBe(6_000);
  });

  it('compactação pelo resumo do transcript (isCompactSummary) também zera', () => {
    const m = new ChatModel();
    m.apply(asst('m1', usage(800_000)), { history: true });
    m.apply({ type: 'user', uuid: 's1', isCompactSummary: true, message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation. Summary: x' }] }, parent_tool_use_id: null }, { history: true });
    expect(m.contextUsage.usedTokens).toBe(0);
  });

  it('replay (transcript + buffer do servidor repetindo as mesmas mensagens) não bagunça o uso nem desfaz a compactação', () => {
    const m = new ChatModel();
    const seq = [asst('m1', usage(800_000)), boundary('cb1'), asst('m2', usage(6_000))];
    for (const x of seq) m.apply(x, { history: true });
    expect(m.contextUsage.usedTokens).toBe(6_000);
    // O buffer do servidor entrega tudo de novo, na mesma ordem: tudo já visto, nada muda.
    for (const x of seq) m.apply(x, { replay: true });
    expect(m.contextUsage.usedTokens).toBe(6_000);
    // E só a marca de compactação repetida, sozinha, também não zera o que veio depois.
    m.apply(boundary('cb1'), { replay: true });
    expect(m.contextUsage.usedTokens).toBe(6_000);
  });

  it('reabrir pelo transcript: uso vem das mensagens; a janela só depois do primeiro resultado', () => {
    const m = new ChatModel();
    m.apply({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'oi' }, parent_tool_use_id: null }, { history: true });
    m.apply(asst('m1', usage(520_000)), { history: true });
    expect(m.contextUsage).toEqual({ usedTokens: 520_000, contextWindow: 0, maxOutputTokens: 0 });
    expect(contextMeter(m.contextUsage)).toBeUndefined(); // sem janela não há porcentagem (nada de chute): o anel fica vazio
    m.apply(result('r1', { 'sonnet5[1m]': { contextWindow: 1_000_000, maxOutputTokens: 64_000 } }));
    expect(Math.round(contextMeter(m.contextUsage)!.percentUsed)).toBe(54); // 520k de 967k
  });
});

describe('contextUsage: /compact na fila enquanto o Claude trabalha', () => {
  const UUID = '22222222-2222-4222-8222-222222222222';
  const echo = (uuid: string) => ({ type: 'user', uuid, isReplay: true, message: { role: 'user', content: '/compact' }, parent_tool_use_id: null });
  const done = (uuid: string) => ({ type: 'result', subtype: 'success', is_error: false, uuid, total_cost_usd: 0, usage: {}, modelUsage: {} });

  it('isCompactCommand: só o comando /compact, com ou sem instruções', () => {
    expect(isCompactCommand('/compact')).toBe(true);
    expect(isCompactCommand('  /compact  ')).toBe(true);
    expect(isCompactCommand('/compact foque no banco de dados')).toBe(true);
    expect(isCompactCommand('/COMPACT')).toBe(true);
    expect(isCompactCommand('/compactar')).toBe(false);
    expect(isCompactCommand('por favor /compact')).toBe(false);
    expect(isCompactCommand('')).toBe(false);
  });

  it('compactAction: ocioso manda já; trabalhando enfileira; um segundo clique não enfileira outro', () => {
    expect(compactAction(false, null)).toBe('compact');
    expect(compactAction(true, null)).toBe('enqueue');
    expect(compactAction(true, 'queued')).toBe('queued');
    expect(compactAction(true, 'started')).toBe('compacting');
    // Sem turno rodando, "na fila"/"compactando" é resto velho (ex.: interrompido): o clique tem que voltar a funcionar.
    expect(compactAction(false, 'queued')).toBe('compact');
    expect(compactAction(false, 'started')).toBe('compact');
  });

  it('a dica e o rótulo acessível dizem o que o clique faz em cada situação', () => {
    const meter = contextMeter({ usedTokens: 100_000, contextWindow: 1_000_000, maxOutputTokens: 64_000 })!;
    expect(contextTooltip(meter).split('\n').at(-1)).toBe('Clique para compactar agora (/compact).');
    expect(contextTooltip(meter, 'enqueue').split('\n').at(-1)).toBe('O Claude está trabalhando. Clique para deixar o /compact na fila: ele roda quando o Claude terminar.');
    expect(contextTooltip(meter, 'queued').split('\n').at(-1)).toBe('/compact na fila: roda quando o Claude terminar o que está fazendo.');
    expect(contextTooltip(meter, 'compacting').split('\n').at(-1)).toBe('Compactando agora.');
    expect(contextUnknownTooltip(EMPTY, 'queued').split('\n').at(-1)).toBe('/compact na fila: roda quando o Claude terminar o que está fazendo.');
    expect(contextAriaLabel(meter, 'enqueue')).toBe('10% do contexto usado — clique para deixar a compactação na fila');
    expect(contextAriaLabel(meter, 'queued')).toBe('10% do contexto usado — compactação na fila');
    expect(contextAriaLabel(undefined, 'compacting')).toBe('Uso do contexto ainda desconhecido — compactando');
    // Sem o argumento continua como era.
    expect(contextAriaLabel(meter)).toBe('10% do contexto usado — clique para compactar');
  });

  it('ChatModel.compactState: na fila até o eco do CLI, compactando até o fim do turno, depois nada', () => {
    const m = new ChatModel();
    expect(m.compactState()).toBeNull();
    m.addPendingUser('11111111-1111-4111-8111-111111111111', 'faça algo', []); // turno em andamento
    m.addPendingUser(UUID, '/compact', []); // clique na pizza com o Claude ocupado
    expect(m.compactState()).toBe('queued');
    // O turno em andamento termina; o /compact continua esperando o eco do CLI.
    m.apply(done('r1'));
    expect(m.compactState()).toBe('queued');
    // O CLI começou a executá-lo.
    m.apply(echo(UUID));
    expect(m.compactState()).toBe('started');
    // Terminou.
    m.apply(done('r2'));
    expect(m.compactState()).toBeNull();
  });

  it('ChatModel.compactState: mensagem comum na fila, falha de envio e conversa sem /compact não contam', () => {
    const m = new ChatModel();
    m.addPendingUser('33333333-3333-4333-8333-333333333333', 'oi', []);
    expect(m.compactState()).toBeNull();
    m.addPendingUser(UUID, '/compact', []);
    expect(m.compactState()).toBe('queued');
    m.failPendingUser(UUID, 'sem conexão');
    expect(m.compactState()).toBeNull(); // não chegou ao Claude: o clique deve poder tentar de novo
  });

  it('ChatModel.compactState: um /compact novo substitui o anterior (cada clique é acompanhado pelo seu)', () => {
    const m = new ChatModel();
    m.addPendingUser(UUID, '/compact', []);
    m.apply(echo(UUID));
    m.apply(done('r1'));
    expect(m.compactState()).toBeNull();
    const second = '44444444-4444-4444-8444-444444444444';
    m.addPendingUser(second, '/compact foco em testes', []);
    expect(m.compactState()).toBe('queued');
    m.apply(echo(second));
    expect(m.compactState()).toBe('started');
  });
});
