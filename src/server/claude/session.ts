// Conversas com o Claude Code (uma por aba). Fala o protocolo stream-json do CLI:
// mensagens do usuário, pedidos de permissão (control_request can_use_tool), interrupção etc.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { HostRegistry } from '../hosts/registry';
import { RUNNER_REL } from '../hosts/registry';
import type { Store } from '../config';
import { readJson, writeJsonAtomic } from '../config';
import { LocalTransport, RemoteTransport, type Transport, type EndReason } from './transport';
import { shq } from '../fs/hostfs';
import { DeckError, isSyntheticBreadcrumb } from '../../shared/protocol';
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, TerminalMcpServer, type ToolResult } from '../terminal/mcp';
import { describeResult, type TerminalAgent } from '../terminal/agent';
import {
  LOCAL_HOST_ID,
  type PermissionMode,
  type EffortLevel,
  type SessionCapabilities,
  type SessionPhase,
  type SessionState,
} from '../../shared/types';

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const SAFE_TOKEN = /^[A-Za-z0-9._:\[\]\/@-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildArgs(o: { resume?: string; mode: PermissionMode; model?: string; effort?: EffortLevel }): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
    '--permission-mode',
    MODES.includes(o.mode) ? o.mode : 'default',
    '--allow-dangerously-skip-permissions',
  ];
  if (o.resume) {
    if (!UUID_RE.test(o.resume)) throw new DeckError('bad', 'Id de sessão inválido.');
    args.push('--resume', o.resume);
  }
  if (o.model) {
    if (!SAFE_TOKEN.test(o.model)) throw new DeckError('bad', 'Nome de modelo inválido.');
    args.push('--model', o.model);
  }
  if (o.effort !== undefined) {
    if (!EFFORT_LEVELS.includes(o.effort)) throw new DeckError('bad', 'Nível de esforço inválido.');
    args.push('--effort', o.effort);
  }
  return args;
}

export interface SessionRecord {
  sid: string;
  hostId: string;
  cwd: string;
  sessionId?: string;
  runnerId?: string;
  offset?: number;
  /** Byte logo após o último "result" (começo do turno atual) no arquivo de saída do runner. */
  turnOffset?: number;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  executionMode?: 'silent' | 'terminal';
  /** Réplicas do runner não podem executar novamente uma ferramenta do terminal. */
  terminalCalls?: Record<string, { fingerprint: string; response?: any }>;
  title?: string;
  /** Nome dado pelo usuário (não é trocado pelo título automático do Claude). */
  userTitle?: string;
  userTitleWritten?: boolean;
  /** `title` é provisório (começo do 1º pedido), a ser trocado pelo nome do Claude quando existir. */
  titleFromPrompt?: boolean;
  /** Pedidos de permissão já respondidos (ao reanexar, a saída é relida e eles não podem voltar). */
  answered?: string[];
  /** O processo remoto terminou: não tenta reanexar ao abrir o app (a próxima mensagem retoma). */
  runnerEnded?: boolean;
  createdAt: number;
  /** Janela do app dona da conversa. */
  wid?: string;
  /** Terminou um turno que ninguém viu ainda (ver SessionState.unseen). */
  unseen?: 'done' | 'error';
  /** Começo do turno em andamento (ver SessionState.turnStartedAt): sobrevive ao reinício do app. */
  turnStartedAt?: number;
  /** Início do processo do Claude atual (ms). */
  processStartedAt?: number;
  /** Último começo/fim de turno (ver SessionState.lastActivityAt): sobrevive ao reinício do app. */
  lastActivityAt?: number;
}

/**
 * Quanto o servidor espera depois do fim de um turno antes de marcá-lo como "não visto": se o Claude
 * emendar outro passo (subagentes, hooks), o turno não terminou de verdade e nada é marcado.
 * `CLAUDE_DECK_UNSEEN_DELAY_MS` existe só para os testes.
 */
function unseenDelayMs(): number {
  const n = Number(process.env.CLAUDE_DECK_UNSEEN_DELAY_MS);
  return Number.isFinite(n) && n >= 0 && process.env.CLAUDE_DECK_UNSEEN_DELAY_MS !== '' ? n : 3500;
}

export interface BufferedMsg {
  seq: number;
  msg: any;
}

interface PendingControl {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class ClaudeSession extends EventEmitter {
  state: SessionState;
  private transport: Transport | null = null;
  private outbox: string[] = [];
  private controls = new Map<string, PendingControl>();
  private buffer: BufferedMsg[] = [];
  private bufferBytes = 0;
  private seq = 0;
  offset = 0;
  turnOffset = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private starting: Promise<void> | null = null;
  private closing = false;
  private detaching = false;
  private lastInit: BufferedMsg | null = null;
  private resultsSeen = 0;
  private startedAt = 0;
  private gotInitialize = false;
  pendingPermissions = new Map<string, any>();
  requestedModel?: string;
  private effortChange: Promise<void> | null = null;
  userTitle?: string;
  userTitleWritten = false;
  /** O título é provisório (começo do 1º pedido): o transcript ainda não tinha nome. O do Claude (ai-title) o substitui. */
  titleFromPrompt = false;
  /** Última busca do título no transcript (ms): limita a uma a cada 30 s quando ele ainda não existe. */
  titleTryAt = 0;
  private answered: string[] = [];
  /** Quando cada mensagem do usuário foi enviada (uuid → ms): data/hora no eco de CLIs que não mandam `timestamp`. */
  private sentAt = new Map<string, number>();
  runnerEnded = false;
  private sawIdleKill = false;
  private unseenTimer: NodeJS.Timeout | null = null;
  /** Um turno está em andamento (eco da mensagem do usuário recebido e ainda sem "result"). */
  private inTurn = false;
  /** Ferramentas do terminal ao vivo (servidor MCP hospedado pelo app, pelo canal da conversa). */
  private termMcp = new TerminalMcpServer({ call: (tool, args, signal) => this.callTerminalTool(tool, args, signal) });
  /** O último modo avisado ao Claude (o aviso vai junto da próxima mensagem quando muda). */
  private announcedMode: 'silent' | 'terminal' | null = null;

  constructor(
    rec: SessionRecord,
    private mgr: SessionManager,
  ) {
    super();
    this.state = {
      sid: rec.sid,
      hostId: rec.hostId,
      cwd: rec.cwd,
      sessionId: rec.sessionId,
      title: rec.title,
      phase: 'dormant',
      permissionMode: rec.permissionMode,
      executionMode: rec.executionMode === 'terminal' ? 'terminal' : 'silent',
      model: rec.model,
      effort: EFFORT_LEVELS.includes(rec.effort as EffortLevel) ? rec.effort : undefined,
      runnerId: rec.runnerId,
      createdAt: rec.createdAt,
      wid: rec.wid,
      unseen: rec.unseen === 'done' || rec.unseen === 'error' ? rec.unseen : undefined,
      // Fica guardado enquanto a conversa está "pausada": se o turno continuou no servidor, ao reanexar
      // a contagem segue de onde estava. Qualquer outro caminho (nova partida, fim do turno) o apaga.
      turnStartedAt: typeof rec.turnStartedAt === 'number' && rec.turnStartedAt > 0 ? rec.turnStartedAt : undefined,
      processStartedAt: typeof rec.processStartedAt === 'number' && rec.processStartedAt > 0 ? rec.processStartedAt : undefined,
      lastActivityAt: typeof rec.lastActivityAt === 'number' && rec.lastActivityAt > 0 ? rec.lastActivityAt : undefined,
    };
    // Depois de o app reiniciar, a interface recarrega a conversa do zero: reanexa a partir do
    // começo do turno atual (o que veio antes já está no transcript) para não perder o que
    // o Claude escreveu enquanto o app estava fechado.
    this.turnOffset = rec.turnOffset ?? rec.offset ?? 0;
    this.offset = this.turnOffset;
    this.requestedModel = rec.model;
    this.userTitle = rec.userTitle;
    this.userTitleWritten = !!rec.userTitleWritten;
    this.titleFromPrompt = !!rec.titleFromPrompt && !rec.userTitle;
    this.answered = Array.isArray(rec.answered) ? rec.answered.slice(-50) : [];
    this.terminalCalls = new Map(Object.entries(rec.terminalCalls ?? {}));
    this.runnerEnded = !!rec.runnerEnded;
  }

