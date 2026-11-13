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
import { ORQ_IDEMPOTENT, ORQ_SERVER_NAME, ORQ_TOOL_PREFIX, OrqMcpServer, type OrqToolSpec } from '../orq/mcp';
import { describeResult, type TerminalAgent } from '../terminal/agent';
import { isAutoModel, toAutoPick, type AutoDecision } from '../../shared/automodel';
import { normalizeAntigravityEvent } from './antigravityAdapter';
import {
  LOCAL_HOST_ID,
  type AgentEngine,
  type AutoModelPick,
  type PermissionMode,
  type EffortLevel,
  type ModelOption,
  type SessionCapabilities,
  type SessionOrqRole,
  type SessionPhase,
  type SessionState,
} from '../../shared/types';

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const SAFE_TOKEN = /^[A-Za-z0-9._:\[\]\/@-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Leituras sem achar a escolha do gateway por pedido do usuário (o hook pode levar até ~15 s para decidir). */
const AUTO_PICK_MAX_MISSES = 5;
/** Prazo para o CLI pegar a próxima mensagem da fila depois de um `result` (ver `hasQueuedInput`). */
const QUEUE_GRACE_MS = 15_000;

/**
 * "Aprovar sozinho" libera pedidos de permissão de ferramenta. Perguntas ao usuário e aprovação de
 * plano não são permissões: precisam de uma resposta de verdade, então continuam esperando.
 */
export function autoApprovable(msg: any): boolean {
  const tn = msg?.request?.tool_name;
  return msg?.request?.subtype === 'can_use_tool' && tn !== 'AskUserQuestion' && tn !== 'ExitPlanMode';
}

export function buildArgs(o: { engine?: AgentEngine; resume?: string; mode: PermissionMode; model?: string; effort?: EffortLevel }): string[] {
  if (o.engine === 'antigravity') {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (o.model) {
      if (!SAFE_TOKEN.test(o.model)) throw new DeckError('bad', 'Nome de modelo inválido.');
      args.push('--model', o.model);
    }
    if (o.resume) {
      if (!SAFE_TOKEN.test(o.resume)) throw new DeckError('bad', 'Id de conversa inválido.');
      args.push('--conversation', o.resume);
    }
    return args;
  }
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
  engine?: AgentEngine;
  sessionId?: string;
  runnerId?: string;
  offset?: number;
  /** Byte logo após o último "result" (começo do turno atual) no arquivo de saída do runner. */
  turnOffset?: number;
  model?: string;
  /** Escolha do gateway no modo automático (só para mostrar; o CLI segue com `model`). */
  autoPick?: AutoModelPick;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  executionMode?: 'silent' | 'terminal';
  autoApprove?: boolean;
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
  /** Papel numa orquestração (orquestrador ou worker): define se o servidor MCP deck_orq é registrado. */
  orq?: SessionOrqRole;
}

function validOrqRole(r: any): SessionOrqRole | undefined {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) return undefined;
  if (r.role === 'orchestrator') return { id: r.id, role: 'orchestrator' };
  if (r.role === 'worker' && typeof r.workerId === 'string' && typeof r.taskId === 'string') return { id: r.id, role: 'worker', taskId: r.taskId, workerId: r.workerId };
  return undefined;
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

/** Código de saída de um processo morto com SIGKILL (128 + 9): monitor do servidor, OOM killer, `kill -9`. */
const KILLED_EXIT_CODE = 137;
/** Quedas separadas por mais que isso não contam como "em sequência" para o limite de retomadas automáticas. */
const AUTO_RESUME_WINDOW_MS = 5 * 60_000;

/**
 * Espera antes de retomar sozinho, crescendo a cada queda seguida (5 s, 10 s, 20 s... até 60 s): dá tempo ao servidor
 * de respirar se o que matou o processo foi falta de memória, e não martela um monitor que mata sempre.
 * `CLAUDE_DECK_AUTORESUME_DELAY_MS` existe só para os testes (vira o atraso fixo).
 */
function autoResumeDelayMs(consecutive: number): number {
  const fixed = process.env.CLAUDE_DECK_AUTORESUME_DELAY_MS;
  if (fixed !== undefined && fixed !== '' && Number.isFinite(Number(fixed)) && Number(fixed) >= 0) return Number(fixed);
  return Math.min(5_000 * 2 ** Math.max(0, consecutive - 1), 60_000);
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
  /** Sobe a cada `park()`: reanexos que já estavam a caminho percebem que foram cancelados. */
  private parkSeq = 0;
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
  /** Busca da escolha do gateway (modo automático): uma leitura por vez, no máximo uma a cada 2 s. */
  autoPickBusy = false;
  autoPickTryAt = 0;
  /** Leituras sem achar desde o último pedido do usuário (limita o custo quando o servidor não tem o hook). */
  autoPickMisses = 0;
  /** Até onde o transcript já foi procurado sem achar o aviso do hook (a próxima busca só lê o que veio depois). */
  autoPickScanned = 0;
  private answered: string[] = [];
  /** Quando cada mensagem do usuário foi enviada (uuid → ms): data/hora no eco de CLIs que não mandam `timestamp`. */
  private sentAt = new Map<string, number>();
  /**
   * Mensagens já escritas para o CLI que ele ainda não começou a processar (sem eco `isReplay`). Entre o fim de um
   * turno e o começo do próximo da fila, a fase passa por "idle": quem decide "está parado?" (o orquestrador) olha isto.
   */
  private unechoed = new Set<string>();
  /** Quando o último turno terminou (`result`), para o prazo de `hasQueuedInput`. */
  private turnEndedAt = 0;
  runnerEnded = false;
  private sawIdleKill = false;
  private unseenTimer: NodeJS.Timeout | null = null;
  /** Retomada automática agendada depois de o processo ser morto à força (ver `scheduleAutoResume`). */
  private autoResumeTimer: NodeJS.Timeout | null = null;
  /** Retomadas automáticas seguidas (zera quando um turno termina ou a última foi há mais de 5 min). */
  private autoResumeCount = 0;
  private lastAutoResumeAt = 0;
  /** Um turno está em andamento (eco da mensagem do usuário recebido e ainda sem "result"). */
  private inTurn = false;
  /** Ferramentas do terminal ao vivo (servidor MCP hospedado pelo app, pelo canal da conversa). */
  private termMcp = new TerminalMcpServer({ call: (tool, args, signal) => this.callTerminalTool(tool, args, signal) });
  /** Ferramentas da orquestração (só conversas com papel numa orquestração recebem este servidor). */
  private orqMcp = new OrqMcpServer({
    tools: () => this.mgr.orq?.toolsFor(this) ?? [],
    instructions: () => this.mgr.orq?.instructionsFor(this) ?? '',
    call: (tool, args, signal) =>
      this.mgr.orq ? this.mgr.orq.call(this, tool, args, signal) : Promise.resolve({ content: [{ type: 'text', text: 'Orquestração indisponível neste servidor do Claude Deck.' }], isError: true }),
  });
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
      engine: rec.engine ?? 'claude',
      sessionId: rec.sessionId,
      title: rec.title,
      phase: 'dormant',
      permissionMode: rec.permissionMode,
      executionMode: rec.executionMode === 'terminal' ? 'terminal' : 'silent',
      autoApprove: rec.autoApprove === true ? true : undefined,
      model: rec.model,
      autoPick: rec.autoPick && typeof rec.autoPick.model === 'string' && rec.autoPick.model ? rec.autoPick : undefined,
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
      orq: validOrqRole(rec.orq),
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
      engine: this.state.engine,
      sessionId: this.state.sessionId,
      runnerId: this.state.runnerId,
      offset: this.offset,
      turnOffset: this.turnOffset,
      model: this.requestedModel,
      autoPick: this.state.autoPick,
      effort: this.state.effort,
      permissionMode: this.state.permissionMode,
      executionMode: this.state.executionMode === 'terminal' ? 'terminal' : undefined,
      autoApprove: this.state.autoApprove || undefined,
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
      orq: this.state.orq,
    };
  }

  /** Passa a conversa para outra janela do app. */
  setOwner(wid: string | undefined) {
    this.setState({ wid });
  }

  setEngine(engine: AgentEngine) {
    if ((this.state.engine ?? 'claude') === engine) return;
    if (this.transport?.alive || this.starting || this.state.sessionId || this.state.runnerId)
      throw new DeckError('busy', 'Esta conversa já iniciou em outro motor. Abra uma nova conversa com o motor desejado.');
    // Não carregue um alias de modelo do motor anterior para o novo motor.
    this.requestedModel = undefined;
    this.setState({ engine, model: undefined, autoPick: undefined });
    this.mgr.persistSoon();
  }

  /**
   * Initialize do CLI: registra as ferramentas do terminal ao vivo (servidor MCP do app) e, nas conversas de uma
   * orquestração, as da orquestração.
   */
  private initRequest() {
    const servers = this.state.orq ? [MCP_SERVER_NAME, ORQ_SERVER_NAME] : [MCP_SERVER_NAME];
    return {
      subtype: 'initialize',
      sdkMcpServers: servers,
      // Comandos de rede podem demorar (backup, ping longo) e worker_wait espera até 30 min: cada ferramenta tem o
      // próprio limite.
      sdkMcpServerConfigs: Object.fromEntries(servers.map((n) => [n, { timeout: 31 * 60_000 }])),
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
    const isAgy = this.state.engine === 'antigravity';
    // O padrão global pode ser um alias de gateway que não existe no Antigravity.
    const model = isAgy ? this.requestedModel : (this.requestedModel || store.settings.defaultModel || undefined);
    const args = buildArgs({ engine: this.state.engine, resume: this.state.sessionId, mode, model, effort: this.state.effort });
    this.gotInitialize = false;
    this.startedAt = this.state.processStartedAt ?? Date.now();
    this.setState({ processStartedAt: this.startedAt });
    try {
      const status = await registry.connect(this.state.hostId);
      const bin = isAgy ? (status.agy?.path || 'agy') : status.claude?.path;
      if (!isAgy && !status.claude) {
        throw new DeckError(
          'noclaude',
          this.isRemote
            ? `Claude Code não encontrado em ${this.state.hostId}. Instale com: curl -fsSL https://claude.ai/install.sh | bash`
            : 'Claude Code não encontrado neste computador. Instale pelo site oficial ou configure o caminho nas Configurações.',
        );
      }
      if (isAgy && !status.agy) {
        throw new DeckError(
          'noagy',
          this.isRemote
            ? `Antigravity CLI não encontrado em ${this.state.hostId}. Clique em "Instalar Antigravity CLI" para instalar automaticamente.`
            : 'Antigravity CLI não encontrado neste computador. Clique em "Instalar Antigravity CLI" para instalar automaticamente.',
        );
      }
      this.setState({ claudeVersion: isAgy ? (status.agy?.version || '1.0.0 (agy)') : status.claude!.version });
      if (!this.isRemote) {
        if (!fs.existsSync(this.state.cwd)) throw new DeckError('nocwd', `A pasta não existe: ${this.state.cwd}`);
        const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' };
        delete (env as any).NODE_OPTIONS;
        this.terminalCalls.clear(); // processo novo: IDs do anterior não podem colidir
        this.attachTransport(new LocalTransport(bin!, args, this.state.cwd, env));
      } else {
        const runnerId = this.state.runnerId ?? this.state.sid;
        if (!this.state.runnerId) this.setState({ runnerId });
        await registry.ensureRunner(this.state.hostId);
        const ssh = registry.get(this.state.hostId).ssh!;
        const override = isAgy ? store.settings.hostAgyPath?.[this.state.hostId] : store.settings.hostClaudePath[this.state.hostId];
        const binArg = override
          ? Buffer.from(override).toString('base64')
          : (isAgy
              ? (status.agy?.path ? Buffer.from(status.agy.path).toString('base64') : 'auto_agy')
              : (status.claude?.path ? Buffer.from(status.claude.path).toString('base64') : 'auto'));
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
            init = isAgy ? null : await this.control(this.initRequest(), 45_000);
          } finally {
            this.awaitingInit = false;
          }
          this.gotInitialize = true;
          if (init) this.applyInitialize(init);
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
              ? `Claude Code não encontrado em ${this.state.hostId}.`
              : code === 'noagy'
                ? `Antigravity CLI não encontrado em ${this.state.hostId}. Clique em "Instalar Antigravity CLI" para instalar automaticamente.`
                : code === 'nocwd'
                  ? `A pasta não existe em ${this.state.hostId}: ${this.state.cwd}`
                  : `Falha ao iniciar o ${isAgy ? 'Antigravity' : 'Claude'} em ${this.state.hostId}: ${last || r.stderr.trim() || 'sem resposta'}`;
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
      if (isAgy) {
        this.gotInitialize = true;
        this.setPhase('idle');
        this.flushOutbox();
      } else {
        const init = await this.control(this.initRequest(), 45_000);
        this.gotInitialize = true;
        this.applyInitialize(init);
        this.setPhase('idle');
        this.flushOutbox();
      }
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
      c.reject(new Error(`O processo ${this.state.engine === 'antigravity' ? 'do Antigravity' : 'do Claude'} encerrou.`));
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
    // Antes de zerar: caiu no meio de uma tarefa (ou esperando uma permissão) ou estava parado entre tarefas?
    const wasWorking = this.inTurn || this.pendingPermissions.size > 0 || this.state.phase === 'running';
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
    // Processo acabou: o que não teve eco não vai mais ter (ao reiniciar, o que estava na fila sai de novo pelo outbox).
    this.unechoed.clear();
    const quick = Date.now() - this.startedAt < 15_000 && !this.gotInitialize;
    const failed = info.reason !== 'killed' && info.code !== 0 && info.code !== 143 && info.code != null;
    const err = failed || quick ? this.describeExit(info) : undefined;
    this.push({ type: 'deck_event', event: 'process_ended', code: info.code ?? null, reason: info.reason, error: err ?? null });
    this.setPhase('dormant', err);
    if (wasWorking && info.reason === 'exit' && info.code === KILLED_EXIT_CODE) this.scheduleAutoResume();
  }

  /**
   * O processo foi morto à força no meio de uma tarefa (código 137): manda uma mensagem curta ("continue") para o
   * Claude seguir de onde parou, pelo mesmo caminho de quando o usuário escreve (`send` → `--resume`). Só age se a
   * opção está ligada, e desiste depois de `autoResumeMax` quedas seguidas para não gastar créditos em laço.
   */
  private scheduleAutoResume() {
    const settings = this.mgr.store.settings;
    if (!settings.autoResumeOnKill || this.closing || this.detaching || this.autoResumeTimer) return;
    // Mensagem do usuário já na fila: o próximo `start()` a entrega, não há o que acrescentar.
    if (this.outbox.some((l) => l.startsWith('{"type":"user"'))) return;
    const now = Date.now();
    if (now - this.lastAutoResumeAt > AUTO_RESUME_WINDOW_MS) this.autoResumeCount = 0;
    const max = Math.max(1, Math.min(20, Math.round(Number(settings.autoResumeMax)) || 5));
    if (this.autoResumeCount >= max) {
      this.push({ type: 'deck_event', event: 'auto_resume_gave_up', attempts: this.autoResumeCount });
      this.autoResumeCount = 0; // a próxima mensagem do usuário recomeça a contagem do zero
      return;
    }
    const attempt = ++this.autoResumeCount;
    const delay = autoResumeDelayMs(attempt);
    this.lastAutoResumeAt = now;
    this.push({ type: 'deck_event', event: 'auto_resume', attempt, max, delayMs: delay });
    this.autoResumeTimer = setTimeout(() => {
      this.autoResumeTimer = null;
      // Enquanto esperava: fechou a aba, o usuário já escreveu/retomou, parou a tarefa ou o processo voltou.
      if (this.closing || this.detaching || this.starting || this.transport?.alive || this.state.phase !== 'dormant') return;
      const cur = this.mgr.store.settings; // relê: pode ter sido desligado ou editado durante a espera
      if (!cur.autoResumeOnKill) return;
      const text = String(cur.autoResumeMessage ?? '').trim().slice(0, 2000) || 'continue';
      this.send([{ type: 'text', text }], crypto.randomUUID()).catch((e) => {
        this.mgr.log(`[${this.state.hostId}] retomada automática de ${this.state.sid.slice(0, 8)} falhou: ${(e as Error).message}`);
      });
    }, delay);
    this.autoResumeTimer.unref?.();
  }

  private cancelAutoResume() {
    if (this.autoResumeTimer) clearTimeout(this.autoResumeTimer);
    this.autoResumeTimer = null;
  }

  private describeExit(info: { code?: number | null; stderr?: string }): string {
    const tail = (info.stderr ?? '')
      .split('\n')
      .filter((l) => l.trim() && !/connectors are disabled/i.test(l))
      .slice(-4)
      .join(' | ');
    return `O ${this.state.engine === 'antigravity' ? 'Antigravity' : 'Claude'} encerrou (código ${info.code ?? '?'})${tail ? ': ' + tail : ''}`;
  }

  private scheduleReattach() {
    if (this.closing || this.reconnectTimer) return;
    const delays = [500, 1500, 3000, 6000, 10000, 20000, 30000];
    const d = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt++;
    const seq = this.parkSeq;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (seq !== this.parkSeq) return; // soltada (park) enquanto esperava
      this.reattach().catch((e) => {
        this.mgr.log(`[${this.state.hostId}] reanexar ${this.state.sid.slice(0, 8)} falhou: ${(e as Error).message}`);
        if (e instanceof DeckError && e.code === 'missing') return;
        if (seq !== this.parkSeq) return;
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
    const seq = this.parkSeq;
    this.setPhase('reconnecting');
    await this.mgr.registry.connect(this.state.hostId);
    await this.mgr.registry.ensureRunner(this.state.hostId);
    // Soltada (park) enquanto conectava: quem soltou não quer a conexão de volta sozinha.
    if (seq !== this.parkSeq) return;
    this.awaitingInit = true;
    let init: any = null;
    try {
      await this.attachRemote();
      if (seq !== this.parkSeq) {
        const t = this.transport;
        this.transport = null;
        t?.close();
        return;
      }
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
    // Completa com os modelos do settings.json que o CLI não listou (sem bloquear a inicialização).
    const hostId = this.state.hostId;
    this.mgr
      .pickerReader(hostId)
      .then((extra) => {
        const have = new Set(caps.models.map((m) => m.value));
        const missing = extra.filter((m) => !have.has(m.value));
        if (missing.length) this.mgr.setCaps(hostId, { ...caps, models: [...caps.models, ...missing] });
      })
      .catch((e) => this.mgr.log(`modelPicker do settings.json: ${(e as Error).message}`));
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
    let rawMsg: any;
    try {
      rawMsg = JSON.parse(line);
    } catch {
      return;
    }
    const msgs = this.state.engine === 'antigravity'
      ? normalizeAntigravityEvent(rawMsg, this.state.sessionId)
      : [rawMsg];
    for (const msg of msgs) {
      this.processSingleMsg(msg);
    }
  }

  private processSingleMsg(msg: any) {
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
        // Ferramentas da orquestração mexem só no quadro do Deck e criam conversas cujas permissões continuam valendo
        // (o usuário escolheu o modo dos workers ao criar a orquestração): liberadas sem perguntar.
        const orqTool = !!this.state.orq && typeof tn === 'string' && tn.startsWith(ORQ_TOOL_PREFIX);
        if (tn === `${MCP_TOOL_PREFIX}read` || tn === `${MCP_TOOL_PREFIX}wait` || orqTool) {
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
        if (this.state.autoApprove && autoApprovable(msg)) {
          this.autoAllow(msg);
          return;
        }
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
      const pending = this.mcpRequestIds.get(msg.request_id);
      if (pending) pending.server.cancel(pending.id);
      this.pendingPermissions.delete(msg.request_id);
      this.push(msg);
      return;
    }
    if (msg.type === 'keep_alive') return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      const patch: Partial<SessionState> = { model: msg.model, permissionMode: msg.permissionMode, claudeVersion: msg.claude_code_version };
      if (msg.session_id && msg.session_id !== this.state.sessionId) patch.sessionId = msg.session_id;
      // O CLI repete o "init" a cada pedido, sempre com o modelo automático: a escolha do gateway (guardada à
      // parte) continua valendo. Só some se a conversa mudou ou saiu do modo automático.
      if (this.state.autoPick && (patch.sessionId || !isAutoModel(msg.model))) patch.autoPick = undefined;
      if (patch.sessionId) this.autoPickScanned = 0;
      this.setState(patch);
      this.mgr.scheduleAutoPick(this);
    } else if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode) {
      this.setState({ permissionMode: msg.permissionMode });
    } else if (msg.type === 'user' && msg.isReplay) {
      if (msg.uuid) this.unechoed.delete(msg.uuid);
      if (!msg.timestamp && msg.uuid && this.sentAt.has(msg.uuid)) msg.timestamp = new Date(this.sentAt.get(msg.uuid)!).toISOString();
      this.inTurn = true;
      if (this.state.phase !== 'running') this.setPhase('running');
    } else if (msg.type === 'stream_event' || msg.type === 'assistant') {
      if (this.state.phase === 'idle') this.setPhase('running');
      // A 1ª resposta do modelo só sai depois de o hook decidir: o arquivo dele já deve existir.
      if (msg.type === 'assistant' && !msg.parent_tool_use_id) this.mgr.scheduleAutoPick(this);
    } else if (msg.type === 'result') {
      if (!msg.timestamp) msg.timestamp = new Date().toISOString();
      this.turnEndedAt = Date.now();
      this.resultsSeen++;
      this.autoResumeCount = 0; // um turno terminou de verdade: as quedas anteriores não contam mais
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
      this.mgr.scheduleAutoPick(this);
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
  private mcpRequestIds = new Map<string, { server: { cancel(id: string | number): void }; id: string | number }>();

  private onMcpMessage(msg: any) {
    const reqId = msg.request_id;
    const payload = msg.request?.message;
    if (typeof reqId !== 'string') return;
    const answer = (mcp_response: any) => this.writeControlResponse({
      type: 'control_response', response: { subtype: 'success', request_id: reqId, response: { mcp_response } },
    });
    const error = (message: string) => ({ jsonrpc: '2.0', id: payload?.id ?? 0,
      result: { isError: true, content: [{ type: 'text', text: message }] } });
    const serverName = msg.request?.server_name;
    const server = serverName === MCP_SERVER_NAME ? this.termMcp : serverName === ORQ_SERVER_NAME && this.state.orq ? this.orqMcp : null;
    if (!server) {
      answer(error('Servidor MCP desconhecido.'));
      return;
    }
    if (payload?.method !== 'tools/call' || payload.id == null) {
      server.handle(payload).then((r) => answer(r ?? { jsonrpc: '2.0', result: {}, id: 0 })).catch((e) => answer(error(String(e))));
      return;
    }
    // Consultas e esperas da orquestração podem rodar de novo depois de uma queda sem efeito colateral: não passam pelo
    // registro durável (uma espera pendente relida ao reanexar volta a esperar, em vez de virar "resultado incerto").
    if (server === this.orqMcp && ORQ_IDEMPOTENT.has(String(payload.params?.name ?? ''))) {
      this.mcpRequestIds.set(reqId, { server, id: payload.id });
      void server
        .handle(payload)
        .catch((e) => error(String(e)))
        .then(answer)
        .finally(() => this.mcpRequestIds.delete(reqId));
      return;
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const old = this.terminalCalls.get(reqId);
    if (old) {
      if (old.fingerprint !== fingerprint) return answer(error('ID repetido com conteúdo diferente; nada foi executado.'));
      const pending = this.mcpTasks.get(reqId);
      if (pending) { void pending.then(answer); return; }
      answer(
        old.response ??
          error(
            server === this.orqMcp
              ? 'O app perdeu a conexão durante esta chamada. Ela pode ter executado antes da queda (ex.: worker criado ou mensagem enviada) e NÃO será repetida. Confira com tasks_list/worker_status antes de tentar de novo.'
              : 'O app perdeu a conexão durante esta chamada. Ela pode ter executado antes da queda e NÃO será repetida. Leia o terminal e confirme o estado com o usuário antes de qualquer novo comando.',
          ),
      );
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
    this.mcpRequestIds.set(reqId, { server, id: payload.id });
    const task = server.handle(payload).catch((e) => error(String(e))).then((response) => {
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

  /** Cancela as esperas das ferramentas do app (terminal ao vivo e orquestração). */
  private abortMcp() {
    this.termMcp.abortAll();
    this.orqMcp.abortAll();
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
  /**
   * Há mensagem enviada esperando o CLI começar a processá-la (a conversa está entre dois turnos, não parada). O CLI
   * pega a próxima da fila logo depois do `result`; se passar de QUEUE_GRACE_MS sem eco, a mensagem não vai sair
   * (uuid repetido, descartada) e não pode deixar a conversa parecendo ocupada para sempre.
   */
  get hasQueuedInput(): boolean {
    if (!this.unechoed.size) return false;
    if (this.state.phase === 'idle' && Date.now() - this.turnEndedAt > QUEUE_GRACE_MS) {
      this.unechoed.clear();
      return false;
    }
    return true;
  }

  async send(content: any[], uuid: string) {
    if (!Array.isArray(content) || !content.length) throw new DeckError('bad', 'Mensagem vazia.');
    if (!UUID_RE.test(uuid)) throw new DeckError('bad', 'uuid inválido');
    this.cancelAutoResume(); // o usuário (ou a própria retomada, que já zerou o timer) está mandando algo: nada a agendar
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
    // Modo automático sem escolha conhecida: o hook decide neste pedido (consulta ao gateway, até ~15 s).
    this.autoPickMisses = 0;
    this.mgr.scheduleAutoPick(this, [3_000, 10_000, 25_000]);
    this.unechoed.add(uuid);
    if (this.unechoed.size > 100) this.unechoed.delete(this.unechoed.values().next().value!);
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
    this.cancelAutoResume(); // "Parar" também vale para uma retomada automática ainda na espera
    // Parar também para de esperar o comando no terminal (o comando em si segue lá; o usuário vê) e os workers.
    this.abortMcp();
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

  /** Liga/desliga "Aprovar sozinho". Ao ligar, libera também os pedidos que já estavam esperando. */
  setAutoApprove(on: boolean) {
    this.setState({ autoApprove: on || undefined });
    if (!on) return;
    for (const msg of [...this.pendingPermissions.values()]) if (autoApprovable(msg)) this.autoAllow(msg);
  }

  private autoAllow(msg: any) {
    const response = { behavior: 'allow', updatedInput: msg.request?.input ?? {} };
    this.respond(msg.request_id, response);
    // Avisa as janelas que o pedido foi respondido (o cartão de permissão sai da tela).
    this.push({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response, auto: true } });
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
    if (this.state.engine === 'antigravity' && this.transport?.alive)
      throw new DeckError('unsupported', 'A troca de modelo com o Antigravity em execução ainda não é suportada pelo Deck.');
    this.requestedModel = model ?? undefined;
    if (this.transport?.alive && this.state.phase !== 'reconnecting') {
      await this.control({ subtype: 'set_model', model: model ?? 'default' });
    }
    // Trocou de modelo: a escolha do gateway deixa de valer. Voltando ao automático, o gateway mantém a
    // decisão desta conversa, e ela é lida de novo.
    this.setState({ model: model || undefined, autoPick: undefined });
    this.autoPickMisses = 0;
    this.mgr.scheduleAutoPick(this);
  }

  /** Escolha do gateway para esta conversa no modo automático (só para mostrar; o CLI segue com `model`). */
  setAutoPick(pick: AutoModelPick) {
    this.setState({ autoPick: pick });
  }

  /** Processo de pé e já inicializado, sem reconectar nem reiniciar: dá para falar com o CLI agora. */
  private get canControlLive() {
    return !!this.transport?.alive && this.gotInitialize && !this.awaitingInit && !this.starting && !this.reattaching && !this.effortChange && ['idle', 'running'].includes(this.state.phase);
  }

  /**
   * Troca o esforço da conversa. Com o processo de pé, o CLI aplica na hora (`apply_flag_settings`): vale a
   * partir da próxima chamada ao modelo, inclusive no meio de uma tarefa, sem reiniciar nada. Um CLI antigo,
   * sem esse pedido, cai no caminho de antes (reiniciar com --effort e --resume), possível só entre tarefas.
   * `null` volta ao padrão do modelo.
   */
  async setEffort(effort: EffortLevel | null) {
    if (effort !== null && !EFFORT_LEVELS.includes(effort)) throw new DeckError('bad', 'Nível de esforço inválido.');
    if (this.effortChange) throw new DeckError('busy', 'Aguarde a mudança de esforço anterior terminar.');
    const next = effort ?? undefined;
    if (next === this.state.effort) return;
    let liveUnsupported = false;
    if (this.canControlLive) {
      try {
        await this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } }, 15_000);
        this.setState({ effort: next }); // O próximo --resume (reinício, retomada) já sobe com este esforço.
        this.mgr.persistNow(); // Já aplicado no CLI: falha de disco só vai ao log, não desfaz nem finge que não aplicou.
        return;
      } catch (e) {
        const err = e as DeckError;
        if (err.code === 'control' && /unsupported/i.test(err.message)) liveUnsupported = true;
        else if (err.code !== 'notrunning') throw new DeckError('effort', `Não apliquei o nível de esforço: ${err.message}`);
        // CLI antigo ou processo que acabou de cair: segue para o caminho que reinicia, se for possível.
      }
    }
    if (this.starting || this.reattaching || this.inTurn || this.pendingPermissions.size || this.outbox.length || !['idle', 'dormant'].includes(this.state.phase))
      throw new DeckError('busy', liveUnsupported
        ? 'Este Claude Code é antigo demais para trocar o esforço durante a tarefa. Espere ela terminar (ou atualize o Claude Code).'
        : 'Espere o Claude terminar de conectar antes de mudar o esforço.');
    if (this.isRemote && this.state.runnerId && !this.runnerEnded && !this.transport?.alive)
      throw new DeckError('busy', 'Aguarde esta conversa reconectar ao servidor antes de mudar o esforço.');
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
    this.cancelAutoResume();
    this.abortMcp();
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
    this.cancelAutoResume();
    this.abortMcp();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.transport?.close();
  }

  /**
   * Solta o canal desta conversa com o servidor SEM mexer no Claude de lá (o runner segue rodando). Fica
   * "pausada" (`dormant`) e só volta quando alguém a usa: mensagem nova ou a janela dela reaberta
   * (`sessions.reattach`). Ao contrário de uma queda de rede, nada tenta reconectar sozinho — é o que permite
   * fechar a conexão SSH do servidor de verdade. Um turno em andamento continua no servidor e é retomado do
   * ponto onde parou (mesmo caminho da reconexão depois de uma queda). Devolve se soltou algo.
   */
  park(): boolean {
    if (!this.isRemote || !this.state.runnerId || this.closing || this.detaching || this.starting) return false;
    if (!this.transport && !this.reconnectTimer && !this.reattaching) return false; // nada ligado
    this.parkSeq++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.abortMcp();
    for (const [id, c] of this.controls) {
      clearTimeout(c.timer);
      c.reject(new DeckError('parked', 'A conversa foi desconectada do servidor.'));
      this.controls.delete(id);
    }
    const t = this.transport;
    this.transport = null; // antes de fechar: o fim do canal não vale como queda (ver o handler de 'end')
    t?.close();
    // Direto no estado (não por setPhase): o relógio de um turno em andamento tem de sobreviver, como numa conversa "pausada".
    this.setState({ phase: 'dormant', error: undefined });
    return true;
  }

  /** Solta só se a conversa está parada: sem turno, sem pedido de permissão, sem mensagem na fila. */
  parkIfIdle(): boolean {
    if (this.state.phase !== 'idle' || this.inTurn || this.pendingPermissions.size || this.outbox.length || !this.transport?.alive) return false;
    return this.park();
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

/** Liga as conversas às orquestrações (definido pelo servidor do Claude Deck). */
export interface OrqBridge {
  toolsFor(s: ClaudeSession): OrqToolSpec[];
  instructionsFor(s: ClaudeSession): string;
  call(s: ClaudeSession, tool: string, args: any, signal: AbortSignal): Promise<ToolResult>;
  /** Conversa reaberta pelo Histórico que era orquestrador/worker: devolve o papel dela. */
  roleForResume?(hostId: string, sessionId: string): SessionOrqRole | undefined;
  /** A aba nova de uma conversa retomada passa a ser a do papel (sid novo). */
  relink?(s: ClaudeSession): void;
}

export class SessionManager extends EventEmitter {
  sessions = new Map<string, ClaudeSession>();
  caps = new Map<string, SessionCapabilities>();
  terminals?: TerminalBinder;
  orq?: OrqBridge;
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
    /** Opções de `modelPicker.options` do settings.json do servidor (o CLI omite algumas, ex. classe Haiku). */
    public pickerReader: (hostId: string) => Promise<ModelOption[]> = async () => [],
    /** Escolha do gateway no modo automático: arquivo do hook ou o aviso dele no transcript (lido a partir de `from`). */
    public autoPickReader: (s: ClaudeSession, from: number) => Promise<{ pick: AutoDecision | null; scannedTo?: number }> = async () => ({ pick: null }),
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
    engine?: AgentEngine;
    resume?: string;
    permissionMode?: PermissionMode;
    executionMode?: 'silent' | 'terminal';
    model?: string;
    title?: string;
    start?: boolean;
    wid?: string;
    /** Nível de esforço inicial (o processo já sobe com ele). */
    effort?: EffortLevel;
    /** Papel numa orquestração: precisa existir antes do processo iniciar (o "initialize" registra o servidor MCP). */
    orq?: SessionOrqRole;
    /** O título vale como nome dado pelo usuário (o automático do Claude não o troca). */
    userTitle?: boolean;
  }) {
    const sid = crypto.randomUUID();
    // Retomar pelo Histórico uma conversa que era orquestrador/worker: volta com o mesmo papel.
    const orq = o.orq ?? (o.resume ? this.orq?.roleForResume?.(o.hostId, o.resume) : undefined);
    const s = this.add(
      new ClaudeSession(
        {
          sid,
          hostId: o.hostId,
          cwd: o.cwd,
          engine: o.engine ?? this.store.settings.defaultEngine ?? 'claude',
          sessionId: o.resume,
          permissionMode: o.permissionMode ?? this.store.settings.defaultPermissionMode,
          executionMode: o.executionMode === 'terminal' ? 'terminal' : undefined,
          model: o.model,
          effort: o.effort,
          title: o.title,
          createdAt: Date.now(),
          wid: o.wid,
          orq,
        },
        this,
      ),
    );
    if (o.userTitle && o.title) s.setTitle(o.title, true);
    if (orq && !o.orq) this.orq?.relink?.(s);
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
   * Modo automático: descobre o modelo que o gateway escolheu para a conversa (arquivo do hook ou, se ele já
   * expirou, o aviso no transcript). Achou, guarda no estado e na gravação das sessões e não lê mais.
   */
  async resolveAutoPick(s: ClaudeSession) {
    const sessionId = s.state.sessionId;
    if (!isAutoModel(s.state.model) || s.state.autoPick || !sessionId || this.sessions.get(s.state.sid) !== s) return;
    // Tarefa de fundo: não reabre a conexão de um servidor desconectado (volta a tentar quando ele conectar).
    if (s.isRemote && this.registry.status(s.state.hostId).state !== 'ready') return;
    if (s.autoPickBusy || s.autoPickMisses >= AUTO_PICK_MAX_MISSES || Date.now() - s.autoPickTryAt < 2_000) return;
    s.autoPickBusy = true;
    s.autoPickTryAt = Date.now();
    try {
      const { pick: found, scannedTo } = await this.autoPickReader(s, s.autoPickScanned);
      if (typeof scannedTo === 'number' && s.state.sessionId === sessionId) s.autoPickScanned = scannedTo;
      // A conversa pode ter trocado de modelo (ou de sessão) durante a leitura.
      if (!found || !isAutoModel(s.state.model) || s.state.sessionId !== sessionId || s.state.autoPick) {
        if (!found) s.autoPickMisses++;
        return;
      }
      const pick = toAutoPick(found, this.caps.get(s.state.hostId)?.models ?? []);
      s.setAutoPick(pick);
      this.log(`modo automático da conversa ${sessionId.slice(0, 8)}: o gateway escolheu ${pick.model}${pick.effort ? ` (${pick.effort})` : ''}`);
    } catch (e) {
      s.autoPickMisses++;
      this.log(`escolha do modo automático da conversa ${sessionId.slice(0, 8)}: ${(e as Error).message}`);
    } finally {
      s.autoPickBusy = false;
    }
  }

  /** Agenda a busca da escolha do gateway (nada a fazer fora do modo automático ou com a escolha já conhecida). */
  scheduleAutoPick(s: ClaudeSession, delays: number[] = [0]) {
    if (!isAutoModel(s.state.model) || s.state.autoPick) return;
    for (const ms of delays) setTimeout(() => this.resolveAutoPick(s).catch(() => {}), ms).unref?.();
  }

  /**
   * Conversa retomada ou restaurada sem nome (o título só chegava depois do fim de um turno): busca no
   * transcript agora. Servidor remoto ainda desconectado fica para quando conectar (evento 'status').
   */
  ensureTitle(s: ClaudeSession) {
    this.scheduleAutoPick(s); // restaurada/retomada no modo automático: a escolha pode já estar decidida
    if (s.state.title || s.userTitle || !s.state.sessionId) return;
    if (s.isRemote && this.registry.status(s.state.hostId).state !== 'ready') return;
    if (Date.now() - s.titleTryAt < 30_000) return;
    s.titleTryAt = Date.now();
    this.refreshTitle(s).catch((e) => this.log(`título da conversa ${s.state.sid.slice(0, 8)}: ${(e as Error).message}`));
  }

  /** O título automático (ai-title) é gravado pelo CLI alguns segundos depois do 1º turno. */
  scheduleTitleRefresh(s: ClaudeSession) {
    const run = () => {
      if (this.sessions.get(s.state.sid) !== s) return;
      // Tarefa de fundo: ler o transcript abriria a conexão SSH de novo, até depois de você desconectar ou
      // de a conexão ser solta. Servidor sem conexão fica para quando conectar (evento 'status' → ensureTitle).
      if (s.isRemote && this.registry.status(s.state.hostId).state !== 'ready') return;
      this.refreshTitle(s).catch(() => {});
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

  /**
   * Solta o canal de todas as conversas remotas de um servidor, sem mexer no Claude de lá (ver `park`).
   * `onlyIdle`: só as paradas (sem turno, permissão ou mensagem na fila). Devolve quantas soltou.
   */
  parkHost(hostId: string, onlyIdle = false): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.state.hostId !== hostId) continue;
      if (onlyIdle ? s.parkIfIdle() : s.park()) n++;
    }
    if (n) this.persistSoon();
    return n;
  }

  /**
   * A janela fechou: solta as conversas dela que estão paradas. Devolve os servidores remotos que ela usava
   * (soltando ou não), para quem chamou ver se a conexão deles ainda tem utilidade.
   */
  parkIdleOfWindow(wid: string): string[] {
    const hosts = new Set<string>();
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.state.wid !== wid || !s.isRemote) continue;
      hosts.add(s.state.hostId);
      if (s.parkIfIdle()) n++;
    }
    if (n) {
      this.persistSoon();
      this.log(`janela fechada: ${n} conversa(s) parada(s) soltaram o canal SSH`);
    }
    return [...hosts];
  }

  /**
   * Reanexa as conversas remotas que ainda podem estar vivas no servidor: as pedidas (`sids`: as abas da janela
   * que abriu) e as que estavam no meio de um turno, que precisam ser acompanhadas até o fim para avisar.
   * Sem `sids` (interface antiga), todas, como antes.
   */
  resumeRemote(sids?: string[]) {
    for (const s of this.sessions.values()) {
      if (sids && !sids.includes(s.state.sid) && !s.state.turnStartedAt) continue;
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
