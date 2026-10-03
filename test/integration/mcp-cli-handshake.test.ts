// Handshake do servidor MCP "deck_terminal" com o CLI de verdade instalado — SEM passar pelo
// DeckServer/ClaudeSession (isso já é coberto por live-terminal.test.ts com o "Claude falso").
// Aqui o processo é o `claude` real, e este arquivo faz o papel do HOST (o que o Claude Deck faz):
// manda `control_request initialize` (com sdkMcpServers) e responde aos `control_request
// subtype:"mcp_message"` que o próprio CLI manda de volta, usando o TerminalMcpServer de produção
// (src/server/terminal/mcp.ts) — validando o protocolo real, não uma suposição.
//
// ZERO custo de inferência: nunca é mandada nenhuma mensagem `{"type":"user",...}` (nenhum turno,
// nenhum prompt ao modelo). O handshake do MCP (initialize/notifications/initialized/tools-list)
// acontece só com base no `control_request initialize`, antes de qualquer turno — é o que o próprio
// "Claude falso" espelha em test/fake-claude/fake-claude.mjs. Este arquivo verifica se essa suposição
// é verdadeira também no CLI de verdade.
//
// Opt-in explícito (DECK_MCP_HANDSHAKE=1): mesmo sem custo de inferência, isto invoca o binário
// instalado de verdade (usa as credenciais configuradas na máquina para o próprio CLI inicializar).
// Pula sozinho se a variável não estiver ligada ou se nenhum Claude Code local for encontrado.
//
//   $env:DECK_MCP_HANDSHAKE=1; npx vitest run --config vitest.integration.config.ts test/integration/mcp-cli-handshake.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { findLocalClaude, type ClaudeBinary } from '../../src/server/claude/find-local';
import { buildArgs } from '../../src/server/claude/session';
import { TerminalMcpServer, MCP_SERVER_NAME } from '../../src/server/terminal/mcp';

const RUN = process.env.DECK_MCP_HANDSHAKE === '1';
const bins: ClaudeBinary[] = RUN ? findLocalClaude() : [];
const CLAUDE = bins[0];
const log = (s: string) => process.stderr.write(`[mcp-handshake] ${s}\n`);

/** Faz o papel do Claude Deck: manda control_request e responde aos mcp_message do CLI de verdade
 * usando o servidor MCP de produção. Nunca escreve uma mensagem `user` (sem isso não há turno). */
class CliHost {
  proc: ChildProcessWithoutNullStreams;
  private rl: readline.Interface;
  lines: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void; timer: NodeJS.Timeout }[] = [];
  /** Ferramentas nunca são de fato chamadas (não há turno) — a resposta abaixo só existiria se o
   * protocolo estivesse quebrado a ponto de o CLI tentar `tools/call` sem nenhum turno em andamento. */
  mcp = new TerminalMcpServer({ call: async () => ({ content: [{ type: 'text', text: '(inesperado: tools/call sem nenhum turno em andamento)' }], isError: true }) });

  constructor(bin: string, args: string[], cwd: string) {
    this.proc = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcessWithoutNullStreams;
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      this.lines.push(m);
      this.autoAnswerMcp(m);
      for (const w of [...this.waiters])
        if (w.pred(m)) {
          clearTimeout(w.timer);
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
    });
    this.proc.stderr.on('data', (d) => log(`stderr: ${String(d).trim().slice(0, 500)}`));
  }

  private write(o: any) {
    this.proc.stdin.write(JSON.stringify(o) + '\n');
  }

  /** Responde a control_request subtype "mcp_message" do servidor "deck_terminal" com o servidor
   * MCP de produção — o mesmo que a sessão real usa. */
  private autoAnswerMcp(m: any) {
    if (m.type !== 'control_request' || m.request?.subtype !== 'mcp_message') return;
    const reqId = m.request_id;
    const payload = m.request.message;
    if (m.request.server_name !== MCP_SERVER_NAME) {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: reqId, error: `servidor MCP desconhecido: ${m.request.server_name}` } });
      return;
    }
    Promise.resolve(this.mcp.handle(payload)).then((resp) => {
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: reqId, response: { mcp_response: resp ?? { jsonrpc: '2.0', result: {}, id: 0 } } } });
    });
  }

  /** Manda um control_request nosso (do "host") e espera a control_response correspondente. */
  async control(request: any, timeoutMs = 20_000): Promise<any> {
    const id = `host-${crypto.randomUUID()}`;
    const p = this.wait((m) => m.type === 'control_response' && m.response?.request_id === id, timeoutMs);
    this.write({ type: 'control_request', request_id: id, request });
    const m = await p;
    return m.response;
  }

  wait(pred: (m: any) => boolean, timeoutMs = 20_000): Promise<any> {
    const found = this.lines.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const entry = {
        pred,
        resolve: (m: any) => resolve(m),
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(entry), 1);
          reject(new Error('tempo esgotado esperando mensagem do CLI'));
        }, timeoutMs),
      };
      this.waiters.push(entry);
    });
  }

  /** Nenhuma mensagem de turno (assistant/stream_event/result) apareceu: nenhuma inferência ocorreu. */
  get sawInference(): boolean {
    return this.lines.some((m) => m.type === 'assistant' || m.type === 'stream_event' || m.type === 'result');
  }

  kill() {
    this.rl.close();
    try {
      if (process.platform === 'win32' && this.proc.pid) execFileSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else this.proc.kill('SIGKILL');
    } catch {
      /* já encerrado */
    }
  }
}