  get isRemote() {
    return this.state.hostId !== LOCAL_HOST_ID;
  }

  record(): SessionRecord {
    return {
      sid: this.state.sid,
      hostId: this.state.hostId,
      cwd: this.state.cwd,
      sessionId: this.state.sessionId,
      runnerId: this.state.runnerId,
      offset: this.offset,
      turnOffset: this.turnOffset,
      model: this.requestedModel,
      effort: this.state.effort,
      permissionMode: this.state.permissionMode,
      executionMode: this.state.executionMode === 'terminal' ? 'terminal' : undefined,
      terminalCalls: this.terminalCalls.size ? Object.fromEntries(this.terminalCalls) : undefined,
      title: this.state.title,
      userTitle: this.userTitle,
      userTitleWritten: this.userTitleWritten,
      titleFromPrompt: this.titleFromPrompt || undefined,
      answered: this.answered.length ? this.answered : undefined,
      runnerEnded: this.runnerEnded || undefined,
      createdAt: this.state.createdAt,
      wid: this.state.wid,
      unseen: this.state.unseen,
      turnStartedAt: this.state.turnStartedAt,
      processStartedAt: this.state.processStartedAt,
      lastActivityAt: this.state.lastActivityAt,
    };
  }

  /** Passa a conversa para outra janela do app. */
  setOwner(wid: string | undefined) {
    this.setState({ wid });
  }

  /** Initialize do CLI: registra as ferramentas do terminal ao vivo (servidor MCP do app). */
  private initRequest() {
    return {
      subtype: 'initialize',
      sdkMcpServers: [MCP_SERVER_NAME],
      // Comandos de rede podem demorar (backup, ping longo): a ferramenta tem o próprio limite.
      sdkMcpServerConfigs: { [MCP_SERVER_NAME]: { timeout: 31 * 60_000 } },
    };
  }

  private setState(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
    this.mgr.persistSoon();
  }

  private setPhase(phase: SessionPhase, error?: string) {
    if (this.state.phase === phase && this.state.error === error) return;
    const prev = this.state.phase;
    const patch: Partial<SessionState> = { phase, error };
    // Relógio do turno. Começa ao entrar em "trabalhando". Segue igual se só a conexão oscilou
    // ("reconectando") ou se o app reiniciou e a conversa foi carregada do disco ("pausada") e voltou a
    // receber o turno que continuava rodando. Apaga quando o turno acaba (pronto, erro, encerrada, processo
    // que parou) ou quando começa uma partida nova do processo ("iniciando").
    if (phase === 'running') {
      const keeps = (prev === 'running' || prev === 'reconnecting' || prev === 'dormant' || prev === 'starting') && this.state.turnStartedAt;
      patch.turnStartedAt = keeps ? this.state.turnStartedAt : Date.now();
      // Um turno novo começou: o que tinha terminado antes deixou de ser novidade.
      this.cancelUnseenTimer();
      if (this.state.unseen) patch.unseen = undefined;
      // Atividade para ordenar as abas: só turno novo. Oscilar a conexão ou reanexar um turno que já
      // vinha rodando (reinício do app) não conta: é o mesmo turno.
      if (!keeps) patch.lastActivityAt = Date.now();
    } else if (phase !== 'reconnecting') {
      patch.turnStartedAt = undefined;
      // O turno acabou (pronto, erro, processo que parou): também é atividade.
      if (prev === 'running' || prev === 'reconnecting') patch.lastActivityAt = Date.now();
    }
    this.setState(patch);
  }

  private cancelUnseenTimer() {
    if (this.unseenTimer) clearTimeout(this.unseenTimer);
    this.unseenTimer = null;
  }

  /** Marca o fim do turno como "não visto" — depois de uma pausa, se nada recomeçou nesse meio tempo. */
  private flagUnseenSoon(kind: 'done' | 'error') {
    this.cancelUnseenTimer();
    this.unseenTimer = setTimeout(() => {
      this.unseenTimer = null;
      if (this.closing || this.state.phase === 'running' || this.state.phase === 'ended') return;
      if (this.state.unseen !== kind) this.setState({ unseen: kind });
    }, unseenDelayMs());
    this.unseenTimer.unref?.();
  }

  /** Alguém viu a conversa (abriu a aba, voltou para a janela): nada mais a avisar. */
  clearUnseen() {
    this.cancelUnseenTimer();
    if (this.state.unseen) this.setState({ unseen: undefined });
  }

  /** Mensagens em memória para reidratar a interface (turno atual + último init/result). */
  snapshot(): BufferedMsg[] {
    const out = [...this.buffer];
    if (this.lastInit && !out.includes(this.lastInit)) out.unshift(this.lastInit);
    return out;
  }

  private push(msg: any) {
    const entry: BufferedMsg = { seq: ++this.seq, msg };
    if (msg.type === 'system' && msg.subtype === 'init') this.lastInit = entry;
    if (msg.type === 'result') {
      // Turno encerrado: o transcript já tem as mensagens completas; guarda só o resultado.
      this.buffer = [];
      this.bufferBytes = 0;
    }
    const size = JSON.stringify(msg).length;
    this.buffer.push(entry);
    this.bufferBytes += size;
    while ((this.buffer.length > 3000 || this.bufferBytes > 12 * 1024 * 1024) && this.buffer.length > 1) {
      const old = this.buffer.shift()!;
      this.bufferBytes -= JSON.stringify(old.msg).length;
    }
    this.emit('msg', entry);
  }

