import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ChatModel, costIncreases, formatSentAt, groupChatItems, isSubstantialText, msgTime, parsePartialJson, textRoles, totalInput, visibleUserText, type Item, type ResultItem, type ToolItem } from '../../src/web/lib/chatModel';
import { formatTokens } from '../../src/web/lib/format';

const fixture = fs
  .readFileSync(path.join(__dirname, '../fixtures/stream-sample.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

describe('modelo da conversa (captura real do CLI)', () => {
  it('monta a conversa com texto, pensamento, ferramenta, interrupção e resultados', () => {
    const m = new ChatModel();
    for (const msg of fixture) m.apply(msg);
    const kinds = m.items.map((i) => i.kind);
    expect(kinds.filter((k) => k === 'user')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'result')).toHaveLength(3);
    const texts = m.items.filter((i) => i.kind === 'text').map((i: any) => i.text);
    expect(texts[0]).toBe('hello deck');
    // Nenhum bloco ficou "transmitindo" depois do fim.
    expect(m.items.some((i: any) => i.streaming)).toBe(false);
    // Ferramenta com resultado.
    const tool = m.items.find((i) => i.kind === 'tool') as ToolItem;
    expect(tool.name).toBe('PowerShell');
    expect(tool.input.command).toContain('echo probe-ok');
    expect(tool.result?.text).toBe('probe-ok');
    expect(tool.status).toBe('done');
    // Interrupção vira aviso.
    expect(m.items.some((i) => i.kind === 'notice' && /Interrompido/.test((i as any).text))).toBe(true);
    expect(m.running).toBe(false);
  });

  it('não duplica ao reidratar (transcript + buffer ao vivo)', () => {
    const live = new ChatModel();
    for (const msg of fixture) live.apply(msg);
    // Simula: transcript com as mensagens completas + o mesmo trecho vindo do buffer.
    const transcript = fixture.filter((x) => x.type === 'user' || x.type === 'assistant');
    const re = new ChatModel();
    for (const msg of transcript) re.apply(msg, { history: true });
    for (const msg of fixture) re.apply(msg);
    const count = (mm: ChatModel, k: string) => mm.items.filter((i) => i.kind === k).length;
    expect(count(re, 'user')).toBe(count(live, 'user'));
    expect(count(re, 'text')).toBe(count(live, 'text'));
    expect(count(re, 'tool')).toBe(count(live, 'tool'));
  });

  it('mensagem otimista é confirmada pelo eco (mesmo uuid)', () => {
    const m = new ChatModel();
    const uuid = '8fff4e0c-16ef-44b6-b3fa-450d5ef076cb';
    m.addPendingUser(uuid, 'Reply with exactly: hello deck', []);
    for (const msg of fixture) m.apply(msg);
    const users = m.items.filter((i) => i.kind === 'user');
    expect(users).toHaveLength(3);
    expect((users[0] as any).pending).toBe(false);
  });

  it('pedido de permissão pendente, resposta e cancelamento no fim do turno', () => {
    const m = new ChatModel();
    m.apply({ type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/x', content: 'y' } }] } });
    m.apply({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/x', content: 'y' }, tool_use_id: 't1', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } });
    expect(m.pendingCount).toBe(1);
    const t = m.tools.get('t1')!;
    expect(t.permission?.status).toBe('pending');
    m.answered('r1', 'allowed');
    expect(t.permission?.status).toBe('allowed');
    m.apply({ type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    expect(t.status).toBe('done');
    // Outro pedido que fica pendente e é cancelado no fim do turno
    m.apply({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't2' } });
    m.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'res' });
    expect(m.tools.get('t2')!.permission?.status).toBe('cancelled');
    expect(m.pendingCount).toBe(0);
  });

  it('resultado traz tokens do turno (usage) e da sessão (modelUsage, acumulado)', () => {
    const m = new ChatModel();
    // Valores medidos com o CLI de verdade: turno 2 só tem o que foi novo; modelUsage acumula.
    m.apply({
      type: 'result',
      subtype: 'success',
      uuid: 'r1',
      duration_ms: 2259,
      total_cost_usd: 0.145,
      usage: { input_tokens: 271, cache_creation_input_tokens: 0, cache_read_input_tokens: 25088, output_tokens: 6 },
      modelUsage: {
        a: { inputTokens: 696, outputTokens: 14, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        b: { inputTokens: 25613, outputTokens: 27, cacheReadInputTokens: 25088, cacheCreationInputTokens: 0 },
      },
    });
    const r = m.items.find((i) => i.kind === 'result') as ResultItem;
    expect(r.tokens).toEqual({ input: 271, cacheRead: 25088, cacheCreate: 0, output: 6 });
    expect(totalInput(r.tokens!)).toBe(25359);
    expect(r.sessionTokens).toEqual({ input: 26309, cacheRead: 25088, cacheCreate: 0, output: 41 });
  });

  it('mostra só aumentos observados entre resultados da mesma conversa, nunca o total como preço do turno', () => {
    const result = (key: string, costUsd?: number): ResultItem => ({ kind: 'result', key, subtype: 'success', isError: false, costUsd });
    const items: Item[] = [
      result('retomada', 215.85),
      { kind: 'text', key: 'resposta', text: 'Outra pergunta' },
      result('pergunta', 216.26),
      result('mesmo-total', 216.26),
      result('sem-custo'),
      result('sem-referencia', 217),
      result('invalido', Number.NaN),
      result('ainda-sem-referencia', 218),
      result('reset', 0.25),
      result('apos-reset', 0.3),
    ];
    const increases = costIncreases(items);
    expect(increases.size).toBe(2);
    expect(increases.get('pergunta')).toBeCloseTo(0.41, 8);
    expect(increases.get('apos-reset')).toBeCloseTo(0.05, 8);
    expect(increases.has('retomada')).toBe(false);
    expect(increases.has('sem-referencia')).toBe(false);
    expect(increases.has('reset')).toBe(false);
  });

  it('replay do mesmo resultado não conta como nova resposta nem duplica aumento', () => {
    const m = new ChatModel();
    m.apply({ type: 'result', subtype: 'success', uuid: 'r1', total_cost_usd: 215.85 });
    m.apply({ type: 'result', subtype: 'success', uuid: 'r1', total_cost_usd: 215.85 });
    m.apply({ type: 'result', subtype: 'success', uuid: 'r2', total_cost_usd: 216.26 });
    expect(m.items.filter((i) => i.kind === 'result')).toHaveLength(2);
    expect(costIncreases(m.items).get('result:r2')).toBeCloseTo(0.41, 8);
  });

  it('formatTokens: abrevia em k e M, com vírgula decimal', () => {
    expect(formatTokens(6)).toBe('6');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(25359)).toBe('25,4k');
    expect(formatTokens(250000)).toBe('250k');
    expect(formatTokens(1_250_000)).toBe('1,3M');
  });

  it('resultado sem usage (ou vazio) não inventa tokens', () => {
    const m = new ChatModel();
    m.apply({ type: 'result', subtype: 'success', uuid: 'r1', usage: {}, modelUsage: {} });
    m.apply({ type: 'result', subtype: 'success', uuid: 'r2' });
    for (const r of m.items.filter((i) => i.kind === 'result') as ResultItem[]) {
      expect(r.tokens).toBeUndefined();
      expect(r.sessionTokens).toBeUndefined();
    }
  });

  it('textRoles: comentário no meio do trabalho x resposta final, por turno', () => {
    const t = (key: string): Item => ({ kind: 'text', key, text: key });
    const tool = (key: string): Item => ({ kind: 'tool', key, id: key, name: 'Bash', input: {}, status: 'done', children: [] });
    const think = (key: string, text = 'hum'): Item => ({ kind: 'thinking', key, text });
    const user = (key: string): Item => ({ kind: 'user', key, text: key, images: [] });
    const result = (key: string): Item => ({ kind: 'result', key, subtype: 'success', isError: false });
    const items: Item[] = [
      // Turno 1: só uma resposta → sem destaque.
      user('u1'), t('a1'), result('r1'),
      // Turno 2: raciocínio, comentário, ferramenta, comentário, ferramenta, resposta.
      user('u2'), think('th1'), t('c1'), tool('t1'), t('c2'), tool('t2'), t('final2'), result('r2'),
      // Turno 3: raciocínio vazio não conta como trabalho.
      user('u3'), think('th2', '   '), t('a3'), result('r3'),
      // Turno 4: ainda em andamento (sem resultado): o texto depois da última ferramenta já é a resposta.
      user('u4'), tool('t3'), t('parcial'),
    ];
    const roles = textRoles(items);
    expect(roles.get('a1')).toBe('plain');
    expect(roles.get('c1')).toBe('step');
    expect(roles.get('c2')).toBe('step');
    expect(roles.get('final2')).toBe('final');
    expect(roles.get('a3')).toBe('plain');
    expect(roles.get('parcial')).toBe('final');
  });

  it('isSubstantialText: texto longo, ou médio com lista/título, é conteúdo; comentário de passo não', () => {
    expect(isSubstantialText('Vou ler o arquivo de configuração agora.')).toBe(false);
    expect(isSubstantialText('   ')).toBe(false);
    expect(isSubstantialText('x'.repeat(399))).toBe(false);
    expect(isSubstantialText('x'.repeat(400))).toBe(true);
    // Médio (>= 160) com 3+ linhas de lista/título/tabela/código conta; com 2 não; curto nunca.
    const filler = 'Detalhe do achado com contexto suficiente para passar do mínimo de tamanho. '.repeat(3); // ~230 chars: acima de 160, abaixo de 400
    expect(isSubstantialText(`${filler}\n- um\n- dois\n- três`)).toBe(true);
    expect(isSubstantialText(`## Achados\n${filler}\n1. um\n2. dois`)).toBe(true);
    expect(isSubstantialText(`${filler}\n- um\n- dois`)).toBe(false);
    expect(isSubstantialText('- a\n- b\n- c')).toBe(false);
  });

  it('textRoles: resposta longa seguida de ferramenta de registro e fecho curto não some na cadeia', () => {
    const t = (key: string, text = key): Item => ({ kind: 'text', key, text });
    const tool = (key: string): Item => ({ kind: 'tool', key, id: key, name: 'Bash', input: {}, status: 'done', children: [] });
    const think = (key: string): Item => ({ kind: 'thinking', key, text: 'hum' });
    const user = (key: string): Item => ({ kind: 'user', key, text: key, images: [] });
    const result = (key: string): Item => ({ kind: 'result', key, subtype: 'success', isError: false });
    const diagnostico = `Diagnóstico dos dois casos.\n\n1. Primeiro caso: ${'explicação detalhada '.repeat(25)}\n2. Segundo caso: ${'mais detalhes '.repeat(20)}\n\nQuer que eu siga pelo item 1?`;

    // O caso real: lê/pensa → diagnóstico → Bash de log → fecho curto.
    const items: Item[] = [
      user('u1'), think('th1'), t('lendo', 'Vou ler o arquivo.'), tool('t1'),
      t('diag', diagnostico), tool('log'), t('fecho', 'Registrei a conclusão no log.'), result('r1'),
    ];
    const roles = textRoles(items);
    expect(roles.get('lendo')).toBe('step'); // comentário curto continua na cadeia
    expect(roles.get('diag')).toBe('plain'); // texto com substância fica visível, sem rótulo "Resposta"
    expect(roles.get('fecho')).toBe('final');

    // A cadeia se parte em volta do diagnóstico: o que veio antes e o log depois ficam recolhidos.
    const blocks = groupChatItems(items, roles);
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'workgroup', 'text', 'tool', 'text', 'result']);
    expect((blocks[1] as any).items.map((i: Item) => i.key)).toEqual(['th1', 'lendo', 't1']);
    expect((blocks[2] as Item).key).toBe('diag');
  });

  it('recusa do usuário marca a ferramenta como negada', () => {
    const m = new ChatModel();
    m.apply({ type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }] } });
    m.apply({ type: 'user', uuid: 'u1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } });
    expect(m.tools.get('t1')!.status).toBe('denied');
  });

  it('mensagens de subagente ficam dentro da ferramenta Task', () => {
    const m = new ChatModel();
    m.apply({ type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'x' } }] } });
    m.apply({ type: 'assistant', uuid: 'a2', parent_tool_use_id: 'task1', message: { id: 'm2', content: [{ type: 'tool_use', id: 'sub1', name: 'Read', input: { file_path: '/a' } }] } });
    m.apply({ type: 'user', uuid: 'u1', parent_tool_use_id: 'task1', message: { content: [{ type: 'tool_result', tool_use_id: 'sub1', content: 'conteúdo' }] } });
    const task = m.tools.get('task1')!;
    expect(task.children).toHaveLength(1);
    expect((task.children[0] as ToolItem).status).toBe('done');
    expect(m.items.filter((i) => i.kind === 'tool')).toHaveLength(1);
  });

  it('limpa tags de contexto e mostra comandos', () => {
    expect(visibleUserText('<system-reminder>x</system-reminder>oi').text).toBe('oi');
    expect(visibleUserText('<command-name>/compact</command-name><command-args>foco</command-args>').text).toBe('/compact foco');
  });

  it('lê JSON parcial da entrada de ferramentas', () => {
    expect(parsePartialJson('{"file_path":"/a/b","content":"linha 1\\nli')).toEqual({ file_path: '/a/b', content: 'linha 1\nli' });
    expect(parsePartialJson('{"a":[1,2')).toEqual({ a: [1, 2] });
    expect(parsePartialJson('')).toEqual({});
  });

  it('diferencia mensagens do usuário de instruções de skill e avisos de hook', () => {
    const m = new ChatModel();
    // 1. Mensagem real digitada pelo usuário
    m.apply({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'chamado #123' }] } });
    const u1 = m.items[0] as any;
    expect(u1.source).toBe('user');

    // 2. Claude invoca uma Skill
    m.apply({ type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'zabbix-coleta' } }] } });
    m.apply({ type: 'user', uuid: 'u_res', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'ok' }] } });

    // 3. O CLI injeta as instruções do playbook da skill como próximo user message
    m.apply({ type: 'user', uuid: 'u_skill', message: { content: [{ type: 'text', text: 'Trate o chamado de monitoramento de: 123' }] } });
    const uSkill = m.items.find((i) => i.key === 'user:u_skill') as any;
    expect(uSkill.source).toBe('skill');
    expect(uSkill.skillName).toBe('zabbix-coleta');

    // 4. Hook feedback injetado pelo CLI
    m.apply({ type: 'user', uuid: 'u_hook', message: { content: [{ type: 'text', text: 'Stop hook feedback:\nAntes de encerrar feche a demanda' }] } });
    const uHook = m.items.find((i) => i.key === 'user:u_hook') as any;
    expect(uHook.source).toBe('hook');

    // 5. Notificação de subagente finalizado (<task-notification>)
    const taskXml = `<task-notification>
<task-id>task-123</task-id>
<status>completed</status>
<summary>Agent "Reconciliar compliance" finished</summary>
<result>Chamado #36582 — análise concluída.</result>
</task-notification>`;
    m.apply({ type: 'user', uuid: 'u_task', message: { content: [{ type: 'text', text: taskXml }] } });
    const uTask = m.items.find((i) => i.key === 'user:u_task') as any;
    expect(uTask.source).toBe('task');
    expect(uTask.taskNotification?.summary).toBe('Agent "Reconciliar compliance" finished');
    expect(uTask.text).toBe('Chamado #36582 — análise concluída.');
  });

  it('mensagem de outro agente (<agent-message>) vira cartão automático, não fala do usuário', () => {
    const m = new ChatModel();
    const body = 'Read-only checkout search: Worker source NOT present.\nMP webhook HMAC: CONTEXTO:94-125.';
    m.apply({ type: 'user', uuid: 'ag1', message: { content: [{ type: 'text', text: `<agent-message from="aa99c95b6358f7bdc">\n${body}\n</agent-message>` }] } });
    const a = m.items.find((i) => i.key === 'user:ag1') as any;
    expect(a.source).toBe('agent');
    expect(a.agentMessages).toEqual([{ kind: 'agent', from: 'aa99c95b6358f7bdc', body }]);
    expect(a.text).toBe(body);
    expect(a.text).not.toContain('<agent-message');

    // Também como texto simples (não em lista de blocos) e com várias mensagens juntas.
    m.apply({ type: 'user', uuid: 'ag2', message: { content: '<agent-message from="a1">um</agent-message>\n<agent-message from="b2">dois</agent-message>' } });
    const b = m.items.find((i) => i.key === 'user:ag2') as any;
    expect(b.source).toBe('agent');
    expect(b.agentMessages.map((x: any) => `${x.from}:${x.body}`)).toEqual(['a1:um', 'b2:dois']);

    // Sem o atributo `from` também vale.
    m.apply({ type: 'user', uuid: 'ag3', message: { content: '<agent-message>sem remetente</agent-message>' } });
    expect((m.items.find((i) => i.key === 'user:ag3') as any).agentMessages).toEqual([{ kind: 'agent', from: undefined, body: 'sem remetente' }]);
  });

  it('mensagem de outra sessão (com a frase do CLI e o nome em origin) também vira cartão', () => {
    const m = new ChatModel();
    const from = 'uds:/run/user/1000/cc-socks/845127.sock';
    m.apply({
      type: 'user',
      uuid: 'cs1',
      isSynthetic: true,
      origin: { kind: 'peer', from, name: 'smart-ia-06' },
      message: { content: `Another Claude session sent a message while you were working:\n<cross-session-message from="${from}">\nterminei a coleta\n</cross-session-message>` },
    });
    const c = m.items.find((i) => i.key === 'user:cs1') as any;
    expect(c.source).toBe('agent');
    expect(c.agentMessages).toEqual([{ kind: 'session', from, name: 'smart-ia-06', body: 'terminei a coleta' }]);
    expect(c.text).toBe('terminei a coleta');

    // No transcript a mesma mensagem vem como isMeta: continua aparecendo (como cartão), não some.
    const h = new ChatModel();
    h.apply({ type: 'user', uuid: 'cs2', isMeta: true, message: { content: [{ type: 'text', text: '<agent-message from="a77">achei o arquivo</agent-message>' }] } }, { history: true });
    const hc = h.items.find((i) => i.key === 'user:cs2') as any;
    expect(hc.source).toBe('agent');
    expect(hc.text).toBe('achei o arquivo');
    // Outras mensagens isMeta continuam escondidas.
    h.apply({ type: 'user', uuid: 'meta1', isMeta: true, message: { content: 'contexto interno' } }, { history: true });
    expect(h.items.some((i) => i.key === 'user:meta1')).toBe(false);
  });

  it('resumo do /compact AO VIVO (só isSynthetic) vira a marca de compactação, não bolha do usuário', () => {
    const summary = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request...';
    const m = new ChatModel();
    m.apply({ type: 'user', uuid: 'u0', message: { content: 'oi' } });
    m.apply({ type: 'system', subtype: 'compact_boundary', uuid: 'cb1' });
    m.apply({ type: 'user', uuid: 'sum1', isSynthetic: true, parent_tool_use_id: null, message: { content: [{ type: 'text', text: summary }] } });
    const users = m.items.filter((i) => i.kind === 'user') as any[];
    expect(users.map((u) => u.text)).toEqual(['oi']);
    const compacts = m.items.filter((i) => i.kind === 'compact') as any[];
    expect(compacts).toHaveLength(1);
    expect(compacts[0].summary).toBe(summary);

    // Resumo sem marca antes (chegou só ele): cria a marca com o resumo.
    const s = new ChatModel();
    s.apply({ type: 'user', uuid: 'sum2', isSynthetic: true, message: { content: summary } });
    expect(s.items.map((i) => i.kind)).toEqual(['compact']);
    expect((s.items[0] as any).summary).toBe(summary);
  });

  it('resumo do /compact no HISTÓRICO (isCompactSummary) continua indo para a marca', () => {
    const summary = 'This session is being continued from a previous conversation...\nSummary: x';
    const m = new ChatModel();
    m.apply({ type: 'system', subtype: 'compact_boundary', uuid: 'cb1' }, { history: true });
    m.apply({ type: 'user', uuid: 's1', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: summary } }, { history: true });
    expect(m.items.map((i) => i.kind)).toEqual(['compact']);
    expect((m.items[0] as any).summary).toBe(summary);
    // Depois de reidratar, o eco ao vivo da mesma marca e do mesmo resumo (mesmos uuids) não duplica.
    m.apply({ type: 'system', subtype: 'compact_boundary', uuid: 'cb1' });
    m.apply({ type: 'user', uuid: 's1', isSynthetic: true, message: { content: summary } });
    expect(m.items.filter((i) => i.kind === 'compact')).toHaveLength(1);
  });

  it('texto que o usuário digita começando igual ao resumo (sem isSynthetic) continua sendo dele', () => {
    const m = new ChatModel();
    m.apply({ type: 'user', uuid: 'u1', message: { content: 'This session is being continued from a previous conversation? o que isso quer dizer' } });
    const u = m.items[0] as any;
    expect(u.kind).toBe('user');
    expect(u.source).toBe('user');
  });

  it('outras mensagens sintéticas do CLI viram cartão automático (não bolha do usuário)', () => {
    const m = new ChatModel();
    m.apply({ type: 'user', uuid: 'syn1', isSynthetic: true, message: { content: '[Your previous response had no visible output. Continue.]' } });
    const a = m.items.find((i) => i.key === 'user:syn1') as any;
    expect(a.source).toBe('auto');
    // Instruções de skill reconhecidas pelo cabeçalho, mesmo sem a ferramenta Skill logo antes.
    m.apply({ type: 'user', uuid: 'syn2', isSynthetic: true, message: { content: 'Base directory for this skill: C:\\Users\\usuario\\.claude\\skills\\exemplo-coleta\n\n# Exemplo' } });
    const s = m.items.find((i) => i.key === 'user:syn2') as any;
    expect(s.source).toBe('skill');
    expect(s.skillName).toBe('exemplo-coleta');
  });

  it('mensagem do usuário guarda a data/hora do envio (clique, transcript ou eco do CLI)', () => {
    const m = new ChatModel();
    // Enviada por esta janela: vale o momento do clique, mesmo que o eco traga outro horário.
    const click = Date.parse('2026-09-30T14:32:05Z');
    m.addPendingUser('11111111-1111-4111-8111-111111111111', 'oi', [], click);
    m.apply({ type: 'user', uuid: '11111111-1111-4111-8111-111111111111', isReplay: true, timestamp: '2026-09-30T14:32:09Z', message: { content: 'oi' } });
    expect((m.items[0] as any).at).toBe(click);
    expect((m.items[0] as any).pending).toBe(false);
    // Histórico / outra janela: vale o timestamp do CLI.
    m.apply({ type: 'user', uuid: 'h1', timestamp: '2026-09-29T08:05:00.000Z', message: { content: 'de ontem' } }, { history: true });
    expect((m.items.find((i) => i.key === 'user:h1') as any).at).toBe(Date.parse('2026-09-29T08:05:00.000Z'));
    // Sem timestamp (CLI antigo): sem data, nada inventado.
    m.apply({ type: 'user', uuid: 'h2', message: { content: 'sem hora' } });
    expect((m.items.find((i) => i.key === 'user:h2') as any).at).toBeUndefined();
    m.apply({ type: 'user', uuid: 'h3', timestamp: 'lixo', message: { content: 'hora inválida' } });
    expect((m.items.find((i) => i.key === 'user:h3') as any).at).toBeUndefined();
  });

  it('formatSentAt mostra dia/mês e hora local; o ano só quando não é o atual', () => {
    const at = new Date(2026, 8, 30, 9, 5).getTime();
    expect(formatSentAt(at, new Date(2026, 11, 31).getTime())).toBe('30/09 às 09:05');
    expect(formatSentAt(at, new Date(2027, 0, 1).getTime())).toBe('30/09/2026 às 09:05');
    expect(msgTime({ timestamp: '2026-09-30T12:00:00Z' })).toBe(Date.parse('2026-09-30T12:00:00Z'));
    expect(msgTime({})).toBeUndefined();
  });

  it('texto do usuário que só CITA <agent-message> continua sendo do usuário', () => {
    const m = new ChatModel();
    m.apply({ type: 'user', uuid: 'q1', message: { content: [{ type: 'text', text: 'por que aparece <agent-message from="x">oi</agent-message> na tela?' }] } });
    const q = m.items.find((i) => i.key === 'user:q1') as any;
    expect(q.source).toBe('user');
    expect(q.text).toContain('<agent-message');
    expect(q.agentMessages).toBeUndefined();
  });

  it('groupChatItems agrupa cadeia de pensamento e execuções em workgroup', () => {
    const t = (key: string): Item => ({ kind: 'text', key, text: key });
    const tool = (key: string): Item => ({ kind: 'tool', key, id: key, name: 'Bash', input: {}, status: 'done', children: [] });
    const think = (key: string): Item => ({ kind: 'thinking', key, text: 'pensando' });
    const user = (key: string): Item => ({ kind: 'user', key, text: key, images: [] });
    const result = (key: string): Item => ({ kind: 'result', key, subtype: 'success', isError: false });

    // 1. Turno com cadeia completa: pensamento + passo + ferramenta + passo + ferramenta -> resposta
    const chainItems: Item[] = [user('u1'), think('th1'), t('step1'), tool('tool1'), t('step2'), tool('tool2'), t('final'), result('r1')];
    const roles1 = textRoles(chainItems);
    const blocks1 = groupChatItems(chainItems, roles1);
    expect(blocks1.map((b) => b.kind)).toEqual(['user', 'workgroup', 'text', 'result']);
    const wg = blocks1[1] as any;
    expect(wg.items).toHaveLength(5); // th1, step1, tool1, step2, tool2

    // 2. Turno com ferramenta única sem raciocínio: não encapsula, deixa direto
    const singleItems: Item[] = [user('u2'), tool('toolOnly'), t('final2'), result('r2')];
    const roles2 = textRoles(singleItems);
    const blocks2 = groupChatItems(singleItems, roles2);
    expect(blocks2.map((b) => b.kind)).toEqual(['user', 'tool', 'text', 'result']);

    // 3. Turno sem ferramentas nem raciocínio: resposta direta
    const plainItems: Item[] = [user('u3'), t('resposta'), result('r3')];
    const roles3 = textRoles(plainItems);
    const blocks3 = groupChatItems(plainItems, roles3);
    expect(blocks3.map((b) => b.kind)).toEqual(['user', 'text', 'result']);
  });

  it('groupChatItems solta do grupo o que espera resposta (pergunta/permissão) e devolve depois de respondido', () => {
    const tool = (key: string, name = 'Bash', pending = false, children: Item[] = []): ToolItem =>
      ({ kind: 'tool', key, id: key, name, input: {}, status: 'running', children, permission: pending ? { status: 'pending' } : undefined }) as any;
    const think = (key: string): Item => ({ kind: 'thinking', key, text: 'pensando' });
    const user = (key: string): Item => ({ kind: 'user', key, text: key, images: [] });
    const kinds = (items: Item[]) => groupChatItems(items, textRoles(items));

    // Pergunta pendente no fim da cadeia: o grupo fica recolhido com o que veio antes, a pergunta fica solta.
    const ask = tool('ask', 'AskUserQuestion', true);
    const waiting: Item[] = [user('u1'), think('th1'), tool('t1'), ask];
    const b1 = kinds(waiting);
    expect(b1.map((b) => b.kind)).toEqual(['user', 'workgroup', 'tool']);
    expect((b1[1] as any).items.map((i: Item) => i.key)).toEqual(['th1', 't1']);
    expect(b1[2]).toBe(ask);

    // Só a pergunta depois do raciocínio: 1 item antes vira bloco solto, a pergunta também.
    expect(kinds([user('u2'), think('th2'), tool('ask2', 'AskUserQuestion', true)]).map((b) => b.kind)).toEqual(['user', 'thinking', 'tool']);

    // Pendência dentro de um subagente também sobe para fora do grupo.
    const agent = tool('agent', 'Agent', false, [tool('inner', 'Bash', true)]);
    const b2 = kinds([user('u3'), think('th3'), tool('t3'), agent]);
    expect(b2.map((b) => b.kind)).toEqual(['user', 'workgroup', 'tool']);
    expect(b2[2]).toBe(agent);

    // Depois de respondida, volta para dentro da cadeia (mesma chave de grupo, o estado aberto/fechado se mantém).
    (ask.permission as any).status = 'allowed';
    const b3 = kinds(waiting);
    expect(b3.map((b) => b.kind)).toEqual(['user', 'workgroup']);
    expect((b3[1] as any).items.map((i: Item) => i.key)).toEqual(['th1', 't1', 'ask']);
    expect((b3[1] as any).key).toBe((b1[1] as any).key);
  });
});

