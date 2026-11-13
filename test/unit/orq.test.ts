// Orquestrador: regras puras (arquivos sobrepostos, ciclos, validação das ferramentas) e o roteamento do segundo
// servidor MCP (deck_orq) dentro de uma conversa, sem processo nem rede.
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store, resolvePaths } from '../../src/server/config';
import { ClaudeSession, SessionManager, type SessionRecord } from '../../src/server/claude/session';
import { filesOverlap, findCycle, modelFailureOf, normalizeTaskFiles, pickFallbackModel } from '../../src/server/orq/manager';
import { OrqMcpServer, orchestratorTools, validateArgs, WORKER_TOOLS } from '../../src/server/orq/mcp';

describe('arquivos das tarefas', () => {
  it('normaliza para relativo com "/" e recusa o que sai da pasta', () => {
    expect(normalizeTaskFiles('/srv/router', 'posix', ['./src/ospf/', '/srv/router/src/bgp.c', 'src\\rip\\x.c'])).toEqual(['src/ospf', 'src/bgp.c', 'src/rip/x.c']);
    expect(normalizeTaskFiles('C:\\proj', 'win32', ['C:\\proj\\src\\a.ts'])).toEqual(['src/a.ts']);
    expect(() => normalizeTaskFiles('/srv/router', 'posix', ['/etc/passwd'])).toThrow(/fora da pasta/);
    expect(() => normalizeTaskFiles('/srv/router', 'posix', ['../outro/x'])).toThrow(/\.\./);
  });

  it.each([
    [['src/routing'], ['src/routing/ospf.c'], true],
    [['src/routing/ospf.c'], ['src/routing'], true],
    [['src/routing/ospf.c'], ['src/routing/bgp.c'], false],
    [['src/route'], ['src/routing/x.c'], false],
    [['src/**/*.c'], ['src/vpn/ovpn.c'], true],
    [['src/vpn/*'], ['src/routing/a.c'], false],
    [['docs/a.md', 'src/x.c'], ['lib/y.c', 'src/x.c'], true],
    [[''], ['qualquer'], true],
  ])('sobreposição %j × %j = %s', (a, b, expected) => {
    expect(!!filesOverlap(a as string[], b as string[])).toBe(expected);
  });

  it('acha ciclos nas dependências', () => {
    expect(findCycle([{ id: 'T0', deps: [] }, { id: 'T1', deps: ['T0'] }, { id: 'T2', deps: ['T0', 'T1'] }])).toBeNull();
    expect(findCycle([{ id: 'A', deps: ['C'] }, { id: 'B', deps: ['A'] }, { id: 'C', deps: ['B'] }])).toEqual(expect.arrayContaining(['A', 'B', 'C']));
  });
});