  /** Inicia (ou retoma com --resume) o processo do Claude. */
  start(): Promise<void> {
    if (this.transport?.alive) return Promise.resolve();
    if (this.starting) return this.starting;
    this.closing = false;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(modeOverride?: PermissionMode, attempt = 0): Promise<void> {
    const { registry, store } = this.mgr;
    // "Iniciando" apaga o relógio do turno; se o processo do servidor ainda estava no meio dele (ramo ALIVE
    // abaixo), a contagem volta de onde estava em vez de recomeçar.
    const carriedTurnStart = this.state.turnStartedAt;
    this.setPhase('starting');
    const mode = modeOverride ?? this.state.permissionMode ?? store.settings.defaultPermissionMode;
    const model = this.requestedModel || store.settings.defaultModel || undefined;
    const args = buildArgs({ resume: this.state.sessionId, mode, model, effort: this.state.effort });
    this.gotInitialize = false;
    this.startedAt = this.state.processStartedAt ?? Date.now();
    this.setState({ processStartedAt: this.startedAt });
    try {
      const status = await registry.connect(this.state.hostId);
      if (!status.claude) {
        throw new DeckError(
          'noclaude',
          this.isRemote
            ? `Claude Code não encontrado em ${this.state.hostId}. Instale com: curl -fsSL https://claude.ai/install.sh | bash`
            : 'Claude Code não encontrado neste computador. Instale pelo site oficial ou configure o caminho nas Configurações.',
        );
      }
      this.setState({ claudeVersion: status.claude.version });
      if (!this.isRemote) {
        if (!fs.existsSync(this.state.cwd)) throw new DeckError('nocwd', `A pasta não existe: ${this.state.cwd}`);
        const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' };
        delete (env as any).NODE_OPTIONS;
        this.terminalCalls.clear(); // processo novo: IDs do anterior não podem colidir
        this.attachTransport(new LocalTransport(status.claude.path, args, this.state.cwd, env));
      } else {
        const runnerId = this.state.runnerId ?? this.state.sid;
        if (!this.state.runnerId) this.setState({ runnerId });
        await registry.ensureRunner(this.state.hostId);
        const ssh = registry.get(this.state.hostId).ssh!;
        const override = store.settings.hostClaudePath[this.state.hostId];
        const binArg = override ? Buffer.from(override).toString('base64') : 'auto';
        const idle = Math.max(1, Math.round((store.settings.remoteIdleHours || 6) * 3600));
        const cmd =
          `exec "\${SHELL:-/bin/sh}" -lc ${shq(
            `sh "$HOME/${RUNNER_REL}" start ${runnerId} ${Buffer.from(this.state.cwd).toString('base64')} ${binArg} ${Buffer.from(args.join(' ')).toString('base64')} ${idle}`,
          )} </dev/null`;
        const r = await ssh.run(cmd, { timeoutMs: 45_000 });
        const last = r.stdout.split('\n').filter((l) => /^(OK|ALIVE|ERR)\b/.test(l)).pop() ?? '';
        if (last.startsWith('ALIVE')) {
          // O processo da conversa ainda roda no servidor (ex.: o app reiniciou): só reanexa.
          this.awaitingInit = true;
          let init: any;
          try {
            await this.attachRemote();
            init = await this.control(this.initRequest(), 45_000);
          } finally {
            this.awaitingInit = false;
          }
          this.gotInitialize = true;
          this.applyInitialize(init);
          const mid = this.inTurn || this.pendingPermissions.size > 0;
          if (mid && carriedTurnStart) this.state = { ...this.state, turnStartedAt: carriedTurnStart };
          this.setPhase(mid ? 'running' : 'idle');
          this.flushOutbox();
          return;
        }
        if (!last.startsWith('OK')) {
          const code = last.split(' ')[1] ?? '';
          const msg =
            code === 'noclaude'
              ? `Claude Code não encontrado em ${this.state.hostId}. Instale com: curl -fsSL https://claude.ai/install.sh | bash`
              : code === 'nocwd'
                ? `A pasta não existe em ${this.state.hostId}: ${this.state.cwd}`
                : `Falha ao iniciar o Claude em ${this.state.hostId}: ${last || r.stderr.trim() || 'sem resposta'}`;
          throw new DeckError(code || 'start', msg);
        }
        const size = Number(last.split(' ')[2]);
        if (Number.isFinite(size) && size >= 0) {
          this.offset = size;
          this.turnOffset = size;
        }
        this.terminalCalls.clear();
        await this.attachRemote();
      }
      // Processo novo: respostas de permissão guardadas eram do processo anterior.
      this.outbox = this.outbox.filter((l) => !l.startsWith('{"type":"control_response"'));
      const init = await this.control(this.initRequest(), 45_000);
      this.gotInitialize = true;
      this.applyInitialize(init);
      this.setPhase('idle');
      this.flushOutbox();
    } catch (e) {
      const err = e as Error;
      // Modo "auto" (ou modelo) não suportado por um CLI antigo: tenta de novo no modo padrão.
      if (attempt === 0 && !this.gotInitialize && mode !== 'default' && /permission|mode|invalid|exited|encerrou/i.test(err.message)) {
        this.mgr.log(`[${this.state.hostId}] reiniciando conversa no modo padrão: ${err.message}`);
        this.transport?.close();
        this.transport = null;
        this.setState({ permissionMode: 'default' });
        return this.doStart('default', 1);
      }
      this.transport?.close();
      this.transport = null;
      this.setPhase('error', err.message);
      throw err;
    }
  }

  private async attachRemote() {
    const ssh = this.mgr.registry.get(this.state.hostId).ssh!;
    const ch = await ssh.exec(`sh "$HOME/${RUNNER_REL}" attach ${this.state.runnerId} ${this.offset}`);
    this.runnerEnded = false;
    this.sawIdleKill = false;
    this.attachTransport(new RemoteTransport(ch));
  }

  private attachTransport(t: Transport) {
    const old = this.transport;
    this.transport = t;
    // Um transporte substituído não pode mais entregar linhas (contaria bytes em dobro).
    if (old && old !== t) old.close();
    t.on('line', (line: string, bytes: number) => {
      if (this.transport === t) this.onLine(line, bytes);
    });
    t.on('end', (info: { reason: EndReason; code?: number | null; stderr?: string }) => {
      if (this.transport !== t) return;
      this.transport = null;
      this.onEnd(info);
    });
  }

  private onEnd(info: { reason: EndReason; code?: number | null; stderr?: string }) {
    for (const [id, c] of this.controls) {
      clearTimeout(c.timer);
      c.reject(new Error('O processo do Claude encerrou.'));
      this.controls.delete(id);
    }
    if (this.detaching) return;
    if (this.closing) {
      this.setPhase('ended');
      return;
    }
    if (info.reason === 'disconnect') {
      this.setPhase('reconnecting');
      this.scheduleReattach();
      return;
    }
    // O processo terminou: a conversa fica "adormecida" e retoma com --resume na próxima mensagem.
    this.pendingPermissions.clear();
    this.answered = [];
    this.inTurn = false;
    this.turnOffset = this.offset;
    if (this.isRemote) {
      this.runnerEnded = true;
      this.mgr.persistSoon();
      const gone = info.reason === 'missing' || (info.reason === 'exit' && info.code === -1);
      if (this.sawIdleKill || gone) {
        // Pausado por inatividade (o aviso já saiu) ou o processo sumiu (servidor reiniciado, limpeza).
        if (!this.sawIdleKill) this.push({ type: 'deck_event', event: 'runner_gone' });
        this.setPhase('dormant');
        return;
      }
    }
    const quick = Date.now() - this.startedAt < 15_000 && !this.gotInitialize;
    const failed = info.reason !== 'killed' && info.code !== 0 && info.code !== 143 && info.code != null;
    const err = failed || quick ? this.describeExit(info) : undefined;
    this.push({ type: 'deck_event', event: 'process_ended', code: info.code ?? null, reason: info.reason, error: err ?? null });
    this.setPhase('dormant', err);
  }

  private describeExit(info: { code?: number | null; stderr?: string }): string {
    const tail = (info.stderr ?? '')
      .split('\n')
      .filter((l) => l.trim() && !/connectors are disabled/i.test(l))
      .slice(-4)
      .join(' | ');
    return `O Claude encerrou (código ${info.code ?? '?'})${tail ? ': ' + tail : ''}`;
  }

  private scheduleReattach() {
    if (this.closing || this.reconnectTimer) return;
    const delays = [500, 1500, 3000, 6000, 10000, 20000, 30000];
    const d = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reattach().catch((e) => {
        this.mgr.log(`[${this.state.hostId}] reanexar ${this.state.sid.slice(0, 8)} falhou: ${(e as Error).message}`);
        if (e instanceof DeckError && e.code === 'missing') return;
        this.scheduleReattach();
      });
    }, d);
  }

