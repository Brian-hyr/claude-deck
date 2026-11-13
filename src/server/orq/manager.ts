// Orquestração: uma conversa (o orquestrador) divide um objetivo grande em tarefas e cria uma conversa nova (worker),
// com contexto limpo, para cada tarefa. O Claude Deck guarda o quadro (tarefas, workers, eventos) FORA do contexto do
// orquestrador, aplica as regras que não podem depender do modelo (plano aprovado pelo usuário, dependências, arquivos
// sem sobreposição, limite de simultâneos, esforço Médio ou acima nos workers e Alto ou acima no orquestrador) e acorda
// o orquestrador quando um worker termina.
//
// Workers são conversas normais do Deck (abas na mesma janela, mesma pasta): o usuário vê, responde perguntas e aprova
// permissões nelas. O orquestrador nunca aprova nada por ninguém.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../config';
import { DeckError } from '../../shared/protocol';
import { dirname, isAbsolute, join, normalize, relativeTo } from '../../shared/paths';
import { mkdirp, shq } from '../fs/hostfs';
import type { HostRegistry } from '../hosts/registry';
import type { ClaudeSession, OrqBridge, SessionManager } from '../claude/session';
import type { ToolResult } from '../terminal/mcp';
import {
  LOCAL_HOST_ID,
  ORQ_EFFORTS,
  ORQ_WORKER_EFFORTS,
  type OrchestrationView,
  type OrqEffort,
  type OrqWorkerEffort,
  type OrqReportStatus,
  type OrqStatus,
  type OrqTaskStatus,
  type OrqWorkerRole,
  type OrqWorkerState,
  type PermissionMode,
  type Platform,
  type SessionOrqRole,
} from '../../shared/types';
import { orchestratorInstructions, orchestratorTools, WORKER_TOOLS, workerInstructions, type OrqToolSpec } from './mcp';

// ------------------------------------------------------------------ registros persistidos

interface TaskRec {
  id: string;
  title: string;
  deps: string[];
  files: string[];
  verify: string[];
  notes?: string;
  status: OrqTaskStatus;
  workers: string[];
  evidence?: string;
  updatedAt: number;
}

interface ReportRec {
  status: OrqReportStatus;
  summary: string;
  filesChanged: string[];
  checks: { command: string; exitCode?: number; outputTail?: string }[];
  concerns?: string;
  path?: string;
  at: number;
}

interface WorkerRec {
  id: string;
  taskId: string;
  sid: string;
  /** Id da conversa no CLI (para reencontrar o worker se a aba for reaberta pelo Histórico). */
  sessionId?: string;
  role: OrqWorkerRole;
  model?: string;
  effort: OrqWorkerEffort;
  startedAt: number;
  baseCommit?: string;
  briefPath: string;
  reportPath: string;
  report?: ReportRec;
  /** Relatório recebido e ainda não anunciado ao orquestrador (sai no fim do turno do worker). */
  reportUnannounced?: boolean;
  /** Mensagem mandada ao worker cujo turno ainda não terminou. */
  awaitingTurn?: boolean;
  /** O último turno terminou com erro (ou o processo caiu). */
  error?: string;
  stopped?: boolean;
  closed?: boolean;
  finalText?: string;
  costUsd?: number;
  turns?: number;
  /** Trocas automáticas de modelo seguidas (zera num turno sem erro). */
  failovers?: number;
}

type EventKind = 'reported' | 'turn_done' | 'permission' | 'question' | 'error' | 'closed' | 'model';

/** Modelo que o gateway recusou: esgotado (cota, sem deployments, sobrecarga) ou inexistente/sem acesso. */
interface ExhaustedRec {
  until: number;
  kind: 'exhausted' | 'unavailable';
  reason: string;
}

interface EventRec {
  at: number;
  kind: EventKind;
  workerId: string;
  text: string;
}

export interface OrqRec {
  id: string;
  hostId: string;
  cwd: string;
  wid?: string;
  orchestratorSid: string;
  orchestratorSessionId?: string;
  title: string;
  createdAt: number;
  status: OrqStatus;
  /** Estado antes de pausar (para retomar). */
  resumeStatus?: OrqStatus;
  settings: { workerPermissionMode: PermissionMode; maxParallel: number; requireApproval: boolean; workerModel?: string };
  stateDir: string;
  platform: Platform;
  tasks: TaskRec[];
  workers: WorkerRec[];
  events: EventRec[];
  nudges: number;
  waitingReason?: string;
  planSummary?: string;
  summary?: string;
  approvedAt?: number;
  finishedAt?: number;
  /** Modelos recusados pelo gateway neste servidor (chave: modelo sem o sufixo [1m], minúsculo). */
  exhausted?: Record<string, ExhaustedRec>;
  /** Trocas automáticas seguidas do modelo do orquestrador (zera num turno sem erro). */
  orqFailovers?: number;
}

/** Trocas automáticas seguidas antes de desistir e pedir o usuário/orquestrador. */
const MAX_FAILOVERS = 4;

export interface ModelFailure {
  kind: 'exhausted' | 'unavailable';
  reason: string;
  /** "Try again in N seconds" do gateway, quando informado. */
  retryAfterMs?: number;
}

/**
 * O turno terminou porque o gateway recusou o MODELO (não por rede/credencial)? Formato do CLI 2.1.x: `result` com
 * `terminal_reason: "api_error"`, `api_error_status` e o texto "API Error: …" em `result`. Exemplos reais: LiteLLM 429
 * "No deployments available … Try again in 14620 seconds", 500 overloaded_error, 400 "Invalid model name".
 */
export function modelFailureOf(msg: any): ModelFailure | null {
  if (msg?.type !== 'result' || !msg.is_error) return null;
  const text = String(msg.result ?? '');
  const apiErr = msg.terminal_reason === 'api_error' || /^API Error\b/i.test(text) || /issue with the selected model/i.test(text);
  if (!apiErr) return null;
  // Rede ou credencial: outro modelo não resolve.
  if (/ENOTFOUND|ECONNREFUSED|ConnectionRefused|Connection (lost|refused|reset)|Can't reach|ETIMEDOUT|timed out|socket hang up|firewall or proxy/i.test(text)) return null;
  const status = Number(msg.api_error_status) || Number(text.match(/API Error:\s*(\d{3})\b/)?.[1]) || Number(text.match(/\((\d{3})\)/)?.[1]) || 0;
  const reason = clip(text.replace(/^API Error:\s*/i, ''), 220);
  if (/invalid model name|model_not_found|issue with the selected model|model .{0,40}does not exist|not have access to (this |the )?model|unknown model|no such model/i.test(text))
    return { kind: 'unavailable', reason };
  if ((status === 401 || status === 403) && !/quota|budget|credit|limit/i.test(text)) return null;
  if (status === 429 || status === 529 || /no deployments available|rate.?limit|quota|budget|credit balance|overloaded|at capacity|temporarily unavailable/i.test(text)) {
    const m = text.match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?)?\b/i);
    let retryAfterMs: number | undefined;
    if (m) {
      const n = Number(m[1]);
      const u = (m[2] ?? 's').toLowerCase();
      retryAfterMs = u.startsWith('ms') || u.startsWith('milli') ? n : u.startsWith('h') ? n * 3_600_000 : u.startsWith('m') ? n * 60_000 : n * 1000;
    }
    return { kind: 'exhausted', reason, retryAfterMs };
  }
  return null;
}

const modelKey = (m: string) => m.replace(/\[1m\]$/i, '').trim().toLowerCase();
const FAMILY_RE = /(opus|sonnet|haiku|fable|gpt|gemini|flash|kimi|grok|llama|mistral|deepseek|qwen|glm)/i;

/**
 * Modelo reserva para `current`, entre os que o servidor informou: nunca "default"/"auto", nunca um recusado. Prefere a
 * mesma janela de contexto (sufixo [1m]: a conversa pode não caber numa janela menor) e a mesma família (outro
 * provedor/rota do mesmo modelo, ex.: claude-opus-5-5 → kpaopus55); depois, a ordem da lista do servidor.
 */
export function pickFallbackModel(current: string | undefined, models: string[], blocked: (m: string) => boolean): string | undefined {
  const cur = current ?? '';
  const curKey = modelKey(cur);
  // Sem modelo conhecido (padrão/automático): a janela grande é o mais seguro para uma conversa já em andamento.
  const curLong = !cur || /^auto\b/.test(curKey) || /\[1m\]$/i.test(cur);
  const curFamily = cur.match(FAMILY_RE)?.[1]?.toLowerCase();
  const seen = new Set<string>();
  const cands = models.filter((m) => {
    const k = modelKey(m);
    if (!m || k === 'default' || /^auto\b/.test(k) || k === curKey || blocked(m) || seen.has(m)) return false;
    seen.add(m);
    return true;
  });
  const score = (m: string) => (/\[1m\]$/i.test(m) === curLong ? 2 : 0) + (curFamily && m.toLowerCase().includes(curFamily) ? 1 : 0);
  return cands.map((m, i) => ({ m, s: score(m), i })).sort((a, b) => b.s - a.s || a.i - b.i)[0]?.m;
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9._:\[\]\/@-]{1,100}$/;
const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
const ACTIVE_STATES: OrqWorkerState[] = ['starting', 'working', 'waiting_permission', 'waiting_answer'];
const ANSWER_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const MAX_NUDGES = 3;
const MAX_BRIEF = 100_000;
const MAX_TASKS = 200;

/** Pausa antes de entregar eventos ou lembretes (junta vários e espera o CLI emendar outro turno). Ajustável nos testes. */
function deliveryDelayMs(): number {
  const n = Number(process.env.CLAUDE_DECK_ORQ_DELAY_MS);
  return Number.isFinite(n) && n >= 0 && process.env.CLAUDE_DECK_ORQ_DELAY_MS !== '' ? n : 2500;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const fail = (t: string): ToolResult => text(t, true);
const clip = (s: string | undefined, n: number) => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
};

// ------------------------------------------------------------------ arquivos das tarefas

interface FileScope {
  prefix: string;
  glob: boolean;
}

