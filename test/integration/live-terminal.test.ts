// Testes de ponta a ponta do modo "Terminal ao Vivo": DeckServer real + "Claude falso"
// (test/fake-claude/fake-claude.mjs) + PTY real (node-pty local, e SSH real remoto via DECK_TEST_HOST).
//
// Cobre o canal de controle que o CLI usa para chamar o servidor MCP hospedado pelo próprio app
// ("deck_terminal"): control_request "initialize" com sdkMcpServers, e cada chamada de ferramenta
// como control_request subtype "mcp_message" (initialize/notifications/tools-list/tools-call JSON-RPC
// pelo MESMO canal da conversa — sem porta nem túnel extra).
//
// O que este arquivo verifica de ponta a ponta — não só que o comando foi ecoado, mas que a SAÍDA
// REAL do terminal (calculada pelo shell de verdade, nunca inventada pelo "Claude falso") chega tanto
// no evento `term.data` quanto no `tool_result` que volta pro Claude:
//   - as ferramentas do terminal são anunciadas no "system init" mesmo com o modo Silencioso;
//   - ligar o modo Terminal ao Vivo (`sessions.setExecutionMode`) liga a um PTY de verdade;
//   - o terminal mantém estado real entre chamadas separadas (cd relativo, variável de shell);
//   - recusas "silenciosas" que NUNCA tocam o PTY real: modo Silencioso, terminal perdido/fechado,
//     modo de planejamento — e nenhuma delas recria nada por conta própria;
//   - permissão negada não chega a digitar nada de verdade;
//   - isolamento entre janelas: dono da conversa (`sessions.setExecutionMode`), `term.*` só valem
//     para a janela dona, sem adoção automática de um terminal aberto manualmente, e — de propósito —
//     um teste mostrando por que os demais sempre anexam janela (`window.attach`): sem isso, duas
//     conexões distintas com wid indefinido compartilham o mesmo escopo.
//
// Não mede journal replay nem falha de disco (isso fica com os testes unitários da sessão, de quem
// está corrigindo aquela parte); aqui o foco é o PTY de verdade e o handshake do protocolo MCP.
// Sem custo de inferência real: o "Claude" é sempre o script falso, nunca o CLI de verdade.
//
// Isolamento de dados: CLAUDE_CONFIG_DIR aponta para uma pasta temporária durante todo este arquivo
// (nunca grava no ~/.claude de verdade — o DeckServer roda no MESMO processo do vitest, então a
// variável de ambiente do processo atual é herdada por todo "Claude falso" local que este arquivo
// gera). Só usa pastas temporárias; o servidor remoto entra apenas como alvo remoto de teste (via DECK_TEST_HOST),
// e é limpo no fim. Nenhum servidor de produção é tocado, nenhum reinício de instância real acontece.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, login, connectWs, TEST_HOST, type WsClient } from './helpers';
import { MCP_TOOL_PREFIX } from '../../src/server/terminal/mcp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = path.join(ROOT, 'test', 'fake-claude', 'fake-claude.mjs');
const TOOL = {
  run: `${MCP_TOOL_PREFIX}run`,
  send: `${MCP_TOOL_PREFIX}send`,
  read: `${MCP_TOOL_PREFIX}read`,
  wait: `${MCP_TOOL_PREFIX}wait`,
};

type Env = Awaited<ReturnType<typeof startServer>>;

// ---------------------------------------------------------------- isolamento de ~/.claude
// O "Claude falso" grava transcript em `$CLAUDE_CONFIG_DIR/projects/...`. Como o DeckServer roda no
// MESMO processo do vitest (não é um servidor separado), a variável de ambiente do processo atual é
// herdada por todo processo filho que este arquivo gera localmente.
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
let claudeConfigDir: string;
beforeAll(() => {
  claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-it-term-claude-'));
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
});
afterAll(() => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  fs.rmSync(claudeConfigDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------- ajudantes deste arquivo
// (test/integration/helpers.ts não anexa janela nem tem "turn" com múltiplos clientes/janelas —
// propositalmente não editado aqui: outros testes de integração já existentes dependem dele como
// está.)

const tmpDirs: string[] = [];
function tmpCwd(prefix = 'deck-it-term-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function cleanupTmpDirs() {
  // Best-effort: uma tela real (PowerShell/PTY) pode ainda estar de saída bem no instante em que o
  // servidor para, segurando a pasta como cwd por mais alguns milissegundos no Windows (EPERM). Isso
  // não é um bug do produto — é só uma corrida de encerramento neste arquivo de teste — então nunca
  // deixa a limpeza derrubar o afterAll (o que mascarava testes que passaram como "suíte falhou").
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      process.stderr.write(`[live-terminal] não removi ${d} (fica para a limpeza do sistema): ${(e as Error).message}\n`);
    }
  }
}