  /** Reconecta ao runner remoto a partir do último byte recebido (chamadas simultâneas viram uma só). */
  reattach(): Promise<void> {
    if (this.reattaching) return this.reattaching;
    this.reattaching = this.doReattach().finally(() => {
      this.reattaching = null;
    });
    return this.reattaching;
  }

  private reattaching: Promise<void> | null = null;

  private async doReattach(): Promise<void> {
    if (!this.isRemote || !this.state.runnerId) return;
    if (this.transport?.alive) return;
    if (this.starting) return;
    this.setPhase('reconnecting');
    await this.mgr.registry.connect(this.state.hostId);
    await this.mgr.registry.ensureRunner(this.state.hostId);
    this.awaitingInit = true;
    let init: any = null;
    try {
      await this.attachRemote();
      // Se o runner não existe mais, o transporte termina com 'missing' e vira "adormecida".
      init = await this.control(this.initRequest(), 30_000).catch(() => null);
    } finally {
      this.awaitingInit = false;
    }
    if (!this.transport?.alive) {
      // O processo acabou: se o usuário mandou algo enquanto reconectava, retoma com --resume.
      if (!this.closing && this.outbox.some((l) => l.startsWith('{"type":"user"'))) this.start().catch(() => {});
      return;
    }
    this.reconnectAttempt = 0;
    if (init) {
      this.gotInitialize = true;
      this.applyInitialize(init);
    }
    if (this.state.phase === 'reconnecting' || (this.state.phase === 'running' && !this.inTurn && !this.pendingPermissions.size))
      this.setPhase(this.inTurn || this.pendingPermissions.size ? 'running' : 'idle');
    this.flushOutbox();
  }

  private applyInitialize(resp: any) {
    const caps: SessionCapabilities = {
      models: (resp?.models ?? []).map((m: any) => ({
        value: String(m.value),
        displayName: String(m.displayName ?? m.value),
        description: m.description,
        supportsAutoMode: m.supportsAutoMode,
      })),
      commands: (resp?.commands ?? []).map((c: any) => ({ name: String(c.name), description: String(c.description ?? ''), argumentHint: c.argumentHint })),
      account: resp?.account
        ? {
            email: resp.account.email,
            subscriptionType: resp.account.subscriptionType,
            apiProvider: resp.account.apiProvider,
            tokenSource: resp.account.tokenSource,
          }
        : undefined,
    };
    this.mgr.setCaps(this.state.hostId, caps);
    if (resp?.current_permission_mode) this.setState({ permissionMode: resp.current_permission_mode });
    // Pedidos de permissão que ficaram pendentes enquanto a interface estava desconectada.
    for (const pr of resp?.pending_permission_requests ?? []) {
      const req = pr?.request ?? pr;
      const rid = pr?.request_id;
      if (rid && !this.pendingPermissions.has(rid)) {
        const msg = { type: 'control_request', request_id: rid, request: req };
        this.pendingPermissions.set(rid, msg);
        this.push(msg);
      }
    }
  }