describe.skipIf(!RUN || !CLAUDE)('Handshake do MCP "deck_terminal" com o CLI de verdade instalado (sem inferência)', () => {
  let host: CliHost | undefined;
  let cwd: string | undefined;

  afterEach(() => {
    host?.kill();
    host = undefined;
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    cwd = undefined;
  });

  it('handshake normal (initialize já com sdkMcpServers, como o Claude Deck sempre faz): tools/list e "system init" batem com o servidor MCP real', async () => {
    log(`usando ${CLAUDE.path} (${CLAUDE.version}, ${CLAUDE.source})`);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-it-handshake-'));
    const args = buildArgs({ mode: 'bypassPermissions' });
    host = new CliHost(CLAUDE.path, args, cwd);

    const r = await host.control({
      subtype: 'initialize',
      sdkMcpServers: [MCP_SERVER_NAME],
      sdkMcpServerConfigs: { [MCP_SERVER_NAME]: { timeout: 60_000 } },
    });
    expect(r.subtype).toBe('success');

    const init = await host.wait((m) => m.type === 'system' && m.subtype === 'init', 25_000);
    log(`system init: mcp_servers=${JSON.stringify(init.mcp_servers)} tools(deck_terminal)=${JSON.stringify((init.tools ?? []).filter((t: string) => t.includes(MCP_SERVER_NAME)))}`);
    expect(init.mcp_servers).toEqual(expect.arrayContaining([expect.objectContaining({ name: MCP_SERVER_NAME, status: 'connected' })]));
    for (const name of ['run', 'send', 'read', 'wait']) expect(init.tools).toContain(`mcp__${MCP_SERVER_NAME}__${name}`);

    expect(host.sawInference, 'nenhuma mensagem de turno deveria ter aparecido: nenhum custo de inferência').toBe(false);
  }, 60_000);

  it('caso de compatibilidade: initialize repetido — 1º sem sdkMcpServers (sessão já em execução), 2º com sdkMcpServers; registra dinamicamente?', async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-it-handshake-'));
    const args = buildArgs({ mode: 'bypassPermissions' });
    host = new CliHost(CLAUDE.path, args, cwd);

    // 1) Como um CLI remoto já rodando antes desta funcionalidade existir: initialize SEM sdkMcpServers.
    const r1 = await host.control({ subtype: 'initialize' });
    expect(r1.subtype).toBe('success');
    const init1 = await host.wait((m) => m.type === 'system' && m.subtype === 'init', 25_000);
    const hasDeckTerminal1 = (init1.mcp_servers ?? []).some((s: any) => s.name === MCP_SERVER_NAME) || (init1.tools ?? []).some((t: string) => t.includes(MCP_SERVER_NAME));
    log(`system init #1 (sem sdkMcpServers): mcp_servers=${JSON.stringify(init1.mcp_servers)}`);
    expect(hasDeckTerminal1, 'sem sdkMcpServers no 1º initialize, o servidor "deck_terminal" não deveria aparecer').toBe(false);

    // 2) initialize DE NOVO, agora com sdkMcpServers — ainda sem nenhuma mensagem de usuário/turno.
    let r2: any;
    let r2Error: string | undefined;
    try {
      r2 = await host.control({ subtype: 'initialize', sdkMcpServers: [MCP_SERVER_NAME], sdkMcpServerConfigs: { [MCP_SERVER_NAME]: { timeout: 60_000 } } });
    } catch (e) {
      r2Error = (e as Error).message;
    }
    log(`initialize #2 (com sdkMcpServers): ${r2Error ? `falhou: ${r2Error}` : JSON.stringify(r2).slice(0, 400)}`);

    // Um 2º "system init" (ou mudança de status) comprovaria registro dinâmico; senão, é preciso um
    // aviso de "não suportado" ou reiniciar/retomar a conversa (ver comentário final do teste).
    let init2: any;
    try {
      init2 = await host.wait((m) => m.type === 'system' && m.subtype === 'init' && m !== init1, 8_000);
    } catch {
      init2 = undefined;
    }
    const status = await host.control({ subtype: 'mcp_status' }).catch((e) => ({ error: (e as Error).message }));
    log(`2º "system init"? ${init2 ? JSON.stringify(init2.mcp_servers) : '(nenhum chegou depois do 2º initialize)'}`);
    log(`mcp_status depois do 2º initialize: ${JSON.stringify(status)}`);
    const registeredDynamically =
      (r2?.subtype === 'success' && (init2?.mcp_servers ?? []).some((s: any) => s.name === MCP_SERVER_NAME)) ||
      (status && !status.error && JSON.stringify(status).includes(MCP_SERVER_NAME));
    log(
      registeredDynamically
        ? 'CONCLUSÃO: o CLI registrou "deck_terminal" dinamicamente num 2º initialize — uma sessão remota já em execução pode ganhar o terminal ao vivo sem reiniciar.'
        : 'CONCLUSÃO: o CLI NÃO expôs "deck_terminal" depois de um 2º initialize nesta versão — uma sessão remota já em execução antes da funcionalidade existir provavelmente precisa reiniciar/retomar (--resume) para ganhar o terminal ao vivo. Considerar aviso na interface.',
    );

    expect(host.sawInference, 'nenhuma mensagem de turno deveria ter aparecido: nenhum custo de inferência').toBe(false);
  }, 60_000);
});