/** Anexa o cliente a uma janela NOVA (id aleatório). */
async function attach(client: WsClient, wid = `w-${crypto.randomUUID()}`): Promise<string> {
  const r = await client.call('window.attach', { wid });
  expect(r.duplicate).toBeFalsy();
  return r.wid as string;
}

/** Conecta um 2º (ou 3º...) cliente ao MESMO servidor — outra "janela" do app. */
async function extraClient(env: Env): Promise<WsClient> {
  const cookie = await login(env.server.port, env.server.token);
  return connectWs(env.server.port, cookie);
}

/**
 * Cliente "âncora": fica conectado e com uma janela anexada durante todo o describe, só para
 * SEMPRE existir pelo menos uma janela "ao vivo" no servidor. Sem isso, `window.attach` entende que
 * nenhuma janela está aberta agora e RESTAURA a última janela FECHADA (mesmo pedindo um `wid` novo,
 * nunca visto antes) — é o "cold start" do atalho de verdade (reabrir depois de fechar tudo volta pra
 * última tela), mas quebraria o isolamento que este arquivo quer entre "janelas" simuladas que se
 * revezam no mesmo cliente único. Com a âncora sempre viva, `window.attach` sempre cria uma janela
 * nova vazia para o `wid` pedido (ver `attachWindow` em src/server/windows.ts, ramo 3B).
 */
async function withAnchor(env: Env): Promise<() => void> {
  const anchor = await extraClient(env);
  await attach(anchor, `w-anchor-${crypto.randomUUID()}`);
  return () => anchor.close();
}

async function createSession(
  client: WsClient,
  opts: { hostId?: string; cwd: string; permissionMode?: string; executionMode?: 'silent' | 'terminal'; resume?: string },
  idleTimeoutMs = 30_000,
): Promise<string> {
  const st = await client.call('sessions.create', {
    hostId: opts.hostId ?? 'local',
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    executionMode: opts.executionMode,
    resume: opts.resume,
  });
  await client.waitFor((e) => e.event === 'session.state' && e.data.sid === st.sid && e.data.phase === 'idle', idleTimeoutMs, `sessão ${st.sid} ficar idle`);
  return st.sid as string;
}

async function setExecMode(client: WsClient, sid: string, mode: 'silent' | 'terminal', terminalId?: string): Promise<{ terminalId: string | null }> {
  return client.call('sessions.setExecutionMode', { sid, mode, terminalId });
}

/** Manda uma mensagem e espera o "result" do turno, respondendo pedidos de permissão pelo caminho. */
async function turn(client: WsClient, sid: string, text: string, onPermission?: (req: any) => any, timeoutMs = 30_000) {
  const from = client.events.length;
  const uuid = crypto.randomUUID();
  await client.call('sessions.send', { sid, uuid, content: [{ type: 'text', text }] });
  const seen = new Set<string>();
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`turno "${text}" não terminou em ${timeoutMs}ms`);
    const evs = client.events.slice(from).filter((e) => e.event === 'session.msg' && e.data.sid === sid);
    for (const e of evs) {
      const m = e.data.msg;
      if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool' && !seen.has(m.request_id)) {
        seen.add(m.request_id);
        const resp = onPermission ? onPermission(m.request) : { behavior: 'allow', updatedInput: m.request.input };
        await client.call('sessions.respond', { sid, requestId: m.request_id, response: resp });
      }
    }
    const result = evs.find((e) => e.data.msg.type === 'result');
    if (result) return { msgs: evs.map((e) => e.data.msg), result: result.data.msg, uuid };
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Junta os blocos de texto de todas as mensagens "assistant" de um turno. */
function assistantText(msgs: any[]): string {
  return msgs
    .filter((m) => m.type === 'assistant')
    .map((m) => (m.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''))
    .join('');
}