  private onLine(line: string, bytes: number) {
    this.offset += bytes;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Ecos e breadcrumbs sintéticos do CLI (ex.: ao trocar modelo via set_model):
    // não representam mensagens reais do usuário nem iniciam turnos de trabalho.
    if (isSyntheticBreadcrumb(msg)) return;
    // Reanexou e a saída voltou a fluir: não espera a resposta do "initialize" (o CLI só responde
    // no fim do turno em andamento) para mostrar que está trabalhando.
    // (O que o usuário mandar continua na fila até o "initialize" provar que o processo está vivo.)
    if (this.state.phase === 'reconnecting' && this.transport?.alive && (msg.type === 'stream_event' || msg.type === 'assistant' || msg.type === 'user')) {
      this.reconnectAttempt = 0;
      this.setPhase('running');
    }
    if (msg.type === 'control_response') {
      const rid = msg.response?.request_id;
      const pending = rid ? this.controls.get(rid) : undefined;
      if (pending) {
        clearTimeout(pending.timer);
        this.controls.delete(rid);
        if (msg.response.subtype === 'error') pending.reject(new DeckError('control', msg.response.error ?? 'erro'));
        else pending.resolve(msg.response.response ?? {});
        return;
      }
      // Eco de uma resposta de permissão (de qualquer cliente): resolve o pedido.
      if (rid) this.pendingPermissions.delete(rid);
      this.push(msg);
      return;
    }
    if (msg.type === 'control_request') {
      const sub = msg.request?.subtype;
      if (sub === 'can_use_tool') {
        // Relido do arquivo de saída ao reanexar, mas já respondido antes: não pergunta de novo.
        if (this.answered.includes(msg.request_id)) return;
        // Ler a tela e esperar não digitam nada no terminal: liberados sem perguntar.
        const tn = msg.request?.tool_name;
        if (this.state.executionMode === 'terminal' && (tn === 'Bash' || tn === 'PowerShell')) {
          this.writeControlResponse({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id,
            response: { behavior: 'deny', message: `Terminal ao Vivo está ativo. Use ${MCP_TOOL_PREFIX}run no terminal vinculado, não execução invisível.` } } });
          return;
        }
        if (tn === `${MCP_TOOL_PREFIX}read` || tn === `${MCP_TOOL_PREFIX}wait`) {
          this.answered.push(msg.request_id);
          if (this.answered.length > 50) this.answered.shift();
          this.writeControlResponse({
            type: 'control_response',
            response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'allow', updatedInput: msg.request.input ?? {} } },
          });
          return;
        }
        this.pendingPermissions.set(msg.request_id, msg);
        this.push(msg);
        this.emit('attention', { kind: 'permission', tool: msg.request?.tool_name });
        return;
      }
      if (sub === 'mcp_message') {
        this.onMcpMessage(msg);
        return;
      }
      if (sub === 'elicitation') {
        this.writeLine(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { action: 'decline' } } }));
        return;
      }
      this.writeLine(
        JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Pedido "${sub}" não suportado pelo Claude Deck.` } }),
      );
      return;
    }
    if (msg.type === 'control_cancel_request') {
      const mcpId = this.mcpRequestIds.get(msg.request_id);
      if (mcpId !== undefined) this.termMcp.cancel(mcpId);
      this.pendingPermissions.delete(msg.request_id);
      this.push(msg);
      return;
    }
    if (msg.type === 'keep_alive') return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      const patch: Partial<SessionState> = { model: msg.model, permissionMode: msg.permissionMode, claudeVersion: msg.claude_code_version };
      if (msg.session_id && msg.session_id !== this.state.sessionId) patch.sessionId = msg.session_id;
      this.setState(patch);
    } else if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode) {
      this.setState({ permissionMode: msg.permissionMode });
    } else if (msg.type === 'user' && msg.isReplay) {
      if (!msg.timestamp && msg.uuid && this.sentAt.has(msg.uuid)) msg.timestamp = new Date(this.sentAt.get(msg.uuid)!).toISOString();
      this.inTurn = true;
      if (this.state.phase !== 'running') this.setPhase('running');
    } else if (msg.type === 'stream_event' || msg.type === 'assistant') {
      if (this.state.phase === 'idle') this.setPhase('running');
    } else if (msg.type === 'result') {
      this.resultsSeen++;
      this.turnOffset = this.offset;
      // IDs e offset são salvos na mesma escrita atômica. Turnos concluídos não são relidos.
      this.terminalCalls.clear();
      this.answered = [];
      this.inTurn = false;
      if (this.state.phase === 'running' || this.state.phase === 'reconnecting') this.setPhase('idle');
      this.pendingPermissions.clear();
      this.emit('attention', { kind: 'done', error: msg.is_error, subtype: msg.subtype });
      this.flagUnseenSoon(msg.is_error ? 'error' : 'done');
      if (this.resultsSeen <= 3 || !this.state.title || this.titleFromPrompt || (this.userTitle && !this.userTitleWritten)) this.mgr.scheduleTitleRefresh(this);
      // Remoto: grava o novo começo de turno na hora. Se o app cair logo depois do fim do turno,
      // ao reanexar ele não relê o turno anterior (o "result" antigo apareceria fora do lugar).
      if (this.isRemote) this.mgr.persistNow();
      else this.mgr.persistSoon();
    } else if (msg.type === 'deck_runner' && msg.event === 'idle_kill') {
      this.sawIdleKill = true;
      this.push({ type: 'deck_event', event: 'idle_kill' });
      return;
    }
    this.push(msg);
  }

  /** Registro durável antes de digitar: uma queda entre envio e resultado nunca causa retry cego. */
  private terminalCalls = new Map<string, { fingerprint: string; response?: any }>();
  private mcpTasks = new Map<string, Promise<any>>();
  private mcpRequestIds = new Map<string, string | number>();

  private onMcpMessage(msg: any) {
    const reqId = msg.request_id;
    const payload = msg.request?.message;
    if (typeof reqId !== 'string') return;
    const answer = (mcp_response: any) => this.writeControlResponse({
      type: 'control_response', response: { subtype: 'success', request_id: reqId, response: { mcp_response } },
    });
    const error = (message: string) => ({ jsonrpc: '2.0', id: payload?.id ?? 0,
      result: { isError: true, content: [{ type: 'text', text: message }] } });
    if (msg.request?.server_name !== MCP_SERVER_NAME) {
      answer(error('Servidor MCP desconhecido.'));
      return;
    }
    if (payload?.method !== 'tools/call' || payload.id == null) {
      this.termMcp.handle(payload).then((r) => answer(r ?? { jsonrpc: '2.0', result: {}, id: 0 })).catch((e) => answer(error(String(e))));
      return;
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const old = this.terminalCalls.get(reqId);
    if (old) {
      if (old.fingerprint !== fingerprint) return answer(error('ID repetido com conteúdo diferente; nada foi executado.'));
      const pending = this.mcpTasks.get(reqId);
      if (pending) { void pending.then(answer); return; }
      answer(old.response ?? error('O app perdeu a conexão durante esta chamada. Ela pode ter executado antes da queda e NÃO será repetida. Leia o terminal e confirme o estado com o usuário antes de qualquer novo comando.'));
      return;
    }
    // Limite por turno: falhar fechado é preferível a descartar um ID que o runner pode repetir.
    if (this.terminalCalls.size >= 2000) return answer(error('Limite de chamadas neste turno atingido. Encerre o turno antes de continuar.'));
    const entry: { fingerprint: string; response?: any } = { fingerprint };
    this.terminalCalls.set(reqId, entry);
    try {
      this.mgr.persistNow(true);
    } catch {
      this.terminalCalls.delete(reqId);
      answer(error('Não foi possível gravar a proteção contra repetição. Nenhum comando foi enviado.'));
      return;
    }
    this.mcpRequestIds.set(reqId, payload.id);
    const task = this.termMcp.handle(payload).catch((e) => error(String(e))).then((response) => {
      entry.response = response;
      // O marcador anterior continua no disco se esta gravação falhar: nunca reexecutar.
      this.mgr.persistNow();
      return response;
    });
    this.mcpTasks.set(reqId, task);
    void task.then(answer).finally(() => {
      this.mcpTasks.delete(reqId);
      this.mcpRequestIds.delete(reqId);
    });
  }

  /** Controle nunca espera initialize: o próprio handshake MCP depende destas respostas. */
  private writeControlResponse(message: any) {
    const line = JSON.stringify(message);
    if (this.transport?.alive) this.transport.write(line);
    else this.outbox.push(line);
  }

  /** Executa uma ferramenta do terminal ao vivo (o app decide qual terminal é o desta conversa). */
  private async callTerminalTool(tool: string, args: any, signal: AbortSignal): Promise<ToolResult> {
    const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
    if (this.state.executionMode !== 'terminal') {
      return text(
        'O modo Terminal ao Vivo está DESLIGADO nesta conversa (o usuário escolheu o modo Silencioso). Não use o terminal ao vivo: rode os comandos com a ferramenta Bash normalmente. Se o usuário quiser ver no terminal, ele liga o modo no botão "Terminal ao Vivo".',
        true,
      );
    }
    if (!['run', 'send', 'read', 'wait'].includes(tool)) return text('Ferramenta desconhecida.', true);
    if (signal.aborted) return text('Chamada cancelada antes de enviar qualquer comando.', true);
    if ((tool === 'run' || tool === 'send') && this.state.permissionMode === 'plan') return text('O modo de planejamento não permite digitar no terminal. Peça ao usuário para mudar o modo de permissão.', true);
    const binder = this.mgr.terminals;
    if (!binder) return text('Terminal ao vivo indisponível neste servidor do Claude Deck.', true);
    // Uma sessão ssh perdida nunca vira silenciosamente um shell novo no bastion.
    if (!this.state.terminalId) return text('O terminal vinculado foi fechado ou perdido. Não enviei nada. Peça ao usuário para desligar e ligar Terminal ao Vivo, conferir o destino e continuar.', true);
    const term = await binder.bind(this);
    if (signal.aborted || this.state.executionMode !== 'terminal') return text('Chamada cancelada antes de enviar qualquer comando.', true);
    // O usuário vê o Claude digitando: mostra o painel e a aba deste terminal.
    if (tool === 'run' || tool === 'send') binder.reveal(term, this);
    const secs = (v: any, def: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1000 : def);
    const agent = binder.agent();
    switch (tool) {
      case 'run': {
        const command = typeof args?.command === 'string' ? args.command : '';
        if (!command.trim()) return text('Informe o comando em "command".', true);
        const r = await agent.run(term, command, { timeoutMs: secs(args.timeout_seconds, 60_000), quietMs: secs(args.quiet_seconds, 1500), signal });
        return text(describeResult(r));
      }
      case 'send': {
        const r = await agent.send(term, { text: typeof args?.text === 'string' ? args.text : undefined, keys: Array.isArray(args?.keys) ? args.keys.map(String) : undefined }, { signal });
        return text(describeResult(r));
      }
      case 'read': {
        const r = await agent.read(term, typeof args?.lines === 'number' ? args.lines : 60);
        return text(`${r.fullScreen ? '[programa em tela cheia: esta é a tela atual]\n' : ''}${r.output || '(tela vazia)'}\n\n--- última linha: ${JSON.stringify(r.lastLine)}`);
      }
      case 'wait': {
        const r = await agent.wait(term, { timeoutMs: secs(args?.timeout_seconds, 60_000), quietMs: secs(args?.quiet_seconds, 1500), signal });
        return text(describeResult(r));
      }
      default:
        return text(`Ferramenta desconhecida: ${tool}`, true);
    }
  }

  /** Liga/desliga o modo Terminal ao Vivo (vale a partir da próxima mensagem; não reinicia o Claude). */
  setExecutionMode(mode: 'silent' | 'terminal') {
    if (mode !== 'silent' && mode !== 'terminal') throw new DeckError('bad', 'Modo inválido.');
    if (mode === 'silent') this.termMcp.abortAll();
    this.setState({ executionMode: mode });
  }

  /** Terminal ligado a esta conversa (pelo gerenciador). */
  setTerminal(id: string | undefined) {
    if (this.state.terminalId !== id) this.setState({ terminalId: id });
  }

  /** Aviso ao Claude quando o modo muda (entra na mensagem do usuário, invisível na conversa). */
  private modeNotice(): string {
    const mode = this.state.executionMode === 'terminal' ? 'terminal' : 'silent';
    // Mesmo ao retomar histórico antigo, anuncia o modo atual, não o que ficou no transcript.
    if (this.announcedMode === mode) return '';
    this.announcedMode = mode;
    return mode === 'terminal'
      ? `<system-reminder>\nO usuário LIGOU o modo Terminal ao Vivo do Claude Deck. A partir de agora, execute todo comando de shell/rede com as ferramentas ${MCP_TOOL_PREFIX}run (uma linha por chamada), ${MCP_TOOL_PREFIX}send (teclas: ctrl+c, space, y...), ${MCP_TOOL_PREFIX}read e ${MCP_TOOL_PREFIX}wait, e NÃO com Bash: o usuário está vendo esse terminal ao lado da conversa e quer acompanhar os comandos sendo digitados e a saída real (inclusive ssh para equipamentos a partir deste servidor). O terminal guarda o estado entre comandos (pasta, ssh aberto, modo de configuração do equipamento). Continue usando Read/Edit/Write/Grep para arquivos.\n</system-reminder>\n`
      : `<system-reminder>\nO usuário DESLIGOU o modo Terminal ao Vivo (voltou ao modo Silencioso). Rode comandos com a ferramenta Bash normalmente; as ferramentas ${MCP_TOOL_PREFIX}* não estão mais liberadas.\n</system-reminder>\n`;
  }

  private writeLine(line: string) {
    if (this.transport?.alive && this.state.phase !== 'reconnecting' && !this.awaitingInit) this.transport.write(line);
    else this.outbox.push(line);
  }

  /** Reanexando: ainda não se sabe se o processo está vivo (fila segura até o "initialize"). */
  private awaitingInit = false;

  private flushOutbox() {
    if (!this.transport?.alive) return;
    const lines = this.outbox;
    this.outbox = [];
    for (const l of lines) this.transport.write(l);
  }

  /** Envia um pedido de controle ao CLI e espera a resposta. */
  control(request: any, timeoutMs = 30_000): Promise<any> {
    const id = `deck-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        reject(new DeckError('timeout', `O Claude não respondeu ao pedido "${request.subtype}".`));
      }, timeoutMs);
      this.controls.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ type: 'control_request', request_id: id, request });
      if (this.transport?.alive) this.transport.write(line);
      else {
        clearTimeout(timer);
        this.controls.delete(id);
        reject(new DeckError('notrunning', 'O Claude não está rodando nesta conversa.'));
      }
    });
  }

  /** Mensagem do usuário (conteúdo no formato da API: blocos de texto e imagem). */
  async send(content: any[], uuid: string) {
    if (!Array.isArray(content) || !content.length) throw new DeckError('bad', 'Mensagem vazia.');
    if (!UUID_RE.test(uuid)) throw new DeckError('bad', 'uuid inválido');
    if (this.effortChange) await this.effortChange;
    if (!this.sentAt.has(uuid)) {
      this.sentAt.set(uuid, Date.now());
      if (this.sentAt.size > 200) this.sentAt.delete(this.sentAt.keys().next().value!);
    }
    const notice = this.modeNotice();
    if (notice) content = [{ type: 'text', text: notice }, ...content];
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.state.sessionId ?? '',
      uuid,
      origin: { kind: 'human' },
    });
    if (!this.transport?.alive && this.state.phase !== 'reconnecting') {
      this.outbox.push(line);
      await this.start();
      return;
    }
    this.writeLine(line);
    if (this.state.phase === 'idle') this.setPhase('running');
  }

  respond(requestId: string, response: any) {
    this.pendingPermissions.delete(requestId);
    if (!this.answered.includes(requestId)) {
      this.answered.push(requestId);
      if (this.answered.length > 50) this.answered.shift();
      // Grava já: se o app cair logo depois, o pedido não reaparece como pendente ao reanexar.
      if (this.isRemote) this.mgr.persistNow();
    }
    const line = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    // Resposta de permissão vai direto se o transporte está vivo, mesmo reanexando: o CLI só
    // responde ao "initialize" depois do turno, e o turno pode estar parado esperando esta resposta.
    if (this.transport?.alive) this.transport.write(line);
    else this.outbox.push(line);
  }

  async interrupt() {
    // Parar também para de esperar o comando no terminal (o comando em si segue lá; o usuário vê).
    this.termMcp.abortAll();
    // Parar logo depois de enviar, com o processo ainda iniciando/reanexando: a mensagem ainda está na
    // fila e nunca chegou ao Claude. Sai da fila (não roda depois, sozinha). Se um turno anterior está em
    // andamento (reanexando no meio dele), a da fila é a PRÓXIMA mensagem: fica, e o turno é que para.
    if ((this.starting || this.awaitingInit || !this.transport?.alive) && !this.inTurn) {
      const before = this.outbox.length;
      this.outbox = this.outbox.filter((l) => !l.startsWith('{"type":"user"'));
      if (this.outbox.length !== before) {
        this.push({ type: 'deck_event', event: 'interrupted_before_start' });
        if (this.state.phase === 'running') this.setPhase(this.transport?.alive ? 'idle' : 'dormant');
      }
    }
    // Processo já de pé (mesmo antes do "initialize" responder): a mensagem pode já ter ido para ele.
    if (!this.transport?.alive) return;
    await this.control({ subtype: 'interrupt' }, 15_000);
  }

  async setPermissionMode(mode: PermissionMode) {
    if (!MODES.includes(mode)) throw new DeckError('bad', 'Modo inválido.');
    if (this.transport?.alive && this.state.phase !== 'reconnecting') {
      await this.control({ subtype: 'set_permission_mode', mode });
    }
    this.setState({ permissionMode: mode });
  }

  async setModel(model: string | null) {
    if (model && !SAFE_TOKEN.test(model)) throw new DeckError('bad', 'Modelo inválido.');
    this.requestedModel = model ?? undefined;
    if (this.transport?.alive && this.state.phase !== 'reconnecting') {
      await this.control({ subtype: 'set_model', model: model ?? 'default' });
    }
    this.setState({ model: model || undefined });
  }

  /** O CLI aceita --effort ao iniciar, mas não há controle stream-json para trocá-lo em execução. */
  async setEffort(effort: EffortLevel | null) {
    if (effort !== null && !EFFORT_LEVELS.includes(effort)) throw new DeckError('bad', 'Nível de esforço inválido.');
    if (this.effortChange || this.starting || this.reattaching || this.inTurn || this.pendingPermissions.size || this.outbox.length || !['idle', 'dormant'].includes(this.state.phase))
      throw new DeckError('busy', 'Espere o Claude terminar a tarefa antes de mudar o esforço.');
    if (this.isRemote && this.state.runnerId && !this.runnerEnded && !this.transport?.alive)
      throw new DeckError('busy', 'Aguarde esta conversa reconectar ao servidor antes de mudar o esforço.');
    const next = effort ?? undefined;
    if (next === this.state.effort) return;
    const change = this.changeEffort(next);
    this.effortChange = change;
    try {
      await change;
    } finally {
      this.effortChange = null;
    }
  }

  private async changeEffort(next: EffortLevel | undefined) {
    const previous = this.state.effort;
    const old = this.transport?.alive ? this.transport : null;
    if (old) {
      this.setPhase('starting');
      // Não deixar a saída atrasada do processo antigo alterar a conversa recém-reiniciada.
      this.transport = null;
      if (this.isRemote) {
        old.close(); // Fecha só o canal de leitura. O runner é parado explicitamente abaixo.
        try {
          const ssh = this.mgr.registry.get(this.state.hostId).ssh;
          if (!ssh?.connected || !this.state.runnerId) throw new Error('Conexão SSH indisponível.');
          const stopped = await ssh.run(`sh "$HOME/${RUNNER_REL}" stop ${this.state.runnerId}`, { timeoutMs: 15_000 });
          if (!/^OK\b/m.test(stopped.stdout)) throw new Error(stopped.stderr || stopped.stdout || 'O runner não confirmou a parada.');
          this.runnerEnded = true;
        } catch (e) {
          // Não iniciar outro processo enquanto o anterior pode ainda estar vivo.
          this.setPhase('dormant');
          throw new DeckError('effort', `Não reiniciei o Claude: ${(e as Error).message}`);
        }
      } else {
        const ended = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('O processo anterior não encerrou a tempo.')), 15_000);
          old.once('end', () => { clearTimeout(timeout); resolve(); });
        });
        old.close();
        try {
          await ended;
        } catch (e) {
          this.setPhase('error', (e as Error).message);
          throw new DeckError('effort', 'Não iniciei outro Claude porque o processo anterior não confirmou que encerrou.');
        }
      }
    }
    this.setState({ effort: next });
    try {
      this.mgr.persistNow(true);
      if (old) await this.start(); // Mesmo sessionId: --resume preserva a conversa e todas as abas.
    } catch (e) {
      this.setState({ effort: previous });
      if (old) {
        try {
          if (this.isRemote && this.state.runnerId) {
            const ssh = this.mgr.registry.get(this.state.hostId).ssh;
            if (ssh?.connected) await ssh.run(`sh "$HOME/${RUNNER_REL}" stop ${this.state.runnerId}`, { timeoutMs: 15_000 });
            this.runnerEnded = true;
          }
          await this.start();
        } catch (restoreError) {
          this.setPhase('error', `Não consegui retomar com o esforço anterior: ${(restoreError as Error).message}`);
        }
      }
      this.mgr.persistSoon();
      throw new DeckError('effort', `Não apliquei o nível de esforço: ${(e as Error).message}`);
    }
  }

  setTitle(title: string, byUser = false) {
    const t = title.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (byUser) {
      this.userTitle = t || undefined;
      this.userTitleWritten = false;
    }
    this.titleFromPrompt = false; // quem define um título provisório o marca logo depois (ver refreshTitle)
    this.setState({ title: t || undefined });
  }

  /** A aba foi fechada e o processo está sendo encerrado: não conta mais como conversa aberta. */
  get isClosing() {
    return this.closing;
  }

  /** Fecha a aba: encerra o processo (local) ou o runner (remoto). */
  async close() {
    this.closing = true;
    this.cancelUnseenTimer();
    this.termMcp.abortAll();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.transport?.close();
    this.transport = null;
    if (this.isRemote && this.state.runnerId) {
      const ssh = this.mgr.registry.get(this.state.hostId).ssh;
      if (ssh?.connected) await ssh.run(`sh "$HOME/${RUNNER_REL}" stop ${this.state.runnerId}`, { timeoutMs: 15_000 }).catch(() => {});
    }
    this.setPhase('ended');
  }

  /** Desanexa sem mudar o estado salvo — usado ao fechar o app (remoto continua no servidor). */
  detach() {
    this.detaching = true;
    this.cancelUnseenTimer();
    this.termMcp.abortAll();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.transport?.close();
  }

  get alive() {
    return !!this.transport?.alive;
  }

  /** Para testes: derruba o transporte como se a rede tivesse caído. */
  dropForTest() {
    (this.transport as any)?.ch?.destroy?.();
  }
}

