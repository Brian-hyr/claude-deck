// Orquestrador de ponta a ponta: DeckServer real + "Claude falso" fazendo os dois papéis (orquestrador e workers).
// O falso chama as ferramentas do servidor MCP deck_orq pelo canal da conversa (comando "mcp <servidor> <ferramenta>
// <json>"), como o CLI de verdade. Os workers falsos recebem o comando do turno pela linha "fake-cmd:" do briefing.
//
// Verifica as regras que o Deck impõe (não o modelo): plano aprovado pelo usuário antes de criar workers, esforço
// acima de médio, dependências, arquivos sobrepostos, limite de simultâneos, worker sem ferramentas de orquestração,
// eventos entregues ao orquestrador (worker_wait e acordar quando parado) e lembretes até concluir.
// Sem custo de inferência: só o script falso. Pastas e CLAUDE_CONFIG_DIR temporários.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, login, connectWs, TEST_HOST, type WsClient } from './helpers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = path.join(ROOT, 'test', 'fake-claude', 'fake-claude.mjs');

type Env = Awaited<ReturnType<typeof startServer>>;

const ORIGINAL = { cfg: process.env.CLAUDE_CONFIG_DIR, delay: process.env.CLAUDE_DECK_ORQ_DELAY_MS };
let claudeConfigDir: string;
const tmpDirs: string[] = [];
beforeAll(() => {
  claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-it-orq-claude-'));
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  process.env.CLAUDE_DECK_ORQ_DELAY_MS = '150';
});
afterAll(() => {
  for (const [k, v] of [['CLAUDE_CONFIG_DIR', ORIGINAL.cfg], ['CLAUDE_DECK_ORQ_DELAY_MS', ORIGINAL.delay]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of [claudeConfigDir, ...tmpDirs]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* limpeza best-effort */
    }
  }
});

function tmpCwd() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-it-orq-'));
  tmpDirs.push(d);
  return d;
}

async function attach(client: WsClient) {
  const r = await client.call('window.attach', { wid: `w-${crypto.randomUUID()}` });
  return r.wid as string;
}

/**
 * Manda uma mensagem e espera o `result` DO TURNO DELA (respondendo permissões, se houver). O Deck pode intercalar
 * turnos seus (avisos ao orquestrador): o turno é localizado pelo eco da mensagem (mesmo uuid), não pelo primeiro
 * `result` que aparecer.
 */