/** Texto do tool_result que o Claude recebeu de volta (a chamada MCP do terminal). */
function toolResultText(msgs: any[]): string | undefined {
  for (const m of msgs) {
    const c = m?.message?.content;
    if (m?.type === 'user' && Array.isArray(c)) {
      const tr = c.find((b: any) => b?.type === 'tool_result');
      if (tr) return typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
    }
  }
  return undefined;
}

/** Concatena tudo que chegou em `term.data` (só o que ESTE cliente recebeu) para um terminal. */
function allTermData(client: WsClient, id: string): string {
  return client.events
    .filter((e) => e.event === 'term.data' && e.data.id === id)
    .map((e) => e.data.data)
    .join('');
}

const baseSettings = { localClaudePath: FAKE, defaultModel: 'fake-sonnet', notifications: false };

// =====================================================================================
// A) Local: handshake do MCP, PTY real com saída derivada, continuidade e recusas silenciosas
// =====================================================================================
describe('Terminal ao vivo local: handshake MCP, PTY real e recusas sem efeito colateral', () => {
  let env: Env;
  let client: WsClient;
  let closeAnchor: () => void;

  beforeAll(async () => {
    env = await startServer({ settings: { ...baseSettings, defaultPermissionMode: 'bypassPermissions' } });
    client = env.client;
    closeAnchor = await withAnchor(env); // cada it() abaixo reanexa `client` a uma janela "nova"
  });
  afterAll(async () => {
    closeAnchor?.();
    await env?.server.stop();
    cleanupTmpDirs();
  });

  it('anuncia as 4 ferramentas do terminal no "system init" mesmo com o modo Silencioso (o handshake MCP sempre acontece)', async () => {
    await attach(client);
    const cwd = tmpCwd();
    const sid = await createSession(client, { cwd });

    const initEvt = await client.waitFor(
      (e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'system' && e.data.msg.subtype === 'init',
      15_000,
      'system init com o resultado do handshake MCP',
    );
    const initMsg = initEvt.data.msg;
    expect(initMsg.mcp_servers).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'connected' })]));
    for (const t of Object.values(TOOL)) expect(initMsg.tools).toContain(t);

    // A conversa nunca ligou o modo Terminal ao Vivo: mesmo assim as ferramentas já foram
    // registradas (tools/list) e o Claude sabe delas — só o USO real é que fica bloqueado.
    const t1 = await turn(client, sid, 'termtools');
    const reply = assistantText(t1.msgs);
    for (const t of Object.values(TOOL)) expect(reply).toContain(t);
    expect(reply).toContain('instruções: sim');
  });

  it('liga o modo Terminal ao Vivo e roda um comando real por PTY: a saída (calculada pelo shell) chega em term.data e no tool_result', async () => {
    await attach(client);
    const cwd = tmpCwd();
    const sid = await createSession(client, { cwd });
    const { terminalId } = await setExecMode(client, sid, 'terminal');
    expect(terminalId).toBeTruthy();

    // 137*59=8083: um valor que não aparece em lugar nenhum do texto do comando — só pode ter vindo
    // de o PowerShell de verdade ter calculado a expressão.
    const t1 = await turn(client, sid, `term Write-Output ('DECK-CHECK-' + (137*59))`);
    expect(t1.result.subtype).toBe('success');
    expect(toolResultText(t1.msgs)).toContain('DECK-CHECK-8083');
    expect(allTermData(client, terminalId as string)).toContain('DECK-CHECK-8083');
  });

  it('mantém estado real entre chamadas separadas: cd relativo e variável de shell sobrevivem a turnos distintos', async () => {
    await attach(client);
    const cwd = tmpCwd();
    const sid = await createSession(client, { cwd });
    const { terminalId } = await setExecMode(client, sid, 'terminal');

    await turn(client, sid, `term New-Item -ItemType Directory -Path 'sub-cd-teste' -Force | Out-Null`);
    await turn(client, sid, 'term cd sub-cd-teste');
    const t3 = await turn(client, sid, 'term (Get-Location).Path');
    const loc = toolResultText(t3.msgs) ?? '';
    expect(loc).toContain('sub-cd-teste');
    expect(loc.toLowerCase()).toContain(path.basename(cwd).toLowerCase());

    await turn(client, sid, 'term $decktestvar = 6*7');
    const t5 = await turn(client, sid, 'term $decktestvar');
    expect(toolResultText(t5.msgs)).toMatch(/\b42\b/);
    expect(allTermData(client, terminalId as string)).toContain('42');
  });

  it('modo Silencioso não usa o terminal mesmo já vinculado (recusa sem tocar o PTY real)', async () => {
    await attach(client);
    const cwd = tmpCwd();
    const sid = await createSession(client, { cwd });
    const { terminalId } = await setExecMode(client, sid, 'terminal');
    await setExecMode(client, sid, 'silent');

    const marker = `MARK-SILENT-${crypto.randomUUID().slice(0, 8)}`;
    const t = await turn(client, sid, `term echo ${marker}`);
    expect(toolResultText(t.msgs) ?? '').toContain('DESLIGADO');
    expect(allTermData(client, terminalId as string)).not.toContain(marker);
  });

  it('terminal fechado/perdido recusa sem recriar silenciosamente um novo', async () => {
    await attach(client);
    const cwd = tmpCwd();
    const sid = await createSession(client, { cwd });
    const { terminalId } = await setExecMode(client, sid, 'terminal');
    const before = (await client.call('term.list')).length;
    await client.call('term.close', { id: terminalId });

    const marker = `MARK-LOST-${crypto.randomUUID().slice(0, 8)}`;
    const t = await turn(client, sid, `term echo ${marker}`);
    expect(toolResultText(t.msgs) ?? '').toContain('fechado ou perdido');
    const after = (await client.call('term.list')).length;
    expect(after).toBe(before - 1); // nenhum terminal novo foi criado
  });

  it('modo de planejamento recusa run mesmo com o terminal já vinculado e a permissão concedida', async () => {
    await attach(client);
    const cwd = tmpCwd();
    const sid = await createSession(client, { cwd, permissionMode: 'default' });
    const { terminalId } = await setExecMode(client, sid, 'terminal');
    await client.call('sessions.setMode', { sid, mode: 'plan' });

    const marker = `MARK-PLAN-${crypto.randomUUID().slice(0, 8)}`;
    const t = await turn(client, sid, `term echo ${marker}`, (req) => {
      expect(req.tool_name).toBe(TOOL.run);
      return { behavior: 'allow', updatedInput: req.input };
    });
    expect(toolResultText(t.msgs) ?? '').toContain('modo de planejamento não permite digitar no terminal');
    expect(allTermData(client, terminalId as string)).not.toContain(marker);
  });

  it('não adota silenciosamente um terminal aberto manualmente na mesma janela', async () => {
    await attach(client);
    const cwd = tmpCwd();
    const sid = await createSession(client, { cwd });
    const manual = await client.call('term.open', { hostId: 'local', cwd });
    const { terminalId } = await setExecMode(client, sid, 'terminal');
    expect(terminalId).not.toBe(manual.id);
    const list = await client.call('term.list');
    expect(list.map((t: any) => t.id).sort()).toEqual([manual.id, terminalId].sort());
  });
});