/** Normaliza os arquivos/pastas de uma tarefa para caminhos relativos com '/', sem sair da pasta do projeto. */
export function normalizeTaskFiles(cwd: string, platform: Platform, files: string[]): string[] {
  const out: string[] = [];
  for (const raw of files) {
    let f = String(raw ?? '').trim();
    if (!f) continue;
    if (f.length > 300) throw new DeckError('bad', `Caminho longo demais: ${f.slice(0, 60)}…`);
    if (isAbsolute(platform, f)) {
      const rel = relativeTo(platform, cwd, f);
      if (rel === null) throw new DeckError('bad', `${f} está fora da pasta do projeto.`);
      f = rel;
    }
    f = f.replace(/\\/g, '/').replace(/^\.\/+/, '');
    const parts = f.split('/').filter((p) => p && p !== '.');
    if (parts.includes('..')) throw new DeckError('bad', `${raw}: caminhos com ".." não são aceitos.`);
    const n = parts.join('/');
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > 100) throw new DeckError('bad', 'Arquivos demais numa tarefa (máximo 100 entradas).');
  return out;
}

function scopeOf(f: string): FileScope {
  const i = f.search(/[*?[{]/);
  if (i < 0) return { prefix: f.replace(/\/+$/, ''), glob: false };
  return { prefix: f.slice(0, i), glob: true };
}

function covers(a: FileScope, b: FileScope): boolean {
  if (a.prefix === '') return true;
  if (a.glob) return b.prefix.startsWith(a.prefix);
  return b.prefix === a.prefix || b.prefix.startsWith(a.prefix + '/');
}

/** Primeiro par sobreposto entre duas listas de arquivos/pastas (ou null). Pasta cobre o que está dentro; glob, o prefixo. */
export function filesOverlap(a: string[], b: string[]): [string, string] | null {
  for (const x of a)
    for (const y of b) {
      const sx = scopeOf(x);
      const sy = scopeOf(y);
      if (covers(sx, sy) || covers(sy, sx)) return [x, y];
    }
  return null;
}

/** Ciclo nas dependências (lista de ids) ou null. */
export function findCycle(tasks: { id: string; deps: string[] }[]): string[] | null {
  const by = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 2) return null;
    if (s === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of by.get(id)?.deps ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    const c = visit(t.id);
    if (c) return c;
  }
  return null;
}

/** Caminho do arquivo das orquestrações na pasta de dados do app. */
export function orqFile(dataDir: string) {
  return path.join(dataDir, 'orchestrations.json');
}

// ------------------------------------------------------------------ gerenciador

export interface OrqCreateOptions {
  hostId: string;
  cwd: string;
  wid?: string;
  goal?: string;
  title?: string;
  workerPermissionMode?: PermissionMode;
  maxParallel?: number;
  requireApproval?: boolean;
  model?: string;
  effort?: OrqEffort;
  workerModel?: string;
  orchestratorPermissionMode?: PermissionMode;
}

export interface OrqManagerDeps {
  sessions: SessionManager;
  registry: HostRegistry;
  file: string;
  log: (m: string) => void;
  /** Fecha uma conversa como o botão da aba (estado das janelas, conexão SSH ociosa). */
  closeSession: (sid: string) => Promise<void>;
}

interface Waiter {
  filter: Set<string> | null;
  resolve: (evs: EventRec[]) => void;
}

export class OrqManager extends EventEmitter implements OrqBridge {
  private orqs = new Map<string, OrqRec>();
  private waiters = new Map<string, Set<Waiter>>();
  private deliveryTimers = new Map<string, NodeJS.Timeout>();
  private turnTimers = new Map<string, NodeJS.Timeout>();
  private mirrorTimers = new Map<string, NodeJS.Timeout>();
  private persistTimer: NodeJS.Timeout | null = null;
  /** Texto das respostas do turno atual de cada worker (para worker_read quando o CLI não manda `result`). */
  private turnText = new Map<string, string>();
  private lastWorkerState = new Map<string, OrqWorkerState>();

  constructor(private deps: OrqManagerDeps) {
    super();
    const s = deps.sessions;
    s.on('state', (st) => this.onSessionState(st));
    s.on('msg', (sid: string, m: { msg: any }) => this.onSessionMsg(sid, m.msg));
    s.on('attention', (st, a) => this.onAttention(st, a));
  }

  // ---------------------------------------------------------------- persistência

  load() {
    const recs = readJson<OrqRec[]>(this.deps.file, []);
    if (!Array.isArray(recs)) return;
    for (const r of recs) {
      if (!r?.id || !r.hostId || !r.cwd || !r.orchestratorSid || !Array.isArray(r.tasks) || !Array.isArray(r.workers)) continue;
      r.events = Array.isArray(r.events) ? r.events : [];
      r.nudges = Number(r.nudges) || 0;
      if (r.exhausted && (typeof r.exhausted !== 'object' || Array.isArray(r.exhausted))) r.exhausted = undefined;
      this.orqs.set(r.id, r);
    }
  }

  private persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 400);
    this.persistTimer.unref?.();
  }

  persistNow(strict = false) {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    try {
      writeJsonAtomic(this.deps.file, [...this.orqs.values()]);
    } catch (e) {
      this.deps.log(`falha ao gravar orquestrações: ${(e as Error).message}`);
      if (strict) throw e;
    }
  }

  shutdown() {
    for (const t of [...this.deliveryTimers.values(), ...this.turnTimers.values(), ...this.mirrorTimers.values()]) clearTimeout(t);
    this.deliveryTimers.clear();
    this.turnTimers.clear();
    this.mirrorTimers.clear();
    for (const set of this.waiters.values()) for (const w of [...set]) w.resolve([]);
    this.waiters.clear();
    this.persistNow();
  }

  // ---------------------------------------------------------------- consultas

  list(): OrchestrationView[] {
    return [...this.orqs.values()].map((o) => this.view(o));
  }

  get(id: string): OrqRec {
    const o = this.orqs.get(id);
    if (!o) throw new DeckError('noorq', 'Orquestração não encontrada.');
    return o;
  }

  view(o: OrqRec): OrchestrationView {
    return {
      id: o.id,
      hostId: o.hostId,
      cwd: o.cwd,
      wid: this.orchestrator(o)?.state.wid ?? o.wid,
      orchestratorSid: o.orchestratorSid,
      title: o.title,
      status: o.status,
      stateDir: o.stateDir,
      createdAt: o.createdAt,
      settings: { workerPermissionMode: o.settings.workerPermissionMode, maxParallel: o.settings.maxParallel, requireApproval: o.settings.requireApproval },
      tasks: o.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, deps: t.deps, files: t.files, workers: t.workers })),
      workers: o.workers.map((w) => ({
        id: w.id,
        taskId: w.taskId,
        sid: w.sid,
        role: w.role,
        state: this.workerState(w),
        model: w.model,
        effort: w.effort,
        report: w.report?.status,
        costUsd: w.costUsd,
        startedAt: w.startedAt,
      })),
      queued: o.events.length,
      planSummary: o.planSummary || undefined,
      exhaustedModels: Object.entries(o.exhausted ?? {})
        .filter(([, e]) => e.until > Date.now())
        .map(([model, e]) => ({ model, kind: e.kind, until: e.until, reason: e.reason })),
      summary: o.summary,
    };
  }

  private changed(o: OrqRec) {
    this.persistSoon();
    this.mirrorSoon(o);
    this.emit('update', this.view(o));
  }

  private orchestrator(o: OrqRec): ClaudeSession | undefined {
    return this.deps.sessions.sessions.get(o.orchestratorSid);
  }

  private byRole(s: ClaudeSession): { o: OrqRec; w?: WorkerRec } | null {
    const r = s.state.orq;
    if (!r) return null;
    const o = this.orqs.get(r.id);
    if (!o) return null;
    if (r.role === 'orchestrator') return o.orchestratorSid === s.state.sid ? { o } : null;
    const w = o.workers.find((x) => x.sid === s.state.sid);
    return w ? { o, w } : null;
  }

  private findWorker(o: OrqRec, id: unknown): WorkerRec {
    const w = typeof id === 'string' ? o.workers.find((x) => x.id === id.trim()) : undefined;
    if (!w) throw new DeckError('bad', `Worker desconhecido: ${String(id)}. Workers: ${o.workers.map((x) => x.id).join(', ') || '(nenhum)'}.`);
    return w;
  }

  /** Estado do worker calculado da conversa dele (nunca fica preso num valor velho gravado). */
  workerState(w: WorkerRec): OrqWorkerState {
    const s = this.deps.sessions.sessions.get(w.sid);
    if (!s || w.closed || s.state.phase === 'ended' || s.isClosing) return 'closed';
    if (s.pendingPermissions.size) {
      const asks = [...s.pendingPermissions.values()].some((m: any) => ANSWER_TOOLS.has(m?.request?.tool_name));
      return asks ? 'waiting_answer' : 'waiting_permission';
    }
    const ph = s.state.phase;
    if (ph === 'running' || ph === 'reconnecting') return 'working';
    if (ph === 'starting') return 'starting';
    if (ph === 'error') return 'error';
    if (w.awaitingTurn) return 'working';
    if (w.error) return 'error';
    if (w.stopped) return 'stopped';
    return 'idle';
  }

  private isActive(w: WorkerRec) {
    return ACTIVE_STATES.includes(this.workerState(w));
  }

  // ---------------------------------------------------------------- criar

  /** Confere as opções de criação sem efeito colateral (o servidor chama antes de mexer no contexto da janela). */
  checkCreate(opts: OrqCreateOptions): { workerPermissionMode: PermissionMode; maxParallel: number; effort: OrqEffort; goal: string } {
    if (!this.deps.registry.exists(opts.hostId)) throw new DeckError('nohost', 'Servidor desconhecido.');
    if (typeof opts.cwd !== 'string' || !opts.cwd.trim()) throw new DeckError('bad', 'Pasta inválida.');
    const workerPermissionMode = opts.workerPermissionMode ?? 'default';
    if (!PERMISSION_MODES.includes(workerPermissionMode)) throw new DeckError('bad', 'Modo de permissão dos workers inválido.');
    const maxParallel = Math.round(Number(opts.maxParallel ?? 3));
    if (!Number.isFinite(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new DeckError('bad', 'Workers simultâneos: de 1 a 8.');
    const effort = opts.effort ?? 'high';
    if (!ORQ_EFFORTS.includes(effort)) throw new DeckError('bad', 'O esforço do orquestrador precisa ser high, xhigh ou max.');
    for (const m of [opts.model, opts.workerModel]) if (m && !MODEL_RE.test(m)) throw new DeckError('bad', 'Nome de modelo inválido.');
    if (opts.orchestratorPermissionMode && !PERMISSION_MODES.includes(opts.orchestratorPermissionMode)) throw new DeckError('bad', 'Modo de permissão inválido.');
    const goal = typeof opts.goal === 'string' ? opts.goal.trim() : '';
    if (goal.length > MAX_BRIEF) throw new DeckError('bad', 'Objetivo longo demais.');
    return { workerPermissionMode, maxParallel, effort, goal };
  }

  async create(opts: OrqCreateOptions): Promise<{ view: OrchestrationView; sid: string }> {
    const { workerPermissionMode, maxParallel, effort, goal } = this.checkCreate(opts);
    const host = await this.host(opts.hostId);
    const cwd = normalize(host.platform, opts.cwd);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const id = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${crypto.randomBytes(2).toString('hex')}`;
    const stateDir = join(host.platform, cwd, '.claude-deck', 'orq', id);
    const title = clip(opts.title || goal.split('\n')[0] || 'Orquestração', 60) || 'Orquestração';

    // A pasta de estado existe antes de o orquestrador começar (ele escreve PLANO.md e STATE.md nela).
    await this.prepareStateDir(opts.hostId, host.platform, cwd, stateDir, title, goal);

    const o: OrqRec = {
      id,
      hostId: opts.hostId,
      cwd,
      wid: opts.wid,
      orchestratorSid: '',
      title,
      createdAt: Date.now(),
      // Sempre começa planejando (conversa com o usuário, sem lembretes); plan_submit passa a executar.
      status: 'planning',
      settings: { workerPermissionMode, maxParallel, requireApproval: opts.requireApproval !== false, workerModel: opts.workerModel || undefined },
      stateDir,
      platform: host.platform,
      tasks: [],
      workers: [],
      events: [],
      nudges: 0,
    };
    this.orqs.set(id, o);
    // O vínculo vai junto da criação: o "initialize" do CLI já registra o servidor MCP da orquestração.
    const s = this.deps.sessions.create({
      hostId: opts.hostId,
      cwd,
      wid: opts.wid,
      permissionMode: opts.orchestratorPermissionMode,
      model: opts.model || undefined,
      effort,
      title: `Orquestrador · ${title}`,
      userTitle: true,
      orq: { id, role: 'orchestrator' },
    });
    o.orchestratorSid = s.state.sid;
    this.persistNow();
    this.changed(o);
    this.deps.log(`orquestração ${id} criada em ${opts.hostId}:${cwd} (workers ${workerPermissionMode}, até ${maxParallel})`);
    if (goal) {
      const lead = `<system-reminder>\nOrquestração ${id} criada pelo usuário no Claude Deck. Pasta de estado: ${stateDir}. Comece pelo passo 1 (entender o projeto) e depois faça as perguntas gerais de planejamento.\n</system-reminder>\n`;
      s.send([{ type: 'text', text: lead + goal }], crypto.randomUUID()).catch((e) => this.deps.log(`orquestração ${id}: primeira mensagem falhou: ${(e as Error).message}`));
    }
    return { view: this.view(o), sid: s.state.sid };
  }

  private async host(hostId: string) {
    if (hostId !== LOCAL_HOST_ID) await this.deps.registry.connect(hostId);
    return this.deps.registry.get(hostId);
  }

  private async prepareStateDir(hostId: string, platform: Platform, cwd: string, stateDir: string, title: string, goal: string) {
    const h = await this.host(hostId);
    await mkdirp(h.fs, join(platform, stateDir, 'briefs'));
    await mkdirp(h.fs, join(platform, stateDir, 'reports'));
    // Fora do git por padrão, sem mexer no .gitignore do projeto: apague este arquivo para versionar o plano.
    const ignore = join(platform, cwd, '.claude-deck', '.gitignore');
    await h.fs
      .write(ignore, Buffer.from('# Criado pelo Claude Deck: mantém o estado das orquestrações fora do git.\n# Apague este arquivo se quiser versionar planos e relatórios.\n*\n'), { createOnly: true })
      .catch(() => {});
    const state = join(platform, stateDir, 'STATE.md');
    const quoted = goal ? goal.split('\n').map((l) => `> ${l}`).join('\n') : '> (ainda não informado)';
    await h.fs
      .write(state, Buffer.from(`# Estado da orquestração: ${title}\n\nObjetivo (pedido do usuário):\n\n${quoted}\n\nO orquestrador mantém este arquivo: onde parou, decisões, bloqueios e próximos passos.\n`), { createOnly: true })
      .catch(() => {});
  }

  /** Conversa reaberta pelo Histórico: volta a ser o orquestrador/worker que era (antes de o processo iniciar). */
  roleForResume(hostId: string, sessionId: string): SessionOrqRole | undefined {
    for (const o of this.orqs.values()) {
      if (o.hostId !== hostId) continue;
      if (o.orchestratorSessionId === sessionId) return { id: o.id, role: 'orchestrator' };
      const w = o.workers.find((x) => x.sessionId === sessionId);
      if (w) return { id: o.id, role: 'worker', taskId: w.taskId, workerId: w.id };
    }
    return undefined;
  }

  /** Liga a aba nova (sid novo) ao registro da orquestração depois de uma retomada pelo Histórico. */
  relink(s: ClaudeSession) {
    const r = s.state.orq;
    if (!r) return;
    const o = this.orqs.get(r.id);
    if (!o) return;
    if (r.role === 'orchestrator') {
      if (o.orchestratorSid === s.state.sid) return;
      o.orchestratorSid = s.state.sid;
      if (o.status === 'paused' && o.resumeStatus) {
        o.status = o.resumeStatus;
        o.resumeStatus = undefined;
      }
      this.changed(o);
      return;
    }
    const w = o.workers.find((x) => x.id === r.workerId);
    if (w && w.sid !== s.state.sid) {
      w.sid = s.state.sid;
      w.closed = false;
      this.changed(o);
    }
  }

  // ---------------------------------------------------------------- ponte com a conversa (MCP)

  toolsFor(s: ClaudeSession): OrqToolSpec[] {
    const r = this.byRole(s);
    if (!r) return [];
    if (r.w) return WORKER_TOOLS;
    // Só os modelos que o gateway aceita agora (os esgotados somem da lista até o prazo vencer).
    return orchestratorTools(this.hostModels(r.o).filter((m) => !this.isModelBlocked(r.o, m)));
  }

  instructionsFor(s: ClaudeSession): string {
    const r = this.byRole(s);
    if (!r) return '';
    if (r.w) {
      const t = r.o.tasks.find((x) => x.id === r.w!.taskId);
      return workerInstructions({ taskId: r.w.taskId, title: t?.title ?? r.w.taskId, workerId: r.w.id, briefPath: r.w.briefPath, role: r.w.role });
    }
    return orchestratorInstructions({ stateDir: r.o.stateDir, maxParallel: r.o.settings.maxParallel, workerPermissionMode: r.o.settings.workerPermissionMode, requireApproval: r.o.settings.requireApproval });
  }

  async call(s: ClaudeSession, tool: string, args: any, signal: AbortSignal): Promise<ToolResult> {
    const r = this.byRole(s);
    if (!r) return fail('Esta conversa não faz parte de uma orquestração ativa.');
    try {
      if (r.w) {
        if (tool !== 'task_report') return fail('Ferramenta desconhecida.');
        return await this.taskReport(r.o, r.w, args);
      }
      const o = r.o;
      switch (tool) {
        case 'tasks_define':
          return this.tasksDefine(o, args);
        case 'task_update':
          return this.taskUpdate(o, args);
        case 'tasks_list':
          return text(this.board(o));
        case 'plan_submit':
          return this.planSubmit(o, args);
        case 'worker_start':
          return await this.workerStart(o, s, args);
        case 'worker_send':
          return await this.workerSend(o, args);
        case 'worker_wait':
          return await this.workerWait(o, args, signal);
        case 'worker_status':
          return text(args.worker ? this.workerLine(o, this.findWorker(o, args.worker), true) : this.workersBlock(o));
        case 'worker_result':
          return text(this.workerResult(o, this.findWorker(o, args.worker)));
        case 'worker_read':
          return text(this.workerRead(this.findWorker(o, args.worker), args.max_chars));
        case 'worker_stop':
          return await this.workerStop(o, args);
        case 'orq_wait_user':
          return this.waitUser(o, args);
        case 'orq_finish':
          return this.finish(o, args);
        default:
          return fail('Ferramenta desconhecida.');
      }
    } catch (e) {
      return fail((e as Error).message || String(e));
    }
  }

  // ---------------------------------------------------------------- ferramentas: plano

  private tasksDefine(o: OrqRec, args: any): ToolResult {
    if (o.status === 'done' || o.status === 'cancelled') return fail('A orquestração já foi encerrada.');
    const list: any[] = Array.isArray(args.tasks) ? args.tasks : [];
    const remove: string[] = Array.isArray(args.remove) ? args.remove : [];
    if (!list.length && !remove.length) return fail('Informe tasks e/ou remove.');
    // Valida tudo antes de mudar qualquer coisa.
    const next = o.tasks.map((t) => ({ ...t }));
    for (const id of remove) {
      const i = next.findIndex((t) => t.id === id);
      if (i < 0) return fail(`Tarefa ${id} não existe.`);
      if (next[i].workers.length) return fail(`Tarefa ${id} já teve worker; use task_update com status "cancelled".`);
      next.splice(i, 1);
    }
    const created: string[] = [];
    const updated: string[] = [];
    for (const raw of list) {
      const id = String(raw.id ?? '').trim();
      if (!TASK_ID_RE.test(id)) return fail(`Id de tarefa inválido: "${id}". Use letras, números, ponto, hífen ou sublinhado (até 32).`);
      const title = clip(String(raw.title ?? ''), 120);
      if (!title) return fail(`Tarefa ${id}: informe o título.`);
      let files: string[];
      try {
        files = normalizeTaskFiles(o.cwd, o.platform, Array.isArray(raw.files) ? raw.files : []);
      } catch (e) {
        return fail(`Tarefa ${id}: ${(e as Error).message}`);
      }
      const deps = [...new Set((Array.isArray(raw.depends_on) ? raw.depends_on : []).map((d: any) => String(d).trim()).filter(Boolean))] as string[];
      if (deps.includes(id)) return fail(`Tarefa ${id} não pode depender de si mesma.`);
      const verify = (Array.isArray(raw.verify) ? raw.verify : []).map((v: any) => clip(String(v), 500)).filter(Boolean).slice(0, 20);
      const cur = next.find((t) => t.id === id);
      if (cur) {
        if (cur.status === 'done') return fail(`Tarefa ${id} já está concluída; crie uma tarefa nova para mudanças.`);
        Object.assign(cur, { title, files, deps, verify, notes: raw.notes ? clip(String(raw.notes), 1000) : cur.notes, updatedAt: Date.now() });
        updated.push(id);
      } else {
        next.push({ id, title, deps, files, verify, notes: raw.notes ? clip(String(raw.notes), 1000) : undefined, status: 'pending', workers: [], updatedAt: Date.now() });
        created.push(id);
      }
    }
    if (next.length > MAX_TASKS) return fail(`Tarefas demais (máximo ${MAX_TASKS}).`);
    const ids = new Set(next.map((t) => t.id));
    for (const t of next) for (const d of t.deps) if (!ids.has(d)) return fail(`Tarefa ${t.id} depende de ${d}, que não existe.`);
    const cycle = findCycle(next);
    if (cycle) return fail(`Dependência circular: ${cycle.join(' → ')}.`);
    o.tasks = next;
    o.nudges = 0;
    this.changed(o);
    return text(
      `Plano atualizado: ${created.length} criada(s)${created.length ? ` (${created.join(', ')})` : ''}, ${updated.length} atualizada(s)${remove.length ? `, ${remove.length} removida(s)` : ''}.\n\n${this.board(o)}`,
    );
  }

  private taskUpdate(o: OrqRec, args: any): ToolResult {
    const t = o.tasks.find((x) => x.id === String(args.id ?? '').trim());
    if (!t) return fail(`Tarefa desconhecida: ${args.id}.`);
    const status = args.status as OrqTaskStatus | undefined;
    if (status) {
      if (status === 'done') {
        const ev = String(args.evidence ?? '').trim();
        if (ev.length < 10) return fail('Para marcar "done", informe em evidence o que provou que está pronta (comandos rodados e resultado).');
        const active = o.workers.filter((w) => w.taskId === t.id && w.role === 'implement' && this.isActive(w));
        if (active.length) return fail(`O worker ${active.map((w) => w.id).join(', ')} ainda está trabalhando nesta tarefa.`);
        t.evidence = clip(ev, 2000);
      }
      if (status === 'blocked' && !String(args.notes ?? '').trim()) return fail('Para "blocked", explique o motivo em notes.');
      t.status = status;
    }
    if (args.notes) t.notes = clip(String(args.notes), 1000);
    t.updatedAt = Date.now();
    o.nudges = 0;
    this.changed(o);
    return text(`Tarefa ${t.id}: ${t.status}.${this.readyLine(o)}`);
  }

  private planSubmit(o: OrqRec, args: any): ToolResult {
    if (o.status === 'done' || o.status === 'cancelled') return fail('A orquestração já foi encerrada.');
    if (!o.tasks.length) return fail('Registre as tarefas com tasks_define antes de enviar o plano.');
    o.planSummary = clip(String(args.summary ?? ''), 2000);
    if (!o.settings.requireApproval) {
      if (o.status === 'planning' || o.status === 'awaiting_approval') o.status = 'running';
      o.nudges = 0;
      this.changed(o);
      return text('O usuário dispensou a aprovação: pode começar (worker_start).');
    }
    if (o.status !== 'planning' && o.status !== 'awaiting_approval') {
      // Replanejamento no meio da execução: o plano vale (já aprovado); só registra o resumo novo.
      this.changed(o);
      return text('Plano atualizado. A orquestração já está aprovada e em execução; continue.');
    }
    o.status = 'awaiting_approval';
    o.nudges = 0;
    this.changed(o);
    return text(
      'Plano enviado para aprovação. Resuma o plano para o usuário (tarefas, ordem, o que será verificado) e TERMINE o turno; não crie workers. O Claude Deck avisa quando ele aprovar pelo botão.',
    );
  }

  // ---------------------------------------------------------------- ferramentas: workers

  private async workerStart(o: OrqRec, orchestrator: ClaudeSession, args: any): Promise<ToolResult> {
    if (o.status === 'planning' || o.status === 'awaiting_approval')
      return fail(
        o.settings.requireApproval
          ? 'O plano ainda não foi aprovado pelo usuário. Chame plan_submit (se ainda não chamou), resuma o plano e termine o turno; o Claude Deck avisa quando ele aprovar.'
          : 'Registre o plano com plan_submit antes de criar workers (o usuário dispensou a aprovação: ele vale na hora).',
      );
    if (o.status === 'paused') return fail('O usuário pausou a orquestração. Não crie workers até ele retomar.');
    if (o.status === 'done' || o.status === 'cancelled') return fail('A orquestração já foi encerrada.');
    if (orchestrator.state.permissionMode === 'plan') return fail('O modo de planejamento não permite criar workers. Peça ao usuário para mudar o modo de permissão.');
    const t = o.tasks.find((x) => x.id === String(args.task_id ?? '').trim());
    if (!t) return fail(`Tarefa desconhecida: ${args.task_id}. Tarefas: ${o.tasks.map((x) => x.id).join(', ')}.`);
    if (t.status === 'done' || t.status === 'cancelled') return fail(`A tarefa ${t.id} está ${t.status}.`);
    const role: OrqWorkerRole = args.role ?? 'implement';
    const effort = args.effort as OrqWorkerEffort;
    if (!ORQ_WORKER_EFFORTS.includes(effort)) return fail('Esforço inválido: use medium, high, xhigh ou max (nunca low).');
    let model = args.model ? String(args.model).trim() : o.settings.workerModel;
    if (model && !MODEL_RE.test(model)) return fail('Nome de modelo inválido.');
    let swapped = '';
    if (model && this.isModelBlocked(o, model)) {
      // Pedido explícito de um modelo recusado: o orquestrador escolhe outro (ele sabe a dificuldade da tarefa).
      if (args.model) return fail(`O modelo ${model} está recusado pelo gateway agora (esgotado ou indisponível). Escolha outro.${this.exhaustedLine(o)}`);
      // Modelo padrão dos workers recusado: o Deck usa um reserva disponível.
      const alt = pickFallbackModel(model, this.hostModels(o), (m) => this.isModelBlocked(o, m));
      if (!alt) return fail(`O modelo padrão dos workers (${model}) está recusado pelo gateway e não há outro disponível neste servidor.${this.exhaustedLine(o)}`);
      swapped = ` (o padrão ${model} está esgotado; o Claude Deck usou ${alt})`;
      model = alt;
    }
    const brief = String(args.brief ?? '').trim();
    if (brief.length < 40) return fail('Briefing curto demais: o worker não vê esta conversa. Inclua objetivo, escopo, arquivos, critério de pronto e o que fazer se faltar algo.');
    if (brief.length > MAX_BRIEF) return fail('Briefing longo demais: passe caminhos de arquivos em vez de colar conteúdo.');
    const pendingDeps = t.deps.filter((d) => o.tasks.find((x) => x.id === d)?.status !== 'done');
    if (pendingDeps.length) return fail(`A tarefa ${t.id} depende de ${pendingDeps.join(', ')}, ainda não concluída(s) (done).`);
    const active = o.workers.filter((w) => this.isActive(w));
    if (active.length >= o.settings.maxParallel)
      return fail(`Limite de ${o.settings.maxParallel} workers simultâneos atingido (${active.map((w) => w.id).join(', ')}). Use worker_wait.`);
    if (role === 'implement') {
      const sameTask = active.find((w) => w.taskId === t.id && w.role === 'implement');
      if (sameTask) return fail(`Já há um worker implementando ${t.id} (${sameTask.id}). Use worker_send ou pare-o antes.`);
      for (const w of active) {
        if (w.role !== 'implement' || w.taskId === t.id) continue;
        const other = o.tasks.find((x) => x.id === w.taskId);
        if (!other) continue;
        if (!t.files.length || !other.files.length) {
          const missing = !t.files.length ? t.id : other.id;
          return fail(`A tarefa ${missing} não declara os arquivos que altera (files), então não pode rodar junto com outra implementação (${w.id} ativo). Declare files com tasks_define ou espere ${w.id} terminar.`);
        }
        const clash = filesOverlap(t.files, other.files);
        if (clash) return fail(`Arquivos sobrepostos com ${other.id} (worker ${w.id} ativo): ${clash[0]} × ${clash[1]}. Espere terminar ou divida os arquivos.`);
      }
    }
    const n = o.workers.filter((w) => w.taskId === t.id).length + 1;
    const workerId = `${t.id}.${n}`;
    const briefPath = join(o.platform, o.stateDir, 'briefs', `${workerId}.md`);
    const reportPath = join(o.platform, o.stateDir, 'reports', `${workerId}.md`);
    const baseCommit = await this.gitHead(o);
    const header = [
      `# ${workerId} · ${t.id} · ${t.title}`,
      '',
      `Papel: ${role} · esforço: ${effort}${model ? ` · modelo: ${model}` : ''}${baseCommit ? ` · commit base: ${baseCommit.slice(0, 12)}` : ''}`,
      t.files.length ? `Arquivos que esta tarefa pode alterar: ${t.files.join(', ')}` : role === 'implement' ? 'Arquivos: não declarados (siga o escopo do briefing).' : '',
      t.verify.length ? `Verificação esperada: ${t.verify.map((v) => `\`${v}\``).join('; ')}` : '',
    ].filter((l, i) => l !== '' || i === 1);
    const briefFile = `${header.join('\n')}\n\n${brief}\n`;
    try {
      const h = await this.host(o.hostId);
      await mkdirp(h.fs, dirname(o.platform, briefPath));
      await h.fs.write(briefPath, Buffer.from(briefFile, 'utf8'));
    } catch (e) {
      return fail(`Não gravei o briefing em ${briefPath} (${(e as Error).message}); nenhum worker foi criado.`);
    }
    const title = `${workerId} · ${t.title}`;
    const s = this.deps.sessions.create({
      hostId: o.hostId,
      cwd: o.cwd,
      wid: orchestrator.state.wid ?? o.wid,
      permissionMode: o.settings.workerPermissionMode,
      model: model || undefined,
      effort,
      title,
      userTitle: true,
      orq: { id: o.id, role: 'worker', taskId: t.id, workerId },
    });
    const w: WorkerRec = { id: workerId, taskId: t.id, sid: s.state.sid, role, model: model || undefined, effort, startedAt: Date.now(), baseCommit, briefPath, reportPath, awaitingTurn: true };
    o.workers.push(w);
    t.workers.push(workerId);
    if (role === 'implement' && (t.status === 'pending' || t.status === 'blocked')) t.status = 'in_progress';
    if (role === 'review' && t.status === 'in_progress') t.status = 'review';
    t.updatedAt = Date.now();
    o.nudges = 0;
    this.persistNow();
    this.changed(o);
    const message = [
      `<orchestrator-message from="orquestrador" task="${t.id}" worker="${workerId}">`,
      briefFile.trim(),
      '',
      '---',
      `Briefing salvo em: ${briefPath}`,
      'Ao terminar (ou se travar), chame task_report e termine o turno com uma linha de resumo.',
      '</orchestrator-message>',
    ].join('\n');
    s.send([{ type: 'text', text: message }], crypto.randomUUID()).catch((e) => {
      w.awaitingTurn = false;
      w.error = `não consegui mandar o briefing: ${(e as Error).message}`;
      this.pushEvent(o, { at: Date.now(), kind: 'error', workerId, text: `${workerId} (${t.id} · ${t.title}) não recebeu o briefing: ${(e as Error).message}` });
      this.changed(o);
    });
    const nowActive = o.workers.filter((x) => this.isActive(x)).map((x) => x.id);
    return text(
      `Worker ${workerId} criado (aba "${title}"): papel ${role}, esforço ${effort}${model ? `, modelo ${model}` : ''}${swapped}${baseCommit ? `, commit base ${baseCommit.slice(0, 12)}` : ''}. Briefing em ${briefPath}.\nAtivos agora: ${nowActive.join(', ')}. Use worker_wait para acompanhar.`,
    );
  }

  private async workerSend(o: OrqRec, args: any): Promise<ToolResult> {
    if (o.status === 'paused') return fail('O usuário pausou a orquestração.');
    const w = this.findWorker(o, args.worker);
    const s = this.deps.sessions.sessions.get(w.sid);
    if (w.closed || !s || s.isClosing) return fail(`A conversa do worker ${w.id} foi fechada. Crie um worker novo para a tarefa ${w.taskId}.`);
    const msg = String(args.message ?? '').trim();
    if (!msg) return fail('Mensagem vazia.');
    if (msg.length > MAX_BRIEF) return fail('Mensagem longa demais.');
    const body = `<orchestrator-message from="orquestrador" worker="${w.id}">\n${msg}\n</orchestrator-message>`;
    const busy = s.state.phase === 'running';
    w.awaitingTurn = true;
    w.error = undefined;
    w.stopped = false;
    this.changed(o);
    try {
      await s.send([{ type: 'text', text: body }], crypto.randomUUID());
    } catch (e) {
      w.awaitingTurn = false;
      this.changed(o);
      return fail(`Não consegui mandar ao worker ${w.id}: ${(e as Error).message}`);
    }
    return text(`Mensagem enviada a ${w.id}${busy ? ' (ele está trabalhando: entra na fila dele)' : ''}.`);
  }

  private async workerStop(o: OrqRec, args: any): Promise<ToolResult> {
    const w = this.findWorker(o, args.worker);
    const s = this.deps.sessions.sessions.get(w.sid);
    if (!s || w.closed) return text(`O worker ${w.id} já estava fechado.`);
    w.stopped = true;
    w.awaitingTurn = false;
    try {
      await s.interrupt();
    } catch (e) {
      this.deps.log(`orquestração ${o.id}: interromper ${w.id}: ${(e as Error).message}`);
    }
    if (args.close === true) {
      w.closed = true;
      await this.deps.closeSession(w.sid).catch((e) => this.deps.log(`orquestração ${o.id}: fechar ${w.id}: ${(e as Error).message}`));
    }
    this.changed(o);
    return text(`Worker ${w.id} ${args.close === true ? 'parado e fechado (o transcript continua no Histórico)' : 'interrompido'}.`);
  }

  private async workerWait(o: OrqRec, args: any, signal: AbortSignal): Promise<ToolResult> {
    const ids: string[] = Array.isArray(args.workers) ? args.workers.map((x: any) => String(x).trim()).filter(Boolean) : [];
    for (const id of ids) this.findWorker(o, id);
    const filter = ids.length ? new Set(ids) : null;
    const secs = Math.min(Math.max(Number(args.timeout_seconds) || 600, 1), 1800);
    let evs = this.take(o, filter);
    if (!evs.length) {
      const watched = o.workers.filter((w) => (!filter || filter.has(w.id)) && this.isActive(w));
      if (!watched.length) return text(`Nenhum worker ativo para esperar.\n\n${this.board(o)}`);
      evs = await new Promise<EventRec[]>((resolve) => {
        const set = this.waiters.get(o.id) ?? new Set<Waiter>();
        this.waiters.set(o.id, set);
        let timer: NodeJS.Timeout | undefined;
        const onAbort = () => done([]);
        const waiter: Waiter = { filter, resolve: (x) => done(x) };
        function done(x: EventRec[]) {
          if (timer) clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          set.delete(waiter);
          resolve(x);
        }
        if (signal.aborted) return done([]);
        timer = setTimeout(() => done([]), secs * 1000);
        set.add(waiter);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (!evs.length) {
      if (signal.aborted) return fail('Espera cancelada.');
      return text(`Nenhum evento em ${secs}s.\n${this.workersBlock(o)}`);
    }
    return text(`${this.formatEvents(evs)}\n\n${this.progressLine(o)}`);
  }

  private workerResult(o: OrqRec, w: WorkerRec): string {
    const t = o.tasks.find((x) => x.id === w.taskId);
    const lines = [this.workerLine(o, w, true)];
    if (!w.report) {
      lines.push('', 'Sem relatório (task_report) ainda.');
      if (w.finalText) lines.push(`Última resposta: ${clip(w.finalText, 600)}`);
      lines.push('Peça o relatório com worker_send ou leia mais com worker_read.');
      return lines.join('\n');
    }
    const r = w.report;
    lines.push('', `Relatório: ${r.status.toUpperCase()}`, r.summary);
    if (r.filesChanged.length) lines.push('', `Arquivos alterados: ${r.filesChanged.join(', ')}`);
    if (r.checks.length) {
      lines.push('', 'Verificações (informadas pelo worker; confirme você mesmo):');
      for (const c of r.checks) lines.push(`- \`${c.command}\` → ${c.exitCode ?? '?'}${c.outputTail ? ` · ${clip(c.outputTail, 300)}` : ''}`);
    }
    if (r.concerns) lines.push('', `Ressalvas: ${r.concerns}`);
    if (r.path) lines.push('', `Relatório completo: ${r.path}`);
    if (w.baseCommit) lines.push(`Commit base: ${w.baseCommit} (diff: git diff ${w.baseCommit.slice(0, 12)} -- ${t?.files.join(' ') || '.'})`);
    return lines.join('\n');
  }

  private workerRead(w: WorkerRec, max: unknown): string {
    const n = Math.min(Math.max(Number(max) || 3000, 200), 12000);
    const t = w.finalText ?? '';
    if (!t) return `${w.id}: nenhuma resposta final registrada ainda.`;
    return t.length > n ? `…${t.slice(t.length - n)}` : t;
  }

  private waitUser(o: OrqRec, args: any): ToolResult {
    o.waitingReason = clip(String(args.reason ?? ''), 500);
    if (o.status === 'running' || o.status === 'stalled') o.status = 'waiting_user';
    o.nudges = 0;
    this.changed(o);
    return text('Registrado: sem lembretes até o usuário responder. Faça a pergunta e termine o turno. Eventos dos workers continuam chegando.');
  }

  private finish(o: OrqRec, args: any): ToolResult {
    const open = o.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    if (open.length) return fail(`Ainda há tarefas abertas: ${open.map((t) => `${t.id} (${t.status})`).join(', ')}. Conclua (com evidência) ou cancele antes.`);
    const active = o.workers.filter((w) => this.isActive(w));
    if (active.length) return fail(`Workers ainda ativos: ${active.map((w) => w.id).join(', ')}. Pare-os ou espere.`);
    o.status = 'done';
    o.summary = clip(String(args.summary ?? ''), 4000);
    o.finishedAt = Date.now();
    o.events = [];
    this.changed(o);
    return text('Orquestração concluída. Apresente o resumo final ao usuário.');
  }

  // ---------------------------------------------------------------- ferramenta do worker

  private async taskReport(o: OrqRec, w: WorkerRec, args: any): Promise<ToolResult> {
    const r: ReportRec = {
      status: args.status,
      summary: clip(String(args.summary ?? ''), 4000),
      filesChanged: (Array.isArray(args.files_changed) ? args.files_changed : []).map((f: any) => clip(String(f), 300)).slice(0, 200),
      checks: (Array.isArray(args.checks) ? args.checks : []).slice(0, 30).map((c: any) => ({
        command: clip(String(c.command ?? ''), 500),
        exitCode: typeof c.exit_code === 'number' ? c.exit_code : undefined,
        outputTail: c.output_tail ? String(c.output_tail).slice(-1500) : undefined,
      })),
      concerns: args.concerns ? clip(String(args.concerns), 3000) : undefined,
      at: Date.now(),
    };
    const t = o.tasks.find((x) => x.id === w.taskId);
    const parts = [
      `# Relatório ${w.id} · ${w.taskId} · ${t?.title ?? ''}`,
      `Status: **${r.status}** · ${new Date(r.at).toISOString()}${w.baseCommit ? ` · commit base ${w.baseCommit}` : ''}`,
      `## Resumo\n\n${r.summary}`,
    ];
    if (r.filesChanged.length) parts.push(`## Arquivos alterados\n\n${r.filesChanged.map((f) => `- ${f}`).join('\n')}`);
    if (r.checks.length)
      parts.push(`## Verificações\n\n${r.checks.map((c) => `- \`${c.command}\` → ${c.exitCode ?? '?'}${c.outputTail ? `\n\n\`\`\`\n${c.outputTail}\n\`\`\`` : ''}`).join('\n')}`);
    if (r.concerns) parts.push(`## Ressalvas\n\n${r.concerns}`);
    if (args.report_markdown) parts.push(`## Detalhes\n\n${String(args.report_markdown).slice(0, 150_000)}`);
    try {
      const h = await this.host(o.hostId);
      await mkdirp(h.fs, dirname(o.platform, w.reportPath));
      await h.fs.write(w.reportPath, Buffer.from(parts.join('\n\n') + '\n', 'utf8'));
      r.path = w.reportPath;
    } catch (e) {
      this.deps.log(`orquestração ${o.id}: relatório de ${w.id} não gravado: ${(e as Error).message}`);
    }
    w.report = r;
    w.reportUnannounced = true;
    o.nudges = 0;
    this.changed(o);
    return text(`Relatório registrado${r.path ? ` em ${r.path}` : ''}. O orquestrador será avisado quando seu turno terminar. Termine agora com uma linha de resumo.`);
  }

  // ---------------------------------------------------------------- eventos das conversas

  private onSessionState(st: { sid: string; phase: string; orq?: SessionOrqRole; sessionId?: string; error?: string }) {
    if (!st.orq) return;
    const o = this.orqs.get(st.orq.id);
    if (!o) return;
    if (st.orq.role === 'orchestrator') {
      if (o.orchestratorSid !== st.sid) return;
      if (st.sessionId && st.sessionId !== o.orchestratorSessionId) {
        o.orchestratorSessionId = st.sessionId;
        this.persistSoon();
      }
      if (st.phase === 'ended') {
        // A aba do orquestrador foi fechada: os workers seguem; nada é entregue até ele voltar (Histórico → retomar).
        if (!['done', 'cancelled', 'paused'].includes(o.status)) {
          o.resumeStatus = o.status;
          o.status = 'paused';
        }
        this.changed(o);
        return;
      }
      if (st.phase === 'idle' || st.phase === 'dormant') this.scheduleDelivery(o);
      return;
    }
    const w = o.workers.find((x) => x.sid === st.sid);
    if (!w) return;
    if (st.sessionId && st.sessionId !== w.sessionId) {
      w.sessionId = st.sessionId;
      this.persistSoon();
    }
    if (st.phase === 'running') {
      // Emendou outro turno: o fim anterior não era o fim de verdade.
      const t = this.turnTimers.get(w.sid);
      if (t) clearTimeout(t);
      this.turnTimers.delete(w.sid);
    }
    if (st.phase === 'error' && st.error && w.error !== st.error) {
      w.error = st.error;
      w.awaitingTurn = false;
      this.pushEvent(o, { at: Date.now(), kind: 'error', workerId: w.id, text: `${this.label(o, w)} falhou: ${clip(st.error, 400)}` });
    }
    if (st.phase === 'ended' && !w.closed) {
      w.closed = true;
      w.awaitingTurn = false;
      const t = o.tasks.find((x) => x.id === w.taskId);
      if (!w.report && t && t.status !== 'done' && t.status !== 'cancelled')
        this.pushEvent(o, { at: Date.now(), kind: 'closed', workerId: w.id, text: `A aba do worker ${this.label(o, w)} foi fechada sem relatório.` });
    }
    const now = this.workerState(w);
    if (this.lastWorkerState.get(w.sid) !== now) {
      this.lastWorkerState.set(w.sid, now);
      this.changed(o);
    }
  }

  // ---------------------------------------------------------------- modelo esgotado no gateway

  /** Modelos que o servidor da orquestração informou (sem "default"). */
  private hostModels(o: OrqRec): string[] {
    return (this.deps.sessions.caps.get(o.hostId)?.models ?? []).map((m) => m.value).filter((v) => !!v && v !== 'default');
  }

  /** O modelo está recusado agora (esgotado e ainda no prazo, ou inexistente)? Limpa os prazos vencidos. */
  isModelBlocked(o: OrqRec, model: string | undefined): boolean {
    if (!model || !o.exhausted) return false;
    const k = modelKey(model);
    const e = o.exhausted[k];
    if (!e) return false;
    if (e.until > Date.now()) return true;
    delete o.exhausted[k];
    this.persistSoon();
    return false;
  }

  private markExhausted(o: OrqRec, model: string, f: ModelFailure) {
    // Esgotado: o prazo do gateway (limitado a 6 h) ou 30 min. Inexistente: 24 h (não volta sozinho).
    const ms = f.kind === 'unavailable' ? 24 * 3_600_000 : Math.min(Math.max(f.retryAfterMs ?? 30 * 60_000, 60_000), 6 * 3_600_000);
    (o.exhausted ??= {})[modelKey(model)] = { until: Date.now() + ms, kind: f.kind, reason: f.reason };
    this.persistSoon();
  }

  /** Lista para o orquestrador: modelos recusados agora (com o motivo e até quando). */
  private exhaustedLine(o: OrqRec): string {
    const list = Object.entries(o.exhausted ?? {}).filter(([k]) => this.isModelBlocked(o, k));
    if (!list.length) return '';
    return `\nModelos recusados pelo gateway agora (não use): ${list
      .map(([k, e]) => `${k} (${e.kind === 'unavailable' ? 'indisponível' : `esgotado até ${new Date(e.until).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`})`)
      .join(', ')}.`;
  }

  /**
   * Turno de uma conversa da orquestração terminou porque o gateway recusou o modelo: o Deck troca para outro modelo
   * disponível do servidor e manda continuar (mesmo transcript: nada se perde). Vale para o orquestrador também — sem
   * isso ele nem conseguiria chamar ferramentas para se recuperar. Devolve true se tratou (troca feita ou desistência
   * anunciada); false se não era erro de modelo.
   */
  private handleModelFailure(o: OrqRec, s: ClaudeSession, msg: any, w?: WorkerRec): boolean {
    const f = modelFailureOf(msg);
    if (!f) return false;
    const who = w ? this.label(o, w) : 'O orquestrador';
    const requested = s.state.model || (w ? w.model : undefined);
    // Modo automático do gateway: quem esgotou foi o modelo que ele escolheu (não o "auto"), se o Deck sabe qual é.
    const isAuto = !!requested && /^auto\b/i.test(modelKey(requested));
    const current = isAuto ? (s.state.autoPick?.model ?? requested) : requested;
    if (current && current !== 'default' && !/^auto\b/i.test(modelKey(current))) this.markExhausted(o, current, f);
    const count = w ? (w.failovers = (w.failovers ?? 0) + 1) : (o.orqFailovers = (o.orqFailovers ?? 0) + 1);
    const next = count <= MAX_FAILOVERS ? pickFallbackModel(current, this.hostModels(o), (m) => this.isModelBlocked(o, m)) : undefined;
    const why = f.kind === 'unavailable' ? 'indisponível no gateway' : 'esgotado no gateway';
    if (!next) {
      const reason = count > MAX_FAILOVERS ? `${MAX_FAILOVERS} trocas seguidas sem sucesso` : 'nenhum outro modelo disponível neste servidor';
      this.deps.log(`orquestração ${o.id}: ${w ? w.id : 'orquestrador'}: modelo ${current ?? '(padrão)'} ${why}; ${reason}`);
      if (w) {
        w.error = `modelo ${current ?? '(padrão)'} ${why}: ${f.reason}`;
        this.pushEvent(o, { at: Date.now(), kind: 'model', workerId: w.id, text: `${who}: o modelo ${current ?? '(padrão)'} está ${why} e o Claude Deck não achou outro (${reason}). Escolha outro modelo e crie um worker novo para ${w.taskId}, ou espere e use worker_send.${this.exhaustedLine(o)}` });
      } else {
        // Só uma orquestração em execução vira "Parada": no planejamento ou esperando aprovação o estado fica (uma
        // mensagem do usuário tira de "Parada" para "Executando", e isso pularia a aprovação do plano). O aviso sai igual.
        if (o.status === 'running') o.status = 'stalled';
        this.emit('attention', { id: o.id, sid: s.state.sid, kind: 'stalled' });
      }
      this.changed(o);
      return true;
    }
    this.deps.log(`orquestração ${o.id}: ${w ? w.id : 'orquestrador'}: modelo ${current ?? '(padrão)'} ${why} (${f.reason}); trocando para ${next}`);
    if (w) {
      w.model = next;
      w.error = undefined;
      w.awaitingTurn = true;
    }
    this.changed(o);
    const resume =
      `<orq-update>\nO Claude Deck trocou o modelo desta conversa de ${current ?? '(padrão)'} para ${next}: o anterior está ${why} (${f.reason}). ` +
      `O turno anterior não chegou a rodar. Continue exatamente de onde parou${w ? '' : ' (releia STATE.md/tasks_list se precisar)'}.\n</orq-update>`;
    void (async () => {
      try {
        await s.setModel(next);
        await s.send([{ type: 'text', text: resume }], crypto.randomUUID());
      } catch (e) {
        this.deps.log(`orquestração ${o.id}: trocar o modelo para ${next} falhou: ${(e as Error).message}`);
        if (w) {
          w.awaitingTurn = false;
          w.error = `não consegui trocar o modelo: ${(e as Error).message}`;
          this.pushEvent(o, { at: Date.now(), kind: 'error', workerId: w.id, text: `${who}: o modelo ${current} está ${why} e a troca para ${next} falhou (${(e as Error).message}).` });
        }
        this.changed(o);
      }
    })();
    if (w) {
      // O orquestrador fica sabendo (sem precisar agir): o worker segue sozinho no modelo novo.
      this.pushEvent(o, { at: Date.now(), kind: 'model', workerId: w.id, text: `${who}: o modelo ${current ?? '(padrão)'} está ${why}; o Claude Deck trocou para ${next} e o worker continua sozinho.${this.exhaustedLine(o)}` }, true);
    }
    return true;
  }

  /** Turno do orquestrador terminou: trata modelo esgotado nele; turno bom zera as trocas seguidas. */
  private onOrchestratorResult(o: OrqRec, s: ClaudeSession, msg: any) {
    if (['done', 'cancelled'].includes(o.status)) return;
    if (this.handleModelFailure(o, s, msg)) return;
    if (!msg.is_error && o.orqFailovers) {
      o.orqFailovers = 0;
      this.persistSoon();
    }
  }

  private onSessionMsg(sid: string, msg: any) {
    const s = this.deps.sessions.sessions.get(sid);
    const r = s ? this.byRole(s) : null;
    if (r && !r.w && msg?.type === 'result') this.onOrchestratorResult(r.o, s!, msg);
    if (!r?.w) return;
    const { o, w } = r;
    if (msg?.type === 'user' && msg.isReplay) {
      this.turnText.set(sid, '');
    } else if (msg?.type === 'assistant' && !msg.parent_tool_use_id) {
      const t = (msg.message?.content ?? [])
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim();
      if (t) this.turnText.set(sid, t);
    } else if (msg?.type === 'result') {
      if (typeof msg.total_cost_usd === 'number') w.costUsd = msg.total_cost_usd;
      // Modelo esgotado/indisponível no gateway: o Deck troca e o worker continua (não é fim de turno de verdade).
      if (!w.stopped && !w.closed && this.handleModelFailure(o, s!, msg, w)) {
        const t = this.turnTimers.get(w.sid);
        if (t) clearTimeout(t);
        this.turnTimers.delete(w.sid);
        return;
      }
      if (!msg.is_error) w.failovers = 0;
      const final = typeof msg.result === 'string' && msg.result.trim() ? msg.result : this.turnText.get(sid);
      if (final) w.finalText = final.slice(-20_000);
      if (typeof msg.num_turns === 'number') w.turns = (w.turns ?? 0) + msg.num_turns;
      w.awaitingTurn = false;
      if (msg.is_error && msg.subtype !== 'error_during_execution') w.error = `turno terminou com erro (${msg.subtype ?? 'erro'})`;
      else if (!msg.is_error) w.error = undefined;
      this.scheduleTurnEnd(o, w, !!msg.is_error, msg.subtype);
    } else if (msg?.type === 'deck_event' && msg.event === 'process_ended' && msg.error && w.awaitingTurn) {
      w.awaitingTurn = false;
      w.error = String(msg.error);
      this.pushEvent(o, { at: Date.now(), kind: 'error', workerId: w.id, text: `${this.label(o, w)}: o processo do Claude encerrou (${clip(String(msg.error), 300)}).` });
      this.changed(o);
    }
  }

  private onAttention(st: { sid: string; orq?: SessionOrqRole }, a: { kind: string; tool?: string }) {
    if (st.orq?.role !== 'worker' || a.kind !== 'permission') return;
    const o = this.orqs.get(st.orq.id);
    const w = o?.workers.find((x) => x.sid === st.sid);
    if (!o || !w) return;
    const ask = ANSWER_TOOLS.has(a.tool ?? '');
    // Só para quem está esperando agora (worker_wait): quem não espera vê o estado em worker_status.
    this.pushEvent(
      o,
      {
        at: Date.now(),
        kind: ask ? 'question' : 'permission',
        workerId: w.id,
        text: `${this.label(o, w)} espera ${ask ? 'uma RESPOSTA' : `PERMISSÃO (${a.tool ?? 'ferramenta'})`} do usuário na aba dele. Avise o usuário; você não pode responder por ele.`,
      },
      true,
    );
    this.changed(o);
  }

  /** Fim de turno de um worker: espera um pouco (o CLI pode emendar outro turno) e anuncia ao orquestrador. */
  private scheduleTurnEnd(o: OrqRec, w: WorkerRec, isError: boolean, subtype?: string) {
    const prev = this.turnTimers.get(w.sid);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.turnTimers.delete(w.sid);
      const s = this.deps.sessions.sessions.get(w.sid);
      if (s && s.state.phase === 'running') return;
      if (w.reportUnannounced && w.report) {
        w.reportUnannounced = false;
        this.pushEvent(o, {
          at: Date.now(),
          kind: 'reported',
          workerId: w.id,
          text: `${this.label(o, w)} enviou relatório: ${w.report.status.toUpperCase()} — ${clip(w.report.summary, 700)}${w.report.concerns ? ` | Ressalvas: ${clip(w.report.concerns, 300)}` : ''}`,
        });
      } else if (isError && subtype !== 'error_during_execution') {
        this.pushEvent(o, { at: Date.now(), kind: 'error', workerId: w.id, text: `${this.label(o, w)} terminou o turno com erro (${subtype ?? 'erro'}). Última resposta: ${clip(w.finalText, 300) || '(nenhuma)'}` });
      } else if (!w.stopped) {
        this.pushEvent(o, {
          at: Date.now(),
          kind: 'turn_done',
          workerId: w.id,
          text: `${this.label(o, w)} terminou o turno SEM relatório. Última resposta: "${clip(w.finalText, 400) || '(nenhuma)'}". Peça o relatório (worker_send) ou leia mais (worker_read).`,
        });
      }
      this.changed(o);
    }, Math.max(deliveryDelayMs(), 300));
    timer.unref?.();
    this.turnTimers.set(w.sid, timer);
  }

  // ---------------------------------------------------------------- entrega ao orquestrador

  /**
   * Novo evento: vai primeiro para quem está em worker_wait; senão fica na fila e acorda o orquestrador parado.
   * `transient` (pedido de permissão/pergunta): só interessa a quem espera agora; não fica na fila.
   */
  private pushEvent(o: OrqRec, ev: EventRec, transient = false) {
    o.events.push(ev);
    if (o.events.length > 200) o.events.splice(0, o.events.length - 200);
    if (this.flushWaiters(o)) {
      this.persistSoon();
      return;
    }
    if (transient) {
      o.events = o.events.filter((e) => e !== ev);
      return;
    }
    o.nudges = 0;
    this.persistSoon();
    this.scheduleDelivery(o);
  }

  private take(o: OrqRec, filter: Set<string> | null): EventRec[] {
    const evs = o.events.filter((e) => !filter || filter.has(e.workerId));
    if (evs.length) {
      o.events = o.events.filter((e) => !evs.includes(e));
      this.persistSoon();
    }
    return evs;
  }

  private flushWaiters(o: OrqRec): boolean {
    const set = this.waiters.get(o.id);
    if (!set?.size) return false;
    let any = false;
    for (const w of [...set]) {
      const evs = this.take(o, w.filter);
      if (evs.length) {
        any = true;
        w.resolve(evs);
      }
    }
    return any;
  }

  private scheduleDelivery(o: OrqRec) {
    const prev = this.deliveryTimers.get(o.id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.deliveryTimers.delete(o.id);
      this.deliver(o);
    }, deliveryDelayMs());
    t.unref?.();
    this.deliveryTimers.set(o.id, t);
  }

  /** Orquestrador parado: entrega os eventos pendentes ou, sem eventos, lembra de continuar (até MAX_NUDGES vezes). */
  private deliver(o: OrqRec) {
    if (['paused', 'done', 'cancelled'].includes(o.status)) return;
    const s = this.orchestrator(o);
    if (!s || s.isClosing) return;
    if (s.state.phase !== 'idle' && s.state.phase !== 'dormant') return;
    if (this.waiters.get(o.id)?.size) return;
    // Entre dois turnos (a aprovação ou um aviso já está na fila do CLI): ainda não está parado. Sem isto, um
    // lembrete "nenhum worker trabalhando" saía antes do turno que ia criar os workers e chegava desatualizado.
    if (s.hasQueuedInput) {
      this.scheduleDelivery(o);
      return;
    }
    if (o.events.length) {
      const evs = o.events;
      o.events = [];
      this.persistSoon();
      this.changed(o);
      this.sendUpdate(o, `Atualização do Claude Deck (eventos dos workers):\n${this.formatEvents(evs)}\n\n${this.progressLine(o)}`);
      return;
    }
    this.maybeNudge(o, s);
  }

  private maybeNudge(o: OrqRec, s: ClaudeSession) {
    if (o.status !== 'running') return;
    if (o.workers.some((w) => this.isActive(w))) return; // os eventos deles vão acordá-lo
    const open = o.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    if (o.nudges >= MAX_NUDGES) {
      o.status = 'stalled';
      this.changed(o);
      this.emit('attention', { id: o.id, sid: s.state.sid, kind: 'stalled' });
      this.deps.log(`orquestração ${o.id}: parada depois de ${MAX_NUDGES} lembretes sem progresso`);
      return;
    }
    o.nudges++;
    const n = `${o.nudges}/${MAX_NUDGES}`;
    const waitingOn = (t: TaskRec) => t.deps.filter((d) => o.tasks.find((x) => x.id === d)?.status !== 'done');
    let body: string;
    if (!o.tasks.length)
      body = `Lembrete do Claude Deck (${n}): a orquestração está ativa mas não há tarefas registradas. Registre o plano com tasks_define ou, se precisa do usuário, chame orq_wait_user e pergunte.`;
    else if (!open.length) body = `Lembrete do Claude Deck (${n}): todas as tarefas estão concluídas ou canceladas. Rode a verificação geral e chame orq_finish com o resumo final.`;
    else
      body = `Lembrete do Claude Deck (${n}): a orquestração continua ativa e nenhum worker está trabalhando.\nAbertas: ${open
        .map((t) => `${t.id} (${t.status}${waitingOn(t).length ? `, aguarda ${waitingOn(t).join('+')}` : ''})`)
        .join(', ')}.${this.readyLine(o)}\nContinue: verifique o que reportou, inicie as tarefas prontas (worker_start) ou, se precisa do usuário, chame orq_wait_user e pergunte.`;
    this.changed(o);
    this.sendUpdate(o, body);
  }

  private sendUpdate(o: OrqRec, body: string) {
    const s = this.orchestrator(o);
    if (!s) return;
    s.send([{ type: 'text', text: `<orq-update>\n${body}\n</orq-update>` }], crypto.randomUUID()).catch((e) =>
      this.deps.log(`orquestração ${o.id}: não entreguei atualização: ${(e as Error).message}`),
    );
  }

  /** O usuário escreveu ao orquestrador: volta a valer o acompanhamento automático. */
  onUserMessage(sid: string) {
    for (const o of this.orqs.values()) {
      if (o.orchestratorSid !== sid) continue;
      if (o.status === 'waiting_user' || o.status === 'stalled') o.status = 'running';
      o.waitingReason = undefined;
      o.nudges = 0;
      this.changed(o);
    }
  }

  // ---------------------------------------------------------------- ações do usuário (botões)

  approve(id: string) {
    const o = this.get(id);
    if (o.status !== 'awaiting_approval') throw new DeckError('bad', 'Não há plano esperando aprovação.');
    o.status = 'running';
    o.approvedAt = Date.now();
    o.nudges = 0;
    this.changed(o);
    this.sendUpdate(
      o,
      `O usuário APROVOU o plano pelo botão do Claude Deck. Pode criar os workers (worker_start), respeitando dependências, arquivos e o limite de ${o.settings.maxParallel} simultâneos.`,
    );
  }

  setPaused(id: string, paused: boolean) {
    const o = this.get(id);
    if (paused) {
      if (o.status === 'paused' || o.status === 'done' || o.status === 'cancelled') return;
      o.resumeStatus = o.status;
      o.status = 'paused';
      for (const w of [...(this.waiters.get(o.id) ?? [])]) w.resolve([]);
    } else {
      if (o.status !== 'paused') return;
      const back = o.resumeStatus;
      o.status = !back || back === 'paused' || back === 'stalled' ? 'running' : back;
      o.resumeStatus = undefined;
      o.nudges = 0;
      this.scheduleDelivery(o);
    }
    this.changed(o);
  }

  /** Interrompe todos os workers ativos e pausa a orquestração. */
  async stopWorkers(id: string): Promise<number> {
    const o = this.get(id);
    const active = o.workers.filter((w) => this.isActive(w));
    for (const w of active) {
      w.stopped = true;
      w.awaitingTurn = false;
      await this.deps.sessions.sessions.get(w.sid)?.interrupt().catch(() => {});
    }
    this.setPaused(id, true);
    this.changed(o);
    return active.length;
  }

  async cancel(id: string) {
    const o = this.get(id);
    await this.stopWorkers(id).catch(() => 0);
    o.status = 'cancelled';
    o.resumeStatus = undefined;
    o.events = [];
    this.changed(o);
  }

  /** Abriu uma janela: entrega o que ficou pendente enquanto ninguém olhava. */
  kick(id: string) {
    const o = this.orqs.get(id);
    if (o && (o.events.length || o.status === 'running')) this.scheduleDelivery(o);
  }

  // ---------------------------------------------------------------- textos

  private label(o: OrqRec, w: WorkerRec) {
    const t = o.tasks.find((x) => x.id === w.taskId);
    return `${w.id} (${w.taskId}${t ? ` · ${t.title}` : ''})`;
  }

  private formatEvents(evs: EventRec[]): string {
    return evs.map((e) => `- ${e.text}`).join('\n');
  }

  private progressLine(o: OrqRec): string {
    const done = o.tasks.filter((t) => t.status === 'done').length;
    const active = o.workers.filter((w) => this.isActive(w)).map((w) => `${w.id}:${this.workerState(w)}`);
    return `Progresso: ${done}/${o.tasks.length} tarefas concluídas · workers ativos: ${active.join(', ') || 'nenhum'}.${this.readyLine(o)}`;
  }

  private readyLine(o: OrqRec): string {
    const ready = o.tasks.filter(
      (t) =>
        t.status === 'pending' &&
        t.deps.every((d) => o.tasks.find((x) => x.id === d)?.status === 'done') &&
        !o.workers.some((w) => w.taskId === t.id && this.isActive(w)),
    );
    return ready.length ? ` Prontas para começar: ${ready.map((t) => t.id).join(', ')}.` : '';
  }

  private workerLine(o: OrqRec, w: WorkerRec, detailed = false): string {
    const t = o.tasks.find((x) => x.id === w.taskId);
    const mins = Math.max(0, Math.round((Date.now() - w.startedAt) / 60000));
    const parts = [
      `${w.id} · ${w.taskId}${t ? ` ${t.title}` : ''}`,
      this.workerState(w),
      w.role,
      w.model ? `modelo ${w.model}` : 'modelo padrão',
      `esforço ${w.effort}`,
      `${mins} min`,
      typeof w.costUsd === 'number' ? `US$ ${w.costUsd.toFixed(2)}` : '',
      `relatório: ${w.report ? w.report.status : '—'}`,
    ].filter(Boolean);
    let line = parts.join(' · ');
    if (detailed && w.error) line += `\nErro: ${clip(w.error, 300)}`;
    return line;
  }

  private workersBlock(o: OrqRec): string {
    if (!o.workers.length) return `Nenhum worker criado ainda.${this.exhaustedLine(o)}`;
    return `Workers:\n${o.workers.map((w) => `- ${this.workerLine(o, w)}`).join('\n')}${this.exhaustedLine(o)}`;
  }

  private board(o: OrqRec): string {
    const active = o.workers.filter((w) => this.isActive(w)).length;
    const lines = [
      `Orquestração ${o.id} · estado: ${o.status}${o.waitingReason ? ` (esperando o usuário: ${o.waitingReason})` : ''} · workers ativos: ${active}/${o.settings.maxParallel} · permissão dos workers: ${o.settings.workerPermissionMode} · eventos pendentes: ${o.events.length}`,
      `Pasta de estado: ${o.stateDir}`,
      '',
      o.tasks.length ? 'Tarefas:' : 'Nenhuma tarefa registrada (use tasks_define).',
      ...o.tasks.map((t) => {
        const ws = t.workers.map((id) => {
          const w = o.workers.find((x) => x.id === id);
          return w ? `${id}(${this.workerState(w)}${w.report ? `, ${w.report.status}` : ''})` : id;
        });
        return `- ${t.id} [${t.status}] ${t.title}${t.deps.length ? ` ← ${t.deps.join(', ')}` : ''}${t.files.length ? ` · files: ${t.files.join(', ')}` : ''}${ws.length ? ` · workers: ${ws.join(', ')}` : ''}`;
      }),
    ];
    const ready = this.readyLine(o);
    if (ready) lines.push('', ready.trim());
    const exhausted = this.exhaustedLine(o);
    if (exhausted) lines.push('', exhausted.trim());
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- arquivos

  /** Espelha o quadro em tasks.json na pasta de estado (leitura humana / do orquestrador). */
  private mirrorSoon(o: OrqRec) {
    const prev = this.mirrorTimers.get(o.id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.mirrorTimers.delete(o.id);
      // Não abre conexão SSH só para isto: grava quando o servidor estiver conectado.
      if (o.hostId !== LOCAL_HOST_ID && this.deps.registry.status(o.hostId).state !== 'ready') return;
      const data = {
        id: o.id,
        status: o.status,
        updatedAt: new Date().toISOString(),
        tasks: o.tasks.map((x) => ({ id: x.id, title: x.title, status: x.status, depends_on: x.deps, files: x.files, verify: x.verify, notes: x.notes, evidence: x.evidence, workers: x.workers })),
        workers: o.workers.map((w) => ({
          id: w.id,
          task: w.taskId,
          role: w.role,
          state: this.workerState(w),
          model: w.model,
          effort: w.effort,
          baseCommit: w.baseCommit,
          report: w.report?.status,
          reportPath: w.report?.path,
          briefPath: w.briefPath,
        })),
      };
      const file = join(o.platform, o.stateDir, 'tasks.json');
      this.host(o.hostId)
        .then((h) => h.fs.write(file, Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8')))
        .catch((e) => this.deps.log(`orquestração ${o.id}: tasks.json não gravado: ${(e as Error).message}`));
    }, 800);
    t.unref?.();
    this.mirrorTimers.set(o.id, t);
  }

  private async gitHead(o: OrqRec): Promise<string | undefined> {
    try {
      if (o.hostId === LOCAL_HOST_ID) {
        return await new Promise((resolve) =>
          execFile('git', ['-C', o.cwd, 'rev-parse', 'HEAD'], { timeout: 10_000, windowsHide: true }, (err, out) => {
            const h = String(out ?? '').trim();
            resolve(!err && /^[0-9a-f]{40}$/.test(h) ? h : undefined);
          }),
        );
      }
      const h = await this.host(o.hostId);
      if (!h.ssh) return undefined;
      const r = await h.ssh.run(`cd ${shq(o.cwd)} 2>/dev/null && git rev-parse HEAD 2>/dev/null`, { timeoutMs: 10_000 });
      const head = r.stdout.trim();
      return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
    } catch {
      return undefined;
    }
  }
}