async function turn(client: WsClient, sid: string, text: string, timeoutMs = 30_000) {
  const from = client.events.length;
  const uuid = crypto.randomUUID();
  await client.call('sessions.send', { sid, uuid, content: [{ type: 'text', text }] });
  const t0 = Date.now();
  const seen = new Set<string>();
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`turno "${text.slice(0, 60)}" não terminou`);
    const evs = client.events.slice(from).filter((e) => e.event === 'session.msg' && e.data.sid === sid);
    for (const e of evs) {
      const m = e.data.msg;
      if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool' && !seen.has(m.request_id)) {
        seen.add(m.request_id);
        await client.call('sessions.respond', { sid, requestId: m.request_id, response: { behavior: 'allow', updatedInput: m.request.input } });
      }
    }
    const start = evs.findIndex((e) => e.data.msg.type === 'user' && e.data.msg.isReplay && e.data.msg.uuid === uuid);
    const end = start >= 0 ? evs.findIndex((e, i) => i > start && e.data.msg.type === 'result') : -1;
    if (end >= 0) {
      const mine = evs.slice(start, end + 1);
      const out = mine
        .filter((e) => e.data.msg.type === 'assistant')
        .map((e) => (e.data.msg.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''))
        .join('\n');
      return { text: out, result: mine[mine.length - 1].data.msg, msgs: mine.map((e) => e.data.msg) };
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** O orquestrador ficou parado (idle) por um tempo, sem novo turno do Deck chegando. */
async function settle(client: WsClient, sid: string, quietMs = 900, timeoutMs = 60_000) {
  const t0 = Date.now();
  let since = 0;
  for (;;) {
    const last = [...client.events].reverse().find((e) => e.event === 'session.state' && e.data.sid === sid)?.data;
    if (last?.phase === 'idle') {
      if (!since) since = Date.now();
      if (Date.now() - since >= quietMs) return;
    } else since = 0;
    if (Date.now() - t0 > timeoutMs) throw new Error('orquestrador não ficou parado');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Chama uma ferramenta do deck_orq pelo orquestrador falso; devolve o texto do resultado. */
async function tool(client: WsClient, sid: string, name: string, args: any = {}) {
  const t = await turn(client, sid, `mcp deck_orq ${name} ${JSON.stringify(args)}`, 60_000);
  return t.text.trim();
}

const lastView = (client: WsClient, id: string) => [...client.events].reverse().find((e) => e.event === 'orq.update' && e.data.id === id)?.data;

async function waitView(client: WsClient, id: string, pred: (v: any) => boolean, label: string, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const v = lastView(client, id);
    if (v && pred(v)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label} (último estado: ${JSON.stringify(v)?.slice(0, 400)})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const userMessages = (client: WsClient, sid: string, from = 0) =>
  client.events
    .slice(from)
    .filter((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'user' && e.data.msg.isReplay)
    .map((e) => (e.data.msg.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''));

const brief = (task: string, cmd: string) => `Tarefa ${task} do teste do orquestrador. Objetivo: fazer a parte ${task}. Critério de pronto: relatório enviado.\nfake-cmd: ${cmd}`;
const report = (summary: string, files: string[] = []) => `mcp deck_orq task_report ${JSON.stringify({ status: 'done', summary, files_changed: files, checks: [{ command: 'echo ok', exit_code: 0 }] })}`;

describe('Orquestrador local (Claude falso nos dois papéis)', () => {
  let env: Env;
  let client: WsClient;
  let anchor: WsClient;

  beforeAll(async () => {
    env = await startServer({ settings: { localClaudePath: FAKE, defaultModel: 'fake-sonnet', notifications: false, defaultPermissionMode: 'default' } });
    client = env.client;
    // Sempre há uma janela "ao vivo": window.attach cria janelas novas e vazias (ver live-terminal.test.ts).
    anchor = await connectWs(env.server.port, await login(env.server.port, env.server.token));
    await attach(anchor);
  });
  afterAll(async () => {
    anchor?.close();
    await env?.server.stop();
  });

  it('fluxo completo: planejar → aprovar pelo botão → workers em paralelo → relatórios → concluir', async () => {
    const wid = await attach(client);
    const cwd = tmpCwd();
    expect((await client.call('app.info')).orchestrator).toBe(true);

    const created = await client.call('orq.create', { hostId: 'local', cwd, title: 'Soft router de teste', workerPermissionMode: 'acceptEdits', maxParallel: 2 });
    const id: string = created.orchestration.id;
    const osid: string = created.state.sid;
    expect(created.state.orq).toEqual({ id, role: 'orchestrator' });
    expect(created.state.wid).toBe(wid);
    expect(created.orchestration.status).toBe('planning');
    // A aba do orquestrador chega como as outras (session.state com o wid desta janela).
    await client.waitFor((e) => e.event === 'session.state' && e.data.sid === osid && e.data.phase === 'idle', 30_000, 'orquestrador idle');

    // Pasta de estado criada na hora, fora do git.
    const stateDir = created.orchestration.stateDir as string;
    expect(fs.existsSync(path.join(stateDir, 'STATE.md'))).toBe(true);
    expect(fs.readFileSync(path.join(cwd, '.claude-deck', '.gitignore'), 'utf8')).toContain('*');

    // O orquestrador recebe as ferramentas e as instruções de coordenação; o terminal ao vivo continua lá.
    const info = await turn(client, osid, 'mcpinfo');
    expect(info.text).toContain('worker_start');
    expect(info.text).toContain('ORQUESTRADOR');
    expect(info.text).toContain('deck_terminal');
    expect(info.text).not.toContain('task_report');

    // Plano: T0 base; T1 e T2 dependem dela e mexem em arquivos separados; T3 sobrepõe T1.
    const defined = await tool(client, osid, 'tasks_define', {
      tasks: [
        { id: 'T0', title: 'Base de roteamento', files: ['src/core'], verify: ['echo ok'] },
        { id: 'T1', title: 'OSPF', depends_on: ['T0'], files: ['src/ospf'] },
        { id: 'T2', title: 'BGP', depends_on: ['T0'], files: ['src/bgp'] },
        { id: 'T3', title: 'Ajuste OSPF', depends_on: ['T0'], files: ['src/ospf/area.c'] },
      ],
    });
    expect(defined).toMatch(/^OK tasks_define/);
    expect(await tool(client, osid, 'tasks_define', { tasks: [{ id: 'T9', title: 'X', depends_on: ['T8'] }] })).toMatch(/não existe/);
    expect(await tool(client, osid, 'tasks_define', { tasks: [{ id: 'T0', title: 'Base', depends_on: ['T1'] }] })).toMatch(/circular/);

    // Antes de aprovar: nenhum worker.
    expect(await tool(client, osid, 'worker_start', { task_id: 'T0', brief: brief('T0', 'echo oi'), effort: 'high' })).toMatch(/não foi aprovado/);
    expect(await tool(client, osid, 'plan_submit', { summary: 'Base, depois OSPF e BGP em paralelo.' })).toMatch(/TERMINE o turno/);
    expect(lastView(client, id).status).toBe('awaiting_approval');

    // O usuário aprova pelo botão: o Deck avisa o orquestrador numa mensagem nova.
    const before = client.events.length;
    await client.call('orq.approve', { id });
    await client.waitFor(
      (e) => e.event === 'session.msg' && e.data.sid === osid && e.data.msg.type === 'result' && client.events.indexOf(e) > before,
      30_000,
      'turno do aviso de aprovação',
    );
    expect(userMessages(client, osid, before).join('\n')).toMatch(/<orq-update>[\s\S]*APROVOU/);
    expect(lastView(client, id).status).toBe('running');

    // Regras do Deck: esforço do worker Médio ou acima (nunca Baixo) e dependências.
    expect(await tool(client, osid, 'worker_start', { task_id: 'T0', brief: brief('T0', 'echo oi'), effort: 'low' })).toMatch(/effort/);
    expect(await tool(client, osid, 'worker_start', { task_id: 'T1', brief: brief('T1', 'echo oi'), effort: 'high' })).toMatch(/depende de T0/);

    // T0: worker que manda o relatório no primeiro turno.
    const started = await tool(client, osid, 'worker_start', { task_id: 'T0', brief: brief('T0', report('Base pronta.', ['src/core/base.c'])), effort: 'xhigh', model: 'fake-opus' });
    expect(started).toMatch(/Worker T0\.1 criado/);
    const w0 = await waitView(client, id, (v) => v.workers.some((w: any) => w.id === 'T0.1'), 'worker T0.1');
    const sid0 = w0.workers.find((w: any) => w.id === 'T0.1').sid;
    // A aba do worker é uma conversa normal desta janela, com esforço, modelo, modo e nome escolhidos.
    const st0 = (await client.waitFor((e) => e.event === 'session.state' && e.data.sid === sid0, 15_000, 'estado do worker')).data;
    expect(st0.wid).toBe(wid);
    expect(st0.orq).toMatchObject({ id, role: 'worker', taskId: 'T0', workerId: 'T0.1' });
    expect(st0.effort).toBe('xhigh');
    expect(st0.permissionMode).toBe('acceptEdits');
    expect(st0.title).toBe('T0.1 · Base de roteamento');
    expect(fs.readFileSync(path.join(stateDir, 'briefs', 'T0.1.md'), 'utf8')).toContain('Tarefa T0 do teste');

    // worker_wait volta com o relatório.
    const waited = await tool(client, osid, 'worker_wait', { timeout_seconds: 30 });
    expect(waited).toMatch(/T0\.1 \(T0 · Base de roteamento\) enviou relatório: DONE — Base pronta\./);
    expect(fs.readFileSync(path.join(stateDir, 'reports', 'T0.1.md'), 'utf8')).toContain('Base pronta.');
    const result = await tool(client, osid, 'worker_result', { worker: 'T0.1' });
    expect(result).toContain('src/core/base.c');
    expect(result).toContain('echo ok');

    // "done" exige evidência.
    expect(await tool(client, osid, 'task_update', { id: 'T0', status: 'done' })).toMatch(/evidence/);
    expect(await tool(client, osid, 'task_update', { id: 'T0', status: 'done', evidence: 'echo ok → 0; diff conferido' })).toMatch(/Prontas para começar: T1, T2, T3/);

    // O worker não tem ferramentas de orquestração (sem aninhamento).
    const wInfo = await turn(client, sid0, 'mcpinfo');
    expect(wInfo.text).toContain('task_report');
    expect(wInfo.text).not.toContain('worker_start');
    expect(wInfo.text).toContain('WORKER');

    // T1 trabalha devagar; T3 sobrepõe T1 (recusa); T2 é disjunta (aceita); depois o limite de 2 simultâneos.
    expect(await tool(client, osid, 'worker_start', { task_id: 'T1', brief: brief('T1', 'slow 40'), effort: 'high' })).toMatch(/Worker T1\.1 criado/);
    await waitView(client, id, (v) => v.workers.find((w: any) => w.id === 'T1.1')?.state === 'working', 'T1.1 trabalhando');
    expect(await tool(client, osid, 'worker_start', { task_id: 'T3', brief: brief('T3', 'echo oi'), effort: 'high' })).toMatch(/sobrepostos com T1/);
    expect(await tool(client, osid, 'worker_start', { task_id: 'T2', brief: brief('T2', 'slow 40'), effort: 'high' })).toMatch(/Worker T2\.1 criado/);
    expect(await tool(client, osid, 'tasks_define', { tasks: [{ id: 'T4', title: 'Netwatch', files: ['src/netwatch'] }] })).toMatch(/OK/);
    expect(await tool(client, osid, 'worker_start', { task_id: 'T4', brief: brief('T4', 'echo oi'), effort: 'high' })).toMatch(/Limite de 2/);

    // Workers terminam o turno sem relatório: o orquestrador PARADO é acordado com os eventos (sem worker_wait).
    const mark = client.events.length;
    await client.waitFor(
      (e) =>
        e.event === 'session.msg' &&
        e.data.sid === osid &&
        e.data.msg.type === 'user' &&
        e.data.msg.isReplay &&
        client.events.indexOf(e) > mark &&
        JSON.stringify(e.data.msg).includes('SEM relatório'),
      60_000,
      'orquestrador acordado com o fim dos workers',
    );
    await waitView(client, id, (v) => !v.workers.some((w: any) => ['working', 'starting'].includes(w.state)) && v.queued === 0, 'workers parados e eventos entregues', 60_000);
    await settle(client, osid);
    const woke = userMessages(client, osid, mark).join('\n');
    expect(woke).toContain('T1.1 (T1 · OSPF) terminou o turno SEM relatório');
    expect(woke).toContain('T2.1 (T2 · BGP) terminou o turno SEM relatório');

    // Pede o relatório ao T1 por worker_send; recebe pelo worker_wait.
    // Cada chamada do teste é um turno separado do orquestrador: se o relatório chegar entre os dois turnos (orquestrador
    // parado), o Deck o acorda com o evento antes do worker_wait. Os dois caminhos entregam o mesmo conteúdo, uma vez só.
    const mark2 = client.events.length;
    expect(await tool(client, osid, 'worker_send', { worker: 'T1.1', message: `Mande o relatório.\nfake-cmd: ${report('OSPF ok.', ['src/ospf/ospf.c'])}` })).toMatch(/Mensagem enviada a T1\.1/);
    const got = await tool(client, osid, 'worker_wait', { workers: ['T1.1'], timeout_seconds: 30 });
    if (!/T1\.1 .*enviou relatório: DONE — OSPF ok\./.test(got)) {
      expect(got).toMatch(/Nenhum worker ativo/);
      await settle(client, osid);
      expect(userMessages(client, osid, mark2).join('\n')).toMatch(/T1\.1 .*enviou relatório: DONE — OSPF ok\./);
    }
    await waitView(client, id, (v) => v.workers.find((w: any) => w.id === 'T1.1')?.report === 'done', 'relatório do T1.1 no quadro');
    expect(await tool(client, osid, 'worker_read', { worker: 'T2.1' })).toMatch(/40/);

    // Fechar tudo e concluir.
    for (const t of ['T1', 'T2', 'T3', 'T4']) await tool(client, osid, 'task_update', { id: t, status: t === 'T1' || t === 'T2' ? 'done' : 'cancelled', evidence: 'verificado pelo teste do orquestrador' });
    expect(await tool(client, osid, 'orq_finish', { summary: 'Tudo pronto.' })).toMatch(/concluída/);
    expect(lastView(client, id).status).toBe('done');
    const board = JSON.parse(fs.readFileSync(path.join(stateDir, 'tasks.json'), 'utf8'));
    expect(board.tasks.find((t: any) => t.id === 'T0').evidence).toContain('echo ok');
  }, 240_000);

  it('acompanha até concluir: parado com tarefas abertas recebe lembretes e depois fica "parado" esperando você', async () => {
    await attach(client);
    const cwd = tmpCwd();
    const created = await client.call('orq.create', { hostId: 'local', cwd, title: 'Lembretes', requireApproval: false });
    const id: string = created.orchestration.id;
    const osid: string = created.state.sid;
    await client.waitFor((e) => e.event === 'session.state' && e.data.sid === osid && e.data.phase === 'idle', 30_000, 'idle');
    await tool(client, osid, 'tasks_define', { tasks: [{ id: 'A', title: 'Pendente' }] });
    // Sem aprovação exigida: plan_submit já põe para executar.
    expect(await tool(client, osid, 'plan_submit', { summary: 'Uma tarefa.' })).toMatch(/dispensou a aprovação/);
    // O falso não faz nada com os lembretes: depois de 3, a orquestração para e pede o usuário.
    const v = await waitView(client, id, (x) => x.status === 'stalled', 'orquestração parada', 60_000);
    expect(v.status).toBe('stalled');
    const reminders = userMessages(client, osid).filter((t) => t.includes('Lembrete do Claude Deck'));
    expect(reminders).toHaveLength(3);
    expect(reminders[0]).toContain('A (pending)');
    // O usuário escreve: volta a ser acompanhada.
    await turn(client, osid, 'echo continue');
    await waitView(client, id, (x) => x.status === 'running', 'volta a executar');
    // Pausar: nada mais chega sozinho.
    await client.call('orq.pause', { id, paused: true });
    await waitView(client, id, (x) => x.status === 'paused', 'pausada');
    const n = userMessages(client, osid).length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(userMessages(client, osid).length).toBe(n);
    await client.call('orq.cancel', { id });
    await waitView(client, id, (x) => x.status === 'cancelled', 'cancelada');
  }, 120_000);

  it('orq.* de outra janela é recusado; orq.list mostra só as da janela', async () => {
    await attach(client);
    // Opções inválidas não prendem a janela a uma pasta: depois disso, outra pasta ainda pode ser escolhida.
    await expect(client.call('orq.create', { hostId: 'local', cwd: tmpCwd(), effort: 'medium' })).rejects.toMatchObject({ code: 'bad' });
    await expect(client.call('orq.create', { hostId: 'local', cwd: tmpCwd(), maxParallel: 20 })).rejects.toMatchObject({ code: 'bad' });
    const cwd = tmpCwd();
    const created = await client.call('orq.create', { hostId: 'local', cwd, title: 'Isolamento' });
    const id: string = created.orchestration.id;
    const other = await connectWs(env.server.port, await login(env.server.port, env.server.token));
    await attach(other);
    await expect(other.call('orq.approve', { id })).rejects.toMatchObject({ code: 'otherwindow' });
    await expect(other.call('orq.cancel', { id })).rejects.toMatchObject({ code: 'otherwindow' });
    expect((await other.call('orq.list')).map((o: any) => o.id)).not.toContain(id);
    expect((await client.call('orq.list')).map((o: any) => o.id)).toContain(id);
    other.close();
    await client.call('orq.cancel', { id });
  }, 60_000);

  it('modelo esgotado no gateway: o Deck troca sozinho (worker e orquestrador), avisa e não repete o modelo recusado', async () => {
    const wid = await attach(client);
    void wid;
    const cwd = tmpCwd();
    const created = await client.call('orq.create', { hostId: 'local', cwd, title: 'Failover', requireApproval: false, model: 'fake-sonnet' });
    const id: string = created.orchestration.id;
    const osid: string = created.state.sid;
    await client.waitFor((e) => e.event === 'session.state' && e.data.sid === osid && e.data.phase === 'idle', 30_000, 'idle');
    await tool(client, osid, 'tasks_define', { tasks: [{ id: 'A', title: 'Simples', files: ['a'] }, { id: 'B', title: 'Outra', files: ['b'] }] });
    await tool(client, osid, 'plan_submit', { summary: 'Duas tarefas.' });

    // Worker com esforço Médio no modelo fake-opus. O briefing manda um erro 429 "No deployments" no 1º turno; o
    // Deck marca fake-opus como esgotado, troca o worker para outro modelo e manda continuar; no 2º turno o worker
    // (já no modelo novo) recebe o pedido de continuar e responde normalmente.
    const started = await tool(client, osid, 'worker_start', {
      task_id: 'A',
      brief: brief('A', 'apierr 429 Request rejected (429) · No deployments available for selected model, Try again in 900 seconds. Passed model=fake-opus.'),
      effort: 'medium',
      model: 'fake-opus',
    });
    expect(started).toMatch(/Worker A\.1 criado.*esforço medium.*modelo fake-opus/);
    const v1 = await waitView(client, id, (v) => v.workers.find((w: any) => w.id === 'A.1')?.model === 'fake-sonnet', 'worker trocado para fake-sonnet');
    const wsid = v1.workers.find((w: any) => w.id === 'A.1').sid;
    expect(v1.exhaustedModels.map((x: any) => x.model)).toEqual(['fake-opus']);
    // A conversa do worker recebeu set_model e o pedido de continuar, e o estado mostra o modelo novo.
    await client.waitFor((e) => e.event === 'session.msg' && e.data.sid === wsid && e.data.msg.type === 'user' && e.data.msg.isReplay && JSON.stringify(e.data.msg).includes('trocou o modelo desta conversa de fake-opus para fake-sonnet'), 15_000, 'pedido de continuar no worker');
    await client.waitFor((e) => e.event === 'session.state' && e.data.sid === wsid && e.data.model === 'fake-sonnet', 15_000, 'estado do worker com o modelo novo');

    // O modelo esgotado não pode ser escolhido de novo, e some da lista das ferramentas.
    expect(await tool(client, osid, 'worker_start', { task_id: 'B', brief: brief('B', 'echo oi'), effort: 'high', model: 'fake-opus' })).toMatch(/fake-opus está recusado pelo gateway/);
    expect(await tool(client, osid, 'worker_status', {})).toMatch(/Modelos recusados pelo gateway agora.*fake-opus \(esgotado até/);
    // Um worker ocupado durante o resto do teste: com alguém trabalhando, o Deck não manda lembretes ao orquestrador
    // (sem isso, os lembretes de "nenhum worker trabalhando" também levariam a "parada" e o teste não separaria as causas).
    expect(await tool(client, osid, 'worker_start', { task_id: 'B', brief: brief('B', 'slow 600'), effort: 'high', model: 'fake-haiku' })).toMatch(/Worker B\.1 criado/);
    await waitView(client, id, (v) => v.workers.find((w: any) => w.id === 'B.1')?.state === 'working', 'worker B trabalhando');

    // O próprio orquestrador: o modelo dele esgota (erro no turno dele) → o Deck troca e manda continuar. O único
    // modelo que sobra é fake-haiku (fake-opus está recusado).
    const mark = client.events.length;
    await turn(client, osid, 'apierr 429 No deployments available for selected model. Passed model=fake-sonnet.');
    await client.waitFor((e) => e.event === 'session.state' && e.data.sid === osid && e.data.model === 'fake-haiku' && client.events.indexOf(e) > mark, 15_000, 'orquestrador trocado de modelo');
    await settle(client, osid);
    expect(userMessages(client, osid, mark).join('\n')).toMatch(/trocou o modelo desta conversa de fake-sonnet para fake-haiku/);
    const v2 = lastView(client, id);
    expect(v2.exhaustedModels.map((x: any) => x.model).sort()).toEqual(['fake-opus', 'fake-sonnet']);
    expect(v2.status).toBe('running');
    expect(client.events.slice(mark).some((e) => e.event === 'session.attention' && e.data.subtype === 'orq_stalled')).toBe(false);

    // Sem nenhum modelo disponível: o orquestrador para e pede o usuário (não fica em laço).
    const mark2 = client.events.length;
    await turn(client, osid, 'apierr 429 No deployments available for selected model.');
    const v3 = await waitView(client, id, (v) => v.status === 'stalled', 'parada sem modelo disponível', 15_000);
    expect(v3.exhaustedModels.map((x: any) => x.model).sort()).toEqual(['fake-haiku', 'fake-opus', 'fake-sonnet']);
    expect(client.events.slice(mark2).some((e) => e.event === 'session.attention' && e.data.subtype === 'orq_stalled')).toBe(true);
    // Nenhuma troca a mais: o pedido de continuar não foi repetido.
    expect(userMessages(client, osid, mark2).filter((t) => t.includes('trocou o modelo'))).toHaveLength(0);
    await client.call('orq.cancel', { id });
  }, 120_000);
});

// O mesmo mecanismo por SSH (runner): ferramentas pelo canal da conversa remota, pasta de estado, briefing, relatório
// e tasks.json gravados NO SERVIDOR, commit base lido do git remoto. Só no servidor de teste (DECK_TEST_HOST).
describe.skipIf(!TEST_HOST)(`Orquestrador remoto em ${TEST_HOST} (Claude falso no servidor)`, () => {
  const remoteBase = `/tmp/deck-it-orq-${crypto.randomBytes(4).toString('hex')}`;
  const remoteFake = `${remoteBase}/fake-claude.mjs`;
  const remoteProj = `${remoteBase}/proj`;
  const projKey = remoteProj.replace(/[^a-zA-Z0-9]/g, '-');
  let env: Env;
  let anchor: WsClient;
  const sshRun = (cmd: string) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', TEST_HOST, cmd], { encoding: 'utf8', timeout: 60_000 });

  beforeAll(async () => {
    // Projeto remoto com git (para o commit base do worker).
    sshRun(
      `mkdir -p '${remoteProj}' && chmod 700 '${remoteBase}' && cd '${remoteProj}' && git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base && git rev-parse HEAD`,
    );
    execFileSync('scp', ['-q', '-o', 'BatchMode=yes', 'fake-claude.mjs', `${TEST_HOST}:${remoteFake}`], { cwd: path.join(ROOT, 'test', 'fake-claude'), timeout: 60_000 });
    sshRun(`chmod 755 '${remoteFake}'`);
    env = await startServer({ settings: { localClaudePath: FAKE, hostClaudePath: { [TEST_HOST]: remoteFake }, defaultModel: 'fake-sonnet', notifications: false, defaultPermissionMode: 'default' } });
    anchor = await connectWs(env.server.port, await login(env.server.port, env.server.token));
    await attach(anchor);
  }, 90_000);

  afterAll(async () => {
    anchor?.close();
    await env?.server.stop();
    try {
      sshRun(`rm -rf '${remoteBase}' "$HOME/.claude/projects/${projKey}"`);
    } catch {
      /* limpeza remota best-effort */
    }
  });

  it('cria, delega, recebe o relatório e conclui com tudo gravado no servidor', async () => {
    const client = env.client;
    await attach(client);
    const head = sshRun(`cd '${remoteProj}' && git rev-parse HEAD`).trim();
    const created = await client.call('orq.create', { hostId: TEST_HOST, cwd: remoteProj, title: 'Remoto', requireApproval: false, workerPermissionMode: 'acceptEdits' }, 90_000);
    const id: string = created.orchestration.id;
    const osid: string = created.state.sid;
    const stateDir: string = created.orchestration.stateDir;
    expect(stateDir.startsWith(`${remoteProj}/.claude-deck/orq/`)).toBe(true);
    await client.waitFor((e) => e.event === 'session.state' && e.data.sid === osid && e.data.phase === 'idle', 60_000, 'orquestrador remoto idle').catch((e) => {
      const states = client.events.filter((x) => x.event === 'session.state' && x.data.sid === osid).map((x) => `${x.data.phase}${x.data.error ? `: ${x.data.error}` : ''}`);
      const msgs = client.events.filter((x) => x.event === 'session.msg' && x.data.sid === osid).map((x) => JSON.stringify(x.data.msg).slice(0, 300));
      throw new Error(`${e.message}\nestados: ${states.join(' → ')}\nmsgs:\n${msgs.slice(-12).join('\n')}`);
    });
    expect(sshRun(`cat '${remoteProj}/.claude-deck/.gitignore'`)).toMatch(/^\*$/m);
    expect(sshRun(`test -f '${stateDir}/STATE.md' && echo sim`).trim()).toBe('sim');

    const info = await turn(client, osid, 'mcpinfo', 60_000);
    expect(info.text).toContain('worker_start');

    expect(await tool(client, osid, 'tasks_define', { tasks: [{ id: 'R1', title: 'Tarefa remota', files: ['src/r1'] }] })).toMatch(/^OK tasks_define/);
    expect(await tool(client, osid, 'plan_submit', { summary: 'Uma tarefa no servidor.' })).toMatch(/dispensou a aprovação/);
    expect(await tool(client, osid, 'worker_start', { task_id: 'R1', brief: brief('R1', report('Remoto ok.', ['src/r1/a.c'])), effort: 'high' })).toMatch(
      new RegExp(`Worker R1\\.1 criado.*commit base ${head.slice(0, 12)}`),
    );
    const v = await waitView(client, id, (x) => x.workers.some((w: any) => w.id === 'R1.1'), 'worker R1.1');
    const wsid = v.workers.find((w: any) => w.id === 'R1.1').sid;
    const wst = (await client.waitFor((e) => e.event === 'session.state' && e.data.sid === wsid, 30_000, 'estado do worker remoto')).data;
    expect(wst.hostId).toBe(TEST_HOST);
    expect(wst.cwd).toBe(remoteProj);

    // O relatório chega pelo worker_wait (ou acorda o orquestrador, se chegar entre os dois turnos).
    const mark = client.events.length;
    const got = await tool(client, osid, 'worker_wait', { timeout_seconds: 60 });
    if (!/R1\.1 .*enviou relatório: DONE — Remoto ok\./.test(got)) {
      await settle(client, osid);
      expect(userMessages(client, osid, mark).join('\n')).toMatch(/R1\.1 .*enviou relatório: DONE — Remoto ok\./);
    }
    expect(sshRun(`cat '${stateDir}/briefs/R1.1.md'`)).toContain('Tarefa R1 do teste');
    expect(sshRun(`cat '${stateDir}/reports/R1.1.md'`)).toContain('Remoto ok.');

    expect(await tool(client, osid, 'task_update', { id: 'R1', status: 'done', evidence: 'relatório remoto conferido' })).toMatch(/R1: done/);
    expect(await tool(client, osid, 'orq_finish', { summary: 'Remoto concluído.' })).toMatch(/concluída/);
    await waitView(client, id, (x) => x.status === 'done', 'concluída');
    // tasks.json espelhado no servidor.
    let board: any = null;
    for (let i = 0; i < 40 && !board?.tasks?.some((t: any) => t.status === 'done'); i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        board = JSON.parse(sshRun(`cat '${stateDir}/tasks.json'`));
      } catch {
        /* ainda não */
      }
    }
    expect(board.tasks.find((t: any) => t.id === 'R1')).toMatchObject({ status: 'done' });
  }, 240_000);
});