// =====================================================================================
// B) Permissão negada nunca toca o terminal real
// =====================================================================================
describe('Permissão negada não usa o terminal real', () => {
  let env: Env;
  let closeAnchor: () => void;
  beforeAll(async () => {
    env = await startServer({ settings: { ...baseSettings, defaultPermissionMode: 'default' } });
    closeAnchor = await withAnchor(env);
  });
  afterAll(async () => {
    closeAnchor?.();
    await env?.server.stop();
    cleanupTmpDirs();
  });

  it('negar a ferramenta do terminal ao vivo não digita nada de verdade no PTY', async () => {
    const client = env.client;
    await attach(client);
    const cwd = tmpCwd();
    const sid = await createSession(client, { cwd });
    const { terminalId } = await setExecMode(client, sid, 'terminal');

    const marker = `MARK-DENY-${crypto.randomUUID().slice(0, 8)}`;
    const denialMsg = 'Teste: comando não autorizado pelo dono da conversa.';
    const t = await turn(client, sid, `term echo ${marker}`, (req) => {
      expect(req.tool_name).toBe(TOOL.run);
      return { behavior: 'deny', message: denialMsg };
    });
    expect(toolResultText(t.msgs)).toBe(denialMsg);
    expect(assistantText(t.msgs)).toContain('Terminal negado.');
    expect(allTermData(client, terminalId as string)).not.toContain(marker);
  });
});