/** Liga as conversas aos terminais do app (definido pelo servidor do Claude Deck). */
export interface TerminalBinder {
  agent: () => TerminalAgent;
  /** Terminal desta conversa: o ligado a ela, ou abre um novo no servidor/pasta dela. */
  bind(s: ClaudeSession, prefer?: string, create?: boolean): Promise<string>;
  /** Mostra o painel e a aba do terminal (o Claude vai digitar). */
  reveal(id: string, s: ClaudeSession): void;
}

export class SessionManager extends EventEmitter {
  sessions = new Map<string, ClaudeSession>();
  caps = new Map<string, SessionCapabilities>();
  terminals?: TerminalBinder;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    public registry: HostRegistry,
    public store: Store,
    public log: (m: string) => void,
    public titleReader: (s: ClaudeSession) => Promise<string | undefined> = async () => undefined,
    /** Grava o nome dado pelo usuário no transcript; devolve false se o transcript ainda não existe. */
    public titleWriter: (s: ClaudeSession, title: string) => Promise<boolean> = async () => false,
    /** Nome provisório (começo do 1º pedido) para transcripts que ainda não têm nome do Claude nem do usuário. */
    public titleFallback: (s: ClaudeSession) => Promise<string | undefined> = async () => undefined,
  ) {
    super();
    // Servidor que acabou de conectar: as conversas dele que estavam sem nome (abas restauradas) ganham o nome.
    registry.on('status', (st: { id: string; state: string }) => {
      if (st.state !== 'ready') return;
      for (const s of this.sessions.values()) if (s.state.hostId === st.id) this.ensureTitle(s);
    });
    // Lista de modelos/comandos da última execução: aparece nas Configurações e no composer antes do CLI iniciar.
    for (const [hostId, c] of Object.entries(store.hosts.caps ?? {}))
      if (Array.isArray(c?.models) && c.models.length) this.caps.set(hostId, { models: c.models, commands: Array.isArray(c.commands) ? c.commands : [] });
    // Reconecta sessões remotas quando uma conexão cai.
    registry.on('conn-closed', (hostId: string) => {
      for (const s of this.sessions.values()) if (s.state.hostId === hostId && !s.alive && s.state.phase === 'running') s.reattach().catch(() => {});
    });
  }

  load() {
    const recs = readJson<SessionRecord[]>(this.store.paths.sessionsFile, []);
    for (const r of recs) if (r?.sid && r.hostId && r.cwd) this.add(new ClaudeSession(r, this));
    // Abas restauradas sem nome: as locais já; as remotas quando o servidor conectar (ver construtor).
    for (const s of this.sessions.values()) if (!s.isRemote) this.ensureTitle(s);
  }

  persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 500);
  }

  persistNow(strict = false) {
    try {
      writeJsonAtomic(
        this.store.paths.sessionsFile,
        [...this.sessions.values()].filter((s) => s.state.phase !== 'ended').map((s) => s.record()),
      );
    } catch (e) {
      this.log(`falha ao gravar sessões: ${(e as Error).message}`);
      if (strict) throw e;
    }
  }

  /** Fecha/remoto pode demorar: retomadas esperam o encerramento antes de iniciar outro processo. */
  private closeTasks = new Map<string, Promise<void>>();

  async waitForClose(sid: string) {
    const pending = this.closeTasks.get(sid);
    if (pending) await pending;
  }

  private add(s: ClaudeSession) {
    this.sessions.set(s.state.sid, s);
    s.on('state', (st) => this.emit('state', st));
    s.on('msg', (m: BufferedMsg) => this.emit('msg', s.state.sid, m));
    s.on('attention', (a) => this.emit('attention', s.state, a));
    return s;
  }

  create(o: {
    hostId: string;
    cwd: string;
    resume?: string;
    permissionMode?: PermissionMode;
    executionMode?: 'silent' | 'terminal';
    model?: string;
    title?: string;
    start?: boolean;
    wid?: string;
  }) {
    const sid = crypto.randomUUID();
    const s = this.add(
      new ClaudeSession(
        {
          sid,
          hostId: o.hostId,
          cwd: o.cwd,
          sessionId: o.resume,
          permissionMode: o.permissionMode ?? this.store.settings.defaultPermissionMode,
          executionMode: o.executionMode === 'terminal' ? 'terminal' : undefined,
          model: o.model,
          title: o.title,
          createdAt: Date.now(),
          wid: o.wid,
        },
        this,
      ),
    );
    this.persistNow();
    if (o.start !== false) s.start().catch(() => {});
    this.ensureTitle(s); // retomada sem título (vinda de janela/restauração): já busca o nome no transcript
    return s;
  }

  get(sid: string): ClaudeSession {
    const s = this.sessions.get(sid);
    if (!s) throw new DeckError('nosession', 'Conversa não encontrada (talvez já fechada).');
    return s;
  }

  async close(sid: string) {
    const pending = this.closeTasks.get(sid);
    if (pending) return pending;
    const s = this.sessions.get(sid);
    if (!s) return;
    const task = (async () => {
      await s.close();
      this.sessions.delete(sid);
      this.persistNow();
    })();
    this.closeTasks.set(sid, task);
    try {
      await task;
    } finally {
      this.closeTasks.delete(sid);
    }
  }

  setCaps(hostId: string, caps: SessionCapabilities) {
    this.caps.set(hostId, caps);
    this.emit('caps', hostId, caps);
    if (!caps.models.length) return;
    const saved = { models: caps.models, commands: caps.commands };
    const all = this.store.hosts.caps ?? {};
    if (JSON.stringify(all[hostId]) === JSON.stringify(saved)) return;
    this.store.hosts.caps = { ...all, [hostId]: saved };
    this.store.saveHosts();
  }

  async refreshTitle(s: ClaudeSession) {
    if (s.userTitle) {
      // Nome dado pelo usuário: grava no transcript (uma vez) e não deixa o automático trocar.
      if (!s.userTitleWritten && s.state.sessionId && (await this.titleWriter(s, s.userTitle))) {
        s.userTitleWritten = true;
        this.persistSoon();
      }
      return;
    }
    const t = await this.titleReader(s);
    if (t) {
      if (t !== s.state.title || s.titleFromPrompt) s.setTitle(t); // setTitle já tira a marca de provisório
      return;
    }
    if (s.state.title) return;
    const provisional = await this.titleFallback(s);
    if (provisional && !s.state.title) {
      s.setTitle(provisional);
      s.titleFromPrompt = true;
      this.persistSoon();
    }
  }

  /**
   * Conversa retomada ou restaurada sem nome (o título só chegava depois do fim de um turno): busca no
   * transcript agora. Servidor remoto ainda desconectado fica para quando conectar (evento 'status').
   */
  ensureTitle(s: ClaudeSession) {
    if (s.state.title || s.userTitle || !s.state.sessionId) return;
    if (s.isRemote && this.registry.status(s.state.hostId).state !== 'ready') return;
    if (Date.now() - s.titleTryAt < 30_000) return;
    s.titleTryAt = Date.now();
    this.refreshTitle(s).catch((e) => this.log(`título da conversa ${s.state.sid.slice(0, 8)}: ${(e as Error).message}`));
  }

  /** O título automático (ai-title) é gravado pelo CLI alguns segundos depois do 1º turno. */
  scheduleTitleRefresh(s: ClaudeSession) {
    const run = () => {
      if (this.sessions.get(s.state.sid) === s) this.refreshTitle(s).catch(() => {});
    };
    run();
    if (!s.state.title || s.titleFromPrompt || s.userTitle) {
      setTimeout(run, 4000).unref?.();
      setTimeout(run, 15000).unref?.();
    }
  }

  /** Depois que o notebook acorda: reanexa o que caiu. */
  onWake() {
    for (const s of this.sessions.values()) {
      if (s.isRemote && s.state.runnerId && !s.alive && (s.state.phase === 'reconnecting' || s.state.phase === 'running' || s.state.phase === 'idle')) {
        s.reattach().catch(() => {});
      }
    }
  }

  /** Reanexa as conversas remotas que ainda podem estar vivas no servidor. */
  resumeRemote(sids?: string[]) {
    for (const s of this.sessions.values()) {
      if (sids && !sids.includes(s.state.sid)) continue;
      if (s.isRemote && s.state.runnerId && !s.runnerEnded && !s.alive && s.state.phase === 'dormant') {
        s.reattach().catch((e) => {
          this.log(`[${s.state.hostId}] conversa ${s.state.sid.slice(0, 8)} sem runner vivo: ${(e as Error).message}`);
          if (s.state.phase === 'reconnecting') s.state.phase = 'dormant';
          this.emit('state', s.state);
        });
      }
    }
  }

  shutdown() {
    this.persistNow();
    for (const s of this.sessions.values()) {
      if (s.isRemote) s.detach();
      else s.detach();
    }
  }
}