describe('agentes em execução (indicador ao lado do modelo)', () => {
  const launch = (id: string, input: any = { description: 'Procurar X', subagent_type: 'Explore' }, at?: string) => ({
    type: 'assistant',
    uuid: `a-${id}`,
    timestamp: at,
    message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Agent', input }] },
  });
  const back = (id: string, structured?: any) => ({
    type: 'user',
    uuid: `r-${id}`,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    tool_use_result: structured,
  });
  const notify = (taskId: string, toolUseId?: string) => ({
    type: 'user',
    uuid: `n-${taskId}`,
    message: { content: `<task-notification>\n<task-id>${taskId}</task-id>\n${toolUseId ? `<tool-use-id>${toolUseId}</tool-use-id>\n` : ''}<status>completed</status>\n<summary>fim</summary>\n</task-notification>` },
  });

  it('subagente em primeiro plano conta enquanto roda e some quando a chamada volta', () => {
    const m = new ChatModel();
    m.apply(launch('t1'));
    m.apply(launch('t2', { description: 'Outro', subagent_type: 'general-purpose' }));
    expect(m.runningAgents().map((a) => [a.id, a.type, a.description, a.background])).toEqual([
      ['t1', 'Explore', 'Procurar X', false],
      ['t2', 'general-purpose', 'Outro', false],
    ]);
    m.apply(back('t1'));
    expect(m.runningAgents().map((a) => a.id)).toEqual(['t2']);
    m.apply(back('t2'));
    expect(m.runningAgents()).toEqual([]);
  });

  it('em segundo plano continua contando depois da chamada voltar, até o aviso de fim', () => {
    const m = new ChatModel();
    m.apply(launch('t1', { description: 'Escrever guias', run_in_background: true }));
    m.apply(back('t1', { status: 'async_launched', agentId: 'agent-1', description: 'Escrever guias' }));
    m.apply({ type: 'result', subtype: 'success', uuid: 'res1' }); // o turno acaba, o agente segue
    expect(m.runningAgents()).toHaveLength(1);
    expect(m.runningAgents()[0].background).toBe(true);
    m.apply(notify('agent-1', 't1'));
    expect(m.runningAgents()).toEqual([]);
  });

  it('eventos de tarefa do CLI (task_started/notification/updated) contam e descontam; comando em segundo plano não é agente', () => {
    const m = new ChatModel();
    m.apply({ type: 'system', subtype: 'task_started', task_id: 'k1', tool_use_id: 'x1', description: 'Explorar', subagent_type: 'Explore', task_type: 'local_agent', is_backgrounded: true });
    m.apply({ type: 'system', subtype: 'task_started', task_id: 'k2', description: 'npm run build', task_type: 'local_bash', is_backgrounded: true });
    m.apply({ type: 'system', subtype: 'task_started', task_id: 'k3', description: 'housekeeping', task_type: 'local_agent', ambient: true });
    m.apply({ type: 'system', subtype: 'task_started', task_id: 'k4', description: 'Revisar', subagent_type: 'general-purpose', task_type: 'local_agent', is_backgrounded: true });
    expect(m.runningAgents().map((a) => a.description)).toEqual(['Explorar', 'Revisar']);
    // O comando em segundo plano não conta como agente, mas aparece no mapa como tarefa.
    expect(m.agentMap().map((a) => [a.description, a.kind, a.status])).toEqual([['Explorar', 'agent', 'working'], ['Revisar', 'agent', 'working'], ['npm run build', 'task', 'working']]);
    m.apply({ type: 'system', subtype: 'task_notification', task_id: 'k1', tool_use_id: 'x1', status: 'completed', summary: 'ok' });
    expect(m.runningAgents().map((a) => a.description)).toEqual(['Revisar']);
    m.apply({ type: 'system', subtype: 'task_updated', task_id: 'k4', patch: { status: 'killed' } });
    expect(m.runningAgents()).toEqual([]);
    // Terminados ficam no mapa com o estado final; o mais recente primeiro.
    expect(m.agentMap().map((a) => [a.description, a.status])).toEqual([['npm run build', 'working'], ['Revisar', 'killed'], ['Explorar', 'completed']]);
  });

  it('nome, modelo resolvido e pedido completo vêm do agente, não do modelo da conversa', () => {
    const m = new ChatModel();
    const prompt = 'Leia os arquivos de configuração, identifique a causa e reporte com evidências.\nNão edite nada.';
    m.apply({ ...launch('t1', { description: 'Investigar erro', subagent_type: 'Explore', prompt, run_in_background: true }), message: { id: 'm-t1', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Investigar erro', subagent_type: 'Explore', prompt, run_in_background: true } }] } });
    expect(m.runningAgents()[0]).toMatchObject({ description: 'Investigar erro', type: 'Explore', prompt });
    expect(m.runningAgents()[0].model).toBeUndefined(); // o modelo do pai não é o do filho
    m.apply(back('t1', { status: 'async_launched', agentId: 'agent-1', resolvedModel: 'claude-sonnet-5', modelsUsed: ['claude-haiku-4-5', 'claude-sonnet-5'] }));
    expect(m.runningAgents()[0]).toMatchObject({ model: 'claude-sonnet-5', models: ['claude-haiku-4-5', 'claude-sonnet-5'], prompt });
  });

  it('agente em primeiro plano revela modelo na primeira mensagem do próprio subagente', () => {
    const m = new ChatModel();
    m.apply(launch('t1', { description: 'Revisar', subagent_type: 'code-reviewer', prompt: 'Revise a migração' }));
    m.apply({ type: 'assistant', uuid: 'child-1', parent_tool_use_id: 't1', message: { id: 'child-m1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Revisando' }] } });
    expect(m.runningAgents()[0]).toMatchObject({ model: 'claude-haiku-4-5', prompt: 'Revise a migração' });
  });

  it('mapa mantém agentes em primeiro plano, falhas e modelos depois do retorno, inclusive ao reidratar', () => {
    const m = new ChatModel();
    m.apply(launch('ok', { description: 'Concluiu', subagent_type: 'Explore' }), { history: true });
    m.apply(back('ok', { agentId: 'a-ok', resolvedModel: 'claude-haiku-4-5', modelsUsed: ['claude-haiku-4-5'] }), { history: true });
    m.apply(launch('erro', { description: 'Falhou', subagent_type: 'Explore', run_in_background: true }));
    m.apply({ ...back('erro'), message: { content: [{ type: 'tool_result', tool_use_id: 'erro', content: 'Falha ao iniciar', is_error: true }] } });
    expect(m.runningAgents()).toEqual([]);
    expect(m.agentMap().map((a) => [a.description, a.status])).toEqual([['Falhou', 'failed'], ['Concluiu', 'completed']]);
    expect(m.agentMap()[1]).toMatchObject({ agentId: 'a-ok', model: 'claude-haiku-4-5', models: ['claude-haiku-4-5'] });
  });

  it('o id de parar é o da tarefa; o de ler é o agentId do transcript', () => {
    const m = new ChatModel();
    m.apply(launch('tool1', { description: 'X', run_in_background: true }));
    m.apply({ type: 'system', subtype: 'task_started', task_id: 'task1', tool_use_id: 'tool1', task_type: 'local_agent', is_backgrounded: true });
    m.apply(back('tool1', { status: 'async_launched', agentId: 'agent1' }));
    expect(m.agentMap()).toHaveLength(1);
    expect(m.agentMap()[0]).toMatchObject({ taskId: 'task1', agentId: 'agent1' });
    m.apply({ type: 'system', subtype: 'task_updated', task_id: 'task1', patch: { status: 'killed' } });
    expect(m.agentMap()).toHaveLength(1);
    expect(m.agentMap()[0]).toMatchObject({ id: 'tool1', taskId: 'task1', agentId: 'agent1', status: 'killed' });
  });

  it('evento task_started sem ferramenta informa o pedido mesmo sem modelo conhecido', () => {
    const m = new ChatModel();
    m.apply({ type: 'system', subtype: 'task_started', task_id: 'k1', description: 'Revisar', subagent_type: 'Explore', task_type: 'local_agent', prompt: 'Leia src/app.ts', is_backgrounded: true });
    expect(m.runningAgents()).toEqual([{ id: 'k1', taskId: 'k1', agentId: 'k1', kind: 'agent', status: 'working', description: 'Revisar', type: 'Explore', prompt: 'Leia src/app.ts', model: undefined, models: undefined, background: true }]);
  });

  it('o mesmo agente anunciado pelo CLI e visto como ferramenta conta uma vez só', () => {
    const m = new ChatModel();
    m.apply(launch('t1'));
    m.apply({ type: 'system', subtype: 'task_started', task_id: 'k1', tool_use_id: 't1', description: 'Procurar X', subagent_type: 'Explore', task_type: 'local_agent' });
    expect(m.runningAgents()).toHaveLength(1);
    m.apply(back('t1')); // primeiro plano que voltou: fim
    expect(m.runningAgents()).toEqual([]);
  });

  it('interromper o turno encerra os subagentes em primeiro plano', () => {
    const m = new ChatModel();
    m.apply(launch('t1'));
    m.apply({ type: 'result', subtype: 'error_during_execution', uuid: 'res1' });
    expect(m.runningAgents()).toEqual([]);
  });

  it('agente em segundo plano só visto no transcript não conta (pode ser de um processo morto), a não ser que tenha sido lançado depois da partida atual', () => {
    const m = new ChatModel();
    const now = Date.now();
    const launchedAt = new Date(now - 10 * 60 * 1000).toISOString();
    m.apply(launch('t1', { description: 'Antigo', run_in_background: true }, launchedAt), { history: true });
    m.apply(back('t1', { status: 'async_launched', agentId: 'agent-1' }), { history: true });
    expect(m.runningAgents()).toEqual([]); // sem saber quando o processo começou
    expect(m.runningAgents(now)).toEqual([]); // processo mais novo que o agente
    expect(m.runningAgents(now - 20 * 60 * 1000)).toHaveLength(1); // processo anterior ao lançamento
    m.apply(notify('agent-1', 't1'), { history: true });
    expect(m.runningAgents(now - 20 * 60 * 1000)).toEqual([]);
  });

  it('recarregar a janela: o que veio do transcript e chega de novo ao vivo passa a contar', () => {
    const m = new ChatModel();
    m.apply(launch('t1', { description: 'X', run_in_background: true }), { history: true });
    m.apply(back('t1', { status: 'async_launched', agentId: 'agent-1' }), { history: true });
    expect(m.runningAgents()).toEqual([]);
    m.apply(launch('t1', { description: 'X', run_in_background: true })); // o buffer ao vivo traz a mesma chamada
    expect(m.runningAgents()).toHaveLength(1);
  });

  it('applyAgentTranscript adiciona ferramentas filhas do transcrito do subagente', () => {
    const m = new ChatModel();
    m.apply(launch('t1', { description: 'Revisar', run_in_background: true }));
    m.apply(back('t1', { status: 'async_launched', agentId: 'agent-1' }));
    const tool = m.tools.get('t1')!;
    expect(tool.children).toHaveLength(0);

    const changed = m.applyAgentTranscript('t1', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'child-1', name: 'Bash', input: { command: 'git diff' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'child-1', content: 'diff content' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'child-2', name: 'Read', input: { file_path: 'src/app.ts' } }] } },
    ]);
    expect(changed).toBe(true);
    expect(tool.children).toHaveLength(2);
    expect(tool.children[0]).toMatchObject({ id: 'child-1', name: 'Bash', status: 'done' });
    expect(tool.children[1]).toMatchObject({ id: 'child-2', name: 'Read', status: 'running' });
  });

  it('applyAgentTranscript com evento de resultado encerra o agente', () => {
    const m = new ChatModel();
    m.apply(launch('t1', { description: 'Revisar', run_in_background: true }));
    m.apply(back('t1', { status: 'async_launched', agentId: 'agent-1' }));
    expect(m.runningAgents(Date.now() - 60000)).toHaveLength(1);

    m.applyAgentTranscript('t1', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'child-1', name: 'Bash', input: { command: 'git diff' } }] } },
      { type: 'result', subtype: 'success' },
    ]);
    expect(m.runningAgents(Date.now() - 60000)).toEqual([]);
    expect(m.agentMap()[0]).toMatchObject({ id: 't1', status: 'completed' });
  });

  it('TaskStop encerra a tarefa pelo taskId', () => {
    const m = new ChatModel();
    m.apply(launch('t1', { description: 'Revisar', run_in_background: true }));
    m.apply(back('t1', { status: 'async_launched', agentId: 'agent-1' }));
    expect(m.runningAgents(Date.now() - 60000)).toHaveLength(1);

    m.apply({
      type: 'assistant',
      uuid: 'stop-turn',
      message: {
        id: 'stop-msg',
        content: [{ type: 'tool_use', id: 'stop-1', name: 'TaskStop', input: { task_id: 'agent-1' } }],
      },
    });
    expect(m.runningAgents(Date.now() - 60000)).toEqual([]);
    expect(m.agentMap()[0]).toMatchObject({ id: 't1', status: 'killed' });
  });

  it('agente mais antigo que 2 horas é descartado do runningAgents mesmo sem notificação de fim', () => {
    const m = new ChatModel();
    const oldTime = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    m.apply(launch('t1', { description: 'Abandonado', run_in_background: true }, oldTime), { history: true });
    m.apply(back('t1', { status: 'async_launched', agentId: 'agent-1' }), { history: true });
    expect(m.runningAgents(0)).toEqual([]);
  });
});