// =====================================================================================
// C) Isolamento entre janelas (dono da conversa, term.* por janela)
// =====================================================================================
describe('Isolamento entre janelas', () => {
  let env: Env;
  let closeAnchor: () => void;
  beforeAll(async () => {
    env = await startServer({ settings: { ...baseSettings, defaultPermissionMode: 'bypassPermissions' } });
    closeAnchor = await withAnchor(env);
  });
  afterAll(async () => {
    closeAnchor?.();
    await env?.server.stop();
    cleanupTmpDirs();
  });

  it('sessions.create na pasta de outra janela ao vivo falha com "otherwindow"', async () => {
    const clientA = env.client;
    await attach(clientA);
    const cwdA = tmpCwd();
    await createSession(clientA, { cwd: cwdA });

    const clientB = await extraClient(env);
    await attach(clientB);
    await expect(clientB.call('sessions.create', { hostId: 'local', cwd: cwdA })).rejects.toMatchObject({ code: 'otherwindow' });
    clientB.close();
  });

  it('sessions.setExecutionMode de outra janela falha: só a dona da conversa liga o terminal', async () => {
    const clientA = env.client;
    await attach(clientA);
    const cwdA = tmpCwd();
    const sid = await createSession(clientA, { cwd: cwdA });

    const clientB = await extraClient(env);
    await attach(clientB);
    await expect(clientB.call('sessions.setExecutionMode', { sid, mode: 'terminal' })).rejects.toMatchObject({ code: 'otherwindow' });
    // A conversa continua sem terminal: a tentativa de outra janela não teve nenhum efeito.
    clientB.close();
  });

  it('term.* só valem para a janela dona: outra janela não escreve/fecha o terminal alheio, e term.list é escopado', async () => {
    const clientA = env.client;
    await attach(clientA);
    const cwdA = tmpCwd();
    const sidA = await createSession(clientA, { cwd: cwdA });
    const { terminalId } = await setExecMode(clientA, sidA, 'terminal');

    const clientB = await extraClient(env);
    await attach(clientB);
    await expect(clientB.call('term.write', { id: terminalId, data: 'echo intruso\r' })).rejects.toMatchObject({ code: 'noterminal' });
    await expect(clientB.call('term.close', { id: terminalId })).rejects.toMatchObject({ code: 'noterminal' });
    expect(await clientB.call('term.list')).toEqual([]);
    expect((await clientA.call('term.list')).map((t: any) => t.id)).toContain(terminalId);
    clientB.close();
  });

  it('cada janela liga o próprio terminal, sem vazar term.data para quem não é dono', async () => {
    const clientA = env.client;
    await attach(clientA);
    const cwdA = tmpCwd();
    const sidA = await createSession(clientA, { cwd: cwdA });
    const { terminalId: tA } = await setExecMode(clientA, sidA, 'terminal');

    const clientB = await extraClient(env);
    await attach(clientB);
    const cwdB = tmpCwd();
    const sidB = await createSession(clientB, { cwd: cwdB });
    const { terminalId: tB } = await setExecMode(clientB, sidB, 'terminal');
    expect(tA).not.toBe(tB);

    const markerA = `MARK-A-${crypto.randomUUID().slice(0, 6)}`;
    const markerB = `MARK-B-${crypto.randomUUID().slice(0, 6)}`;
    await turn(clientA, sidA, `term echo ${markerA}`);
    await turn(clientB, sidB, `term echo ${markerB}`);

    expect(allTermData(clientA, tA as string)).toContain(markerA);
    expect(allTermData(clientA, tA as string)).not.toContain(markerB);
    expect(allTermData(clientB, tB as string)).toContain(markerB);
    expect(allTermData(clientB, tB as string)).not.toContain(markerA);
    // B nunca deve sequer RECEBER um evento do terminal de A (escopo no servidor, não filtro de UI).
    expect(clientB.events.some((e) => e.event === 'term.data' && e.data.id === tA)).toBe(false);
    expect(clientA.events.some((e) => e.event === 'term.data' && e.data.id === tB)).toBe(false);
    clientB.close();
  });

  it('sem anexar janela (wid indefinido) duas conexões compartilham o mesmo escopo — por isso os testes acima sempre anexam uma janela', async () => {
    const clientX = await extraClient(env); // nunca chama window.attach: wid fica indefinido
    const clientY = await extraClient(env); // idem
    const cwdX = tmpCwd();
    const sidX = await createSession(clientX, { cwd: cwdX });
    const { terminalId } = await setExecMode(clientX, sidX, 'terminal');
    const marker = `MARK-NOWID-${crypto.randomUUID().slice(0, 6)}`;
    await turn(clientX, sidX, `term echo ${marker}`);
    // clientY nunca anexou janela: a wid dela também é "undefined", então o escopo bate igual.
    expect(allTermData(clientY, terminalId as string)).toContain(marker);
    clientX.close();
    clientY.close();
  });
});