describe('ferramentas da orquestração', () => {
  const tools = orchestratorTools(['fake-opus']);
  const spec = (n: string) => tools.find((t) => t.name === n)!;

  it('esforço do worker: medium, high, xhigh ou max (nunca low)', () => {
    const base = { task_id: 'T1', brief: 'x'.repeat(50) };
    expect(validateArgs(spec('worker_start'), { ...base, effort: 'medium' })).toBeNull();
    expect(validateArgs(spec('worker_start'), { ...base, effort: 'high' })).toBeNull();
    expect(validateArgs(spec('worker_start'), { ...base, effort: 'max' })).toBeNull();
    expect(validateArgs(spec('worker_start'), { ...base, effort: 'low' })).toMatch(/effort/);
    expect(validateArgs(spec('worker_start'), base)).toMatch(/effort/);
  });

  it('recusa campos desconhecidos e tipos errados, inclusive dentro das tarefas', () => {
    expect(validateArgs(spec('tasks_define'), { tasks: [{ id: 'T1', title: 'x', files: 'src' }] })).toMatch(/lista/);
    expect(validateArgs(spec('tasks_define'), { tasks: [{ id: 'T1', title: 'x', prioridade: 1 }] })).toMatch(/não é um campo/);
    expect(validateArgs(spec('tasks_define'), { tasks: [{ title: 'sem id' }] })).toMatch(/id/);
    expect(validateArgs(spec('worker_wait'), { extra: 1 })).toMatch(/desconhecido/);
    expect(validateArgs(WORKER_TOOLS[0], { status: 'feito', summary: 'x' })).toMatch(/status/);
    expect(validateArgs(WORKER_TOOLS[0], { status: 'done', summary: 'ok', checks: [{ command: 'npm test', exit_code: 0 }] })).toBeNull();
  });

  it('erro de modelo no gateway: esgotado/indisponível troca de modelo; rede, credencial e erro comum não', () => {
    const res = (text: string, status?: number) => ({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: status, result: text });
    // Formatos reais (transcripts do gateway LiteLLM e do CLI).
    const noDeploy = modelFailureOf(res('API Error: Request rejected (429) · No deployments available for selected model, Try again in 14620 seconds. Passed model=gptterra.', 429));
    expect(noDeploy).toMatchObject({ kind: 'exhausted', retryAfterMs: 14_620_000 });
    expect(modelFailureOf(res('API Error: 500 litellm.InternalServerError: AnthropicError - {"type":"error","error":{"type":"overloaded_error","message":"The service is temporarily at capacity."}}', 500))).toMatchObject({ kind: 'exhausted' });
    expect(modelFailureOf(res('API Error: 400 anthropic_messages: Invalid model name passed in model=kpasonnet5. Call `/v1/models` to view available models for your key.', 400))).toMatchObject({ kind: 'unavailable' });
    expect(modelFailureOf({ ...res("There's an issue with the selected model (sonnet55[1m]). It may not exist or you may not have access to it."), terminal_reason: undefined })).toMatchObject({ kind: 'unavailable' });
    expect(modelFailureOf(res('API Error: 429 budget exceeded for key', 429))).toMatchObject({ kind: 'exhausted' });
    // Não é do modelo: outro modelo não resolveria.
    expect(modelFailureOf(res("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"))).toBeNull();
    expect(modelFailureOf(res('API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)'))).toBeNull();
    expect(modelFailureOf(res('API Error: Connection lost mid-response.'))).toBeNull();
    expect(modelFailureOf(res('API Error: 401 invalid x-api-key', 401))).toBeNull();
    expect(modelFailureOf({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' })).toBeNull();
    expect(modelFailureOf({ type: 'result', subtype: 'success', is_error: false, result: 'API Error: 429 citado num texto' })).toBeNull();
  });

  it('modelo reserva: mesma janela de contexto e família, nunca default/auto nem um recusado', () => {
    const models = ['default', 'auto[1m]', 'fable51[1m]', 'claude-opus-5-5[1m]', 'kpaopus55', 'kpaopus55[1m]', 'sonnet55[1m]', 'haiku55[1m]', 'kimik2.8'];
    const none = () => false;
    expect(pickFallbackModel('claude-opus-5-5[1m]', models, none)).toBe('kpaopus55[1m]');
    // Sem [1m]: prefere outro sem [1m] (a mesma família vem depois da janela).
    expect(pickFallbackModel('kpaopus55', models, none)).toBe('kimik2.8');
    expect(pickFallbackModel('kimik2.8', models, none)).toBe('kpaopus55');
    expect(pickFallbackModel('sonnet55[1m]', models, (m) => m === 'fable51[1m]')).toBe('claude-opus-5-5[1m]');
    // Automático/padrão sem modelo conhecido: prefere janela grande.
    expect(pickFallbackModel('auto[1m]', models, none)).toBe('fable51[1m]');
    expect(pickFallbackModel(undefined, models, none)).toBe('fable51[1m]');
    expect(pickFallbackModel('sonnet55[1m]', ['default', 'sonnet55[1m]'], none)).toBeUndefined();
    expect(pickFallbackModel('x', models, () => true)).toBeUndefined();
  });

  it('o worker só tem a ferramenta de relatório (sem aninhamento)', () => {
    expect(WORKER_TOOLS.map((t) => t.name)).toEqual(['task_report']);
    expect(tools.map((t) => t.name)).not.toContain('task_report');
    expect(tools.find((t) => t.name === 'worker_start')!.description).toContain('fake-opus');
  });

  it('servidor MCP: initialize traz as instruções do papel, tools/list as ferramentas e chamadas inválidas não chegam ao host', async () => {
    const call = vi.fn();
    const server = new OrqMcpServer({ tools: () => WORKER_TOOLS, instructions: () => 'INSTRUÇÕES-DO-WORKER', call });
    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init.result.instructions).toBe('INSTRUÇÕES-DO-WORKER');
    expect(init.result.serverInfo.name).toBe('claude-deck-orchestrator');
    expect((await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((t: any) => t.name)).toEqual(['task_report']);
    const bad = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task_report', arguments: { status: 'done' } } });
    expect(bad.result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ roteamento dentro da conversa

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function fixture(rec: Partial<SessionRecord>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-orq-unit-'));
  const store = new Store(resolvePaths(dir));
  const mgr = new SessionManager(new EventEmitter() as any, store, () => {});
  const session = new ClaudeSession({ sid: 'unit-orq', hostId: 'local', cwd: dir, createdAt: Date.now(), permissionMode: 'default', ...rec } as SessionRecord, mgr);
  mgr.sessions.set(session.state.sid, session);
  const calls: any[] = [];
  mgr.orq = {
    toolsFor: () => orchestratorTools([]),
    instructionsFor: () => 'ORQ',
    call: vi.fn(async (_s, tool, args) => {
      calls.push({ tool, args });
      return { content: [{ type: 'text' as const, text: `feito:${tool}` }] };
    }),
  };
  const writes: any[] = [];
  (session as any).transport = { alive: true, write: (line: string) => writes.push(JSON.parse(line)), close() {} };
  const receive = (msg: any) => (session as any).onLine(JSON.stringify(msg), JSON.stringify(msg).length + 1);
  cleanups.push(() => {
    if ((mgr as any).persistTimer) clearTimeout((mgr as any).persistTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { session, mgr, writes, receive, calls };
}

const orqCall = (id: string, name: string, args: any) => ({
  type: 'control_request',
  request_id: id,
  request: { subtype: 'mcp_message', server_name: 'deck_orq', message: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } } },
});
const mcpResponse = (writes: any[], n = 0) => writes[n]?.response?.response?.mcp_response;

describe('deck_orq na conversa', () => {
  it('só conversas de uma orquestração registram o servidor deck_orq no initialize', () => {
    const plain = fixture({});
    expect((plain.session as any).initRequest().sdkMcpServers).toEqual(['deck_terminal']);
    const orq = fixture({ orq: { id: 'o1', role: 'orchestrator' } });
    const init = (orq.session as any).initRequest();
    expect(init.sdkMcpServers).toEqual(['deck_terminal', 'deck_orq']);
    expect(init.sdkMcpServerConfigs.deck_orq.timeout).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('conversa comum: mensagens para deck_orq são recusadas sem chamar a orquestração', async () => {
    const f = fixture({});
    f.receive(orqCall('r1', 'tasks_list', {}));
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    expect(mcpResponse(f.writes).result.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it('ferramentas da orquestração são liberadas sem perguntar; as demais continuam pedindo permissão', () => {
    const f = fixture({ orq: { id: 'o1', role: 'orchestrator' } });
    f.receive({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'mcp__deck_orq__worker_start', input: { task_id: 'T1' } } });
    expect(f.writes[0].response.response.behavior).toBe('allow');
    f.receive({ type: 'control_request', request_id: 'p2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' } } });
    expect(f.session.pendingPermissions.has('p2')).toBe(true);
    // Numa conversa comum, uma ferramenta com o mesmo nome não ganha passe livre.
    const plain = fixture({});
    plain.receive({ type: 'control_request', request_id: 'p3', request: { subtype: 'can_use_tool', tool_name: 'mcp__deck_orq__worker_start', input: {} } });
    expect(plain.session.pendingPermissions.has('p3')).toBe(true);
  });

  it('chamada com efeito (worker_start) passa pelo registro durável: repetida após queda não executa de novo', async () => {
    const f = fixture({ orq: { id: 'o1', role: 'orchestrator' } });
    const args = { task_id: 'T1', brief: 'b'.repeat(60), effort: 'high' };
    f.receive(orqCall('r1', 'worker_start', args));
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    expect(JSON.stringify(mcpResponse(f.writes))).toContain('feito:worker_start');
    const records = JSON.parse(fs.readFileSync(f.mgr.store.paths.sessionsFile, 'utf8'));
    expect(records[0].orq).toEqual({ id: 'o1', role: 'orchestrator' });
    expect(records[0].terminalCalls.r1.fingerprint).toBeTruthy();
    f.receive(orqCall('r1', 'worker_start', args));
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    expect(f.calls.filter((c) => c.tool === 'worker_start')).toHaveLength(1);
  });

  it('consultas/esperas (worker_wait) não passam pelo registro: relidas após queda, esperam de novo', async () => {
    const f = fixture({ orq: { id: 'o1', role: 'orchestrator' } });
    f.receive(orqCall('w1', 'worker_wait', { timeout_seconds: 5 }));
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.receive(orqCall('w1', 'worker_wait', { timeout_seconds: 5 }));
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    expect(f.calls.filter((c) => c.tool === 'worker_wait')).toHaveLength(2);
    expect((f.session as any).terminalCalls.size).toBe(0);
  });

  it('interromper cancela a espera em andamento da orquestração', async () => {
    const f = fixture({ orq: { id: 'o1', role: 'orchestrator' } });
    let signal!: AbortSignal;
    (f.mgr.orq!.call as any).mockImplementation(async (_s: any, _t: string, _a: any, sig: AbortSignal) => {
      signal = sig;
      return new Promise((resolve) => sig.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelada' }], isError: true })));
    });
    f.receive(orqCall('w2', 'worker_wait', {}));
    await vi.waitFor(() => expect(signal).toBeDefined());
    f.receive({ type: 'control_cancel_request', request_id: 'w2' });
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    expect(signal.aborted).toBe(true);
  });

  it('mensagem na fila do CLI conta como "entre turnos" até o eco; sem eco, o prazo libera', async () => {
    const f = fixture({ orq: { id: 'o1', role: 'orchestrator' } });
    (f.session as any).setPhase('idle');
    expect(f.session.hasQueuedInput).toBe(false);
    const uuid = crypto.randomUUID();
    await f.session.send([{ type: 'text', text: 'aprovado' }], uuid);
    expect(f.session.hasQueuedInput).toBe(true);
    // Fim do turno anterior chega antes do eco da mensagem da fila: continua "entre turnos".
    f.receive({ type: 'result', subtype: 'success', is_error: false });
    expect(f.session.state.phase).toBe('idle');
    expect(f.session.hasQueuedInput).toBe(true);
    // O CLI começa o turno da mensagem: sai da fila.
    f.receive({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: [{ type: 'text', text: 'aprovado' }] } });
    expect(f.session.hasQueuedInput).toBe(false);
    // Uma mensagem que nunca ganha eco não prende a conversa: depois do prazo, conta como parada.
    await f.session.send([{ type: 'text', text: 'perdida' }], crypto.randomUUID());
    f.receive({ type: 'result', subtype: 'success', is_error: false });
    expect(f.session.hasQueuedInput).toBe(true);
    (f.session as any).turnEndedAt = Date.now() - 60_000;
    expect(f.session.hasQueuedInput).toBe(false);
  });
});