// =====================================================================================
// D) Remoto: o mesmo fluxo por SSH, PTY real no servidor
// =====================================================================================
describe.skipIf(!TEST_HOST)(`Terminal ao vivo remoto via ${TEST_HOST} (PTY real por SSH)`, () => {
  const remoteBase = `/tmp/deck-it-term-${crypto.randomBytes(4).toString('hex')}`;
  const remoteFake = `${remoteBase}/fake-claude.mjs`;
  const remoteProj = `${remoteBase}/proj`;
  const projKey = remoteProj.replace(/[^a-zA-Z0-9]/g, '-');
  let env: Env;
  let closeAnchor: () => void;

  const sshRun = (cmd: string) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', TEST_HOST, cmd], { encoding: 'utf8', timeout: 60_000 });
  const scpFile = (cwd: string, src: string, dst: string) =>
    execFileSync('scp', ['-q', '-o', 'BatchMode=yes', src, `${TEST_HOST}:${dst}`], { cwd, timeout: 60_000 });

  beforeAll(async () => {
    sshRun(`mkdir -p '${remoteProj}' && chmod 700 '${remoteBase}'`);
    scpFile(path.join(ROOT, 'test', 'fake-claude'), 'fake-claude.mjs', remoteFake);
    sshRun(`chmod 755 '${remoteFake}'`);
    env = await startServer({ settings: { ...baseSettings, defaultPermissionMode: 'bypassPermissions', hostClaudePath: { [TEST_HOST]: remoteFake } } });
    closeAnchor = await withAnchor(env);
  }, 60_000);

  afterAll(async () => {
    closeAnchor?.();
    await env?.server.stop();
    try {
      sshRun(`rm -rf '${remoteBase}' "$HOME/.claude/projects/${projKey}"`);
    } catch {
      /* limpeza remota é best-effort; não falha o teste por isso */
    }
  });

  it('liga o modo Terminal ao Vivo num servidor remoto e roda um comando real por PTY via SSH', async () => {
    const client = env.client;
    await attach(client);
    const sid = await createSession(client, { hostId: TEST_HOST, cwd: remoteProj }, 60_000);
    const { terminalId } = await setExecMode(client, sid, 'terminal');
    expect(terminalId).toBeTruthy();

    // O shell remoto calcula 6*7: "DECK-REMOTE-42" só pode ter vindo de lá.
    const t = await turn(client, sid, 'term echo DECK-REMOTE-$((6*7))', undefined, 45_000);
    expect(t.result.subtype).toBe('success');
    expect(toolResultText(t.msgs) ?? '').toContain('DECK-REMOTE-42');
    expect(allTermData(client, terminalId as string)).toContain('DECK-REMOTE-42');
  }, 90_000);
});
