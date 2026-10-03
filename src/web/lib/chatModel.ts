// Modelo de uma conversa: transforma as mensagens do Claude Code (stream-json ao vivo e linhas
// do transcript) numa lista de itens para a tela. Puro (sem DOM), testado à parte.
import { markCacheCompacted, recordCacheFrame, type PromptCacheRecord } from './promptCache';
import { EMPTY_CONTEXT, isCompactCommand, usedTokensOf, windowFromModelUsage, type AutoCompactInfo, type ContextUsageState } from './contextUsage';

export type ToolStatus = 'running' | 'done' | 'error' | 'denied' | 'interrupted';

export interface ImageData {
  mediaType: string;
  data: string;
}

export interface PermissionReq {
  requestId: string;
  toolName: string;
  input: any;
  suggestions?: any[];
  reason?: string;
  reasonType?: string;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  suppressAlways?: boolean;
  defaultToNo?: boolean;
  status: 'pending' | 'allowed' | 'denied' | 'cancelled';
  answer?: string;
}

export interface ToolResultData {
  text: string;
  images: ImageData[];
  isError: boolean;
  structured?: any;
}

export interface TaskNotificationData {
  taskId?: string;
  toolUseId?: string;
  status?: string;
  summary?: string;
  result?: string;
}

/** Mensagem que outro agente (subagente, colega de equipe, outra sessão do Claude) mandou para esta conversa. */
export interface AgentMessageData {
  /** `agent` = subagente/colega desta sessão (<agent-message>); `session` = outra sessão do Claude (<cross-session-message>). */
  kind?: 'agent' | 'session';
  /** Id do agente que enviou (atributo `from`). */
  from?: string;
  /** Nome legível do remetente, quando o CLI informa (`origin.name`: "Explore", "smart-ia-06"). */
  name?: string;
  body: string;
}

/** `auto` = mensagem sintética do Claude Code sem categoria própria (aviso interno, metadado de imagem...). */
export type UserSource = 'user' | 'skill' | 'hook' | 'task' | 'agent' | 'auto';

export interface UserItem {
  kind: 'user';
  key: string;
  uuid?: string;
  text: string;
  images: ImageData[];
  pending?: boolean;
  failed?: string;
  /** Data/hora do envio (ms). Enviada por esta janela: o momento do clique; do transcript/eco do CLI: o `timestamp` dele. */
  at?: number;
  /** Quem produziu a mensagem. Só `user` (ou ausente) é algo que o usuário digitou; o resto é automático. */
  source?: UserSource;
  skillName?: string;
  taskNotification?: TaskNotificationData;
  agentMessages?: AgentMessageData[];
}
export interface TextItem {
  kind: 'text';
  key: string;
  text: string;
  streaming?: boolean;
}
export interface ThinkingItem {
  kind: 'thinking';
  key: string;
  text: string;
  streaming?: boolean;
  redacted?: boolean;
}
export interface ToolItem {
  kind: 'tool';
  key: string;
  id: string;
  name: string;
  input: any;
  inputJson?: string;
  streaming?: boolean;
  status: ToolStatus;
  result?: ToolResultData;
  permission?: PermissionReq;
  children: Item[];
  parentId?: string;
  /**
   * Chegou pelo fluxo ao vivo deste processo do Claude (não só pelo transcript). Um subagente em segundo
   * plano que só aparece no transcript pode ter morrido com um processo antigo: não conta como em execução.
   */
  live?: boolean;
  /** Quando a chamada foi feita (ms), se o transcript informa. */
  at?: number;
  /** Modelo que o primeiro retorno do próprio subagente confirmou. */
  agentModel?: string;
}
/** Um subagente em execução (ferramenta Agent/Task, em primeiro ou segundo plano). */
export interface AgentRun {
  /** `tool_use_id` da chamada (ou o id da tarefa, quando o CLI não informa a chamada). */
  id: string;
  /** Nome legível da tarefa que o agente recebeu. */
  description: string;
  /** Tipo do subagente (`Explore`, `general-purpose`…). */
  type?: string;
  /** Modelo realmente resolvido para o subagente. Enquanto não há resposta dele, fica indefinido. */
  model?: string;
  /** Se o subagente trocou de modelo durante a tarefa, lista todos os que já usou. */
  models?: string[];
  /** Pedido completo delegado ao subagente (não inclui instruções internas/sistema do Claude Code). */
  prompt?: string;
  background: boolean;
  /** Identificador que o CLI aceita no controle `stop_task` (não confundir com `tool_use_id`). */
  taskId?: string;
  /** Identificador do arquivo `subagents/agent-<id>.jsonl`, quando informado pelo CLI. */
  agentId?: string;
  status?: 'working' | 'completed' | 'failed' | 'killed';
  kind?: 'agent' | 'task';
  /** Horário informado no evento de fim (ou o recebimento ao vivo). */
  finishedAt?: number;
}
/** Tokens de um turno (ou da sessão): entrada nova, entrada lida do cache, entrada gravada no cache e saída. */
export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
}
export interface ResultItem {
  kind: 'result';
  key: string;
  subtype: string;
  isError: boolean;
  durationMs?: number;
  costUsd?: number;
  numTurns?: number;
  errors?: string[];
  /** Deste turno (o `usage` do resultado vale só para o turno). */
  tokens?: TokenUsage;
  /** Da sessão inteira (soma do `modelUsage`, que é acumulado). */
  sessionTokens?: TokenUsage;
}
export interface NoticeItem {
  kind: 'notice';
  key: string;
  tone: 'info' | 'warn' | 'error';
  text: string;
}
export interface CompactItem {
  kind: 'compact';
  key: string;
  summary?: string;
}

export type Item = UserItem | TextItem | ThinkingItem | ToolItem | ResultItem | NoticeItem | CompactItem;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function totalInput(t: TokenUsage): number {
  return t.input + t.cacheRead + t.cacheCreate;
}

/** Diferença entre totais consecutivos que estão visíveis nesta conversa; não é preço calculado dos tokens. */
export function costIncreases(items: Item[]): Map<string, number> {
  const increases = new Map<string, number>();
  let previous: number | undefined;
  for (const item of items) {
    if (item.kind !== 'result') continue;
    const current = item.costUsd;
    if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) {
      previous = undefined;
      continue;
    }
    if (previous !== undefined && current > previous) increases.set(item.key, current - previous);
    previous = current;
  }
  return increases;
}

/** `usage` do resultado do CLI (snake_case). Sem nenhum token informado → undefined. */
export function tokensFromUsage(u: any): TokenUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const t = { input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens), cacheCreate: num(u.cache_creation_input_tokens), output: num(u.output_tokens) };
  return totalInput(t) + t.output > 0 ? t : undefined;
}

/** Soma do `modelUsage` (camelCase, acumulado da sessão, um item por modelo). */
export function tokensFromModelUsage(mu: any): TokenUsage | undefined {
  if (!mu || typeof mu !== 'object') return undefined;
  const t: TokenUsage = { input: 0, cacheRead: 0, cacheCreate: 0, output: 0 };
  for (const m of Object.values(mu) as any[]) {
    t.input += num(m?.inputTokens);
    t.cacheRead += num(m?.cacheReadInputTokens);
    t.cacheCreate += num(m?.cacheCreationInputTokens);
    t.output += num(m?.outputTokens);
  }
  return totalInput(t) + t.output > 0 ? t : undefined;
}

export type TextRole = 'plain' | 'step' | 'final';

/** A partir deste tamanho um texto no meio do trabalho já é conteúdo para o usuário, não um "vou ler X". */
const SUBSTANTIAL_TEXT_CHARS = 400;
/** Texto menor que isto nunca é promovido, mesmo com listas/títulos. */
const STRUCTURED_TEXT_MIN_CHARS = 160;
const MARKDOWN_STRUCTURE_LINE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```)/;

/**
 * Texto do Claude que tem substância (diagnóstico, relatório, pergunta ao usuário) e não pode ficar
 * escondido na cadeia recolhida só porque uma ferramenta veio depois dele — por exemplo, a resposta
 * seguida de uma ferramenta de registro/log e de um fecho curto. Comentário de passo é curto
 * ("Vou ler o arquivo"); texto longo, ou médio com lista/título/tabela/código, é resposta.
 */
export function isSubstantialText(text: string): boolean {
  const t = text.trim();
  if (t.length >= SUBSTANTIAL_TEXT_CHARS) return true;
  if (t.length < STRUCTURED_TEXT_MIN_CHARS) return false;
  return t.split('\n').filter((l) => MARKDOWN_STRUCTURE_LINE.test(l)).length >= 3;
}

/**
 * Papel de cada texto do Claude dentro do turno (entre uma mensagem do usuário e o resultado):
 * - `step`: comentário curto no meio do trabalho (vem antes de alguma ferramenta ou raciocínio);
 * - `final`: o que vem depois da última ferramenta/raciocínio — a resposta;
 * - `plain`: texto normal, sem destaque — turno sem ferramenta nem raciocínio (só uma resposta) ou
 *   texto com substância (`isSubstantialText`) que veio antes de alguma ferramenta: fica fora da
 *   cadeia recolhida e visível, mas sem o rótulo "Resposta", que é só do que fecha o turno.
 * Só olha o nível de cima: o que roda dentro de uma ferramenta (subagente) fica com ela.
 */
export function textRoles(items: Item[]): Map<string, TextRole> {
  const roles = new Map<string, TextRole>();
  const isWork = (it: Item) => it.kind === 'tool' || (it.kind === 'thinking' && (it.redacted || it.streaming || it.text.trim().length > 0));
  let start = 0;
  const flush = (end: number) => {
    let lastWork = -1;
    for (let i = start; i < end; i++) if (isWork(items[i])) lastWork = i;
    for (let i = start; i < end; i++) {
      const it = items[i];
      if (it.kind !== 'text') continue;
      roles.set(it.key, lastWork < 0 ? 'plain' : i > lastWork ? 'final' : isSubstantialText(it.text) ? 'plain' : 'step');
    }
  };
  items.forEach((it, i) => {
    if (it.kind === 'user' || it.kind === 'result') {
      flush(i);
      start = i + 1;
    }
  });
  flush(items.length);
  return roles;
}

export type RenderBlock = Item | { kind: 'workgroup'; key: string; items: Item[] };

/**
 * Cartão esperando resposta sua (pergunta, permissão, plano) — na própria ferramenta ou, no caso
 * de um subagente, em alguma ferramenta dentro dela.
 */
export function awaitsUser(it: Item): boolean {
  return it.kind === 'tool' && (it.permission?.status === 'pending' || it.children.some(awaitsUser));
}

/**
 * Agrupa cadeias de raciocínio e execuções de ferramentas de cada turno em um bloco recolhível.
 * Se só houver 1 item isolado (ex. 1 ferramenta simples ou 1 raciocínio único), mantém direto sem encapsular.
 * Quando há múltiplos passos (pensamentos + ferramentas + comentários de passo), agrupa tudo numa única cadeia minimizada.
 * Exceção: o que espera resposta sua (`awaitsUser`) nunca entra no bloco recolhido — vira um bloco
 * solto, sempre visível, e só volta para a cadeia depois de respondido.
 */
export function groupChatItems(items: Item[], roles: Map<string, TextRole>): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let currentGroup: Item[] = [];

  const flushGroup = () => {
    if (!currentGroup.length) return;
    if (currentGroup.length === 1) {
      blocks.push(currentGroup[0]);
    } else {
      blocks.push({
        kind: 'workgroup',
        key: `work:${currentGroup[0].key}`,
        items: currentGroup,
      });
    }
    currentGroup = [];
  };

  for (const it of items) {
    if (awaitsUser(it)) {
      flushGroup();
      blocks.push(it);
      continue;
    }
    const isStepText = it.kind === 'text' && roles.get(it.key) === 'step';
    const isAutoUser = it.kind === 'user' && (it.source === 'task' || it.source === 'skill' || it.source === 'hook' || it.source === 'auto');
    const isWork = it.kind === 'tool' || it.kind === 'thinking' || isStepText || isAutoUser;

    if (isWork) {
      currentGroup.push(it);
    } else {
      flushGroup();
      blocks.push(it);
    }
  }
  flushGroup();
  return blocks;
}

const CONTEXT_TAGS =
  /<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|local-command-stdout|local-command-stderr|command-message|command-args|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;

/** Texto visível de uma mensagem do usuário (sem tags de contexto). */
export function visibleUserText(content: any): { text: string; images: ImageData[]; command?: string } {
  let raw = '';
  const images: ImageData[] = [];
  if (typeof content === 'string') raw = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text') raw += (raw ? '\n' : '') + b.text;
      else if (b?.type === 'image' && b.source?.type === 'base64') images.push({ mediaType: b.source.media_type, data: b.source.data });
    }
  }
  let command: string | undefined;
  const cm = raw.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cm) {
    command = cm[1].trim();
    const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    raw = command + (args ? ' ' + args : '');
  } else raw = raw.replace(CONTEXT_TAGS, '');
  return { text: raw.trim(), images, command };
}

export function flattenToolResult(content: any): { text: string; images: ImageData[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const images: ImageData[] = [];
  let text = '';
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text') text += (text ? '\n' : '') + b.text;
      else if (b?.type === 'image' && b.source?.type === 'base64') images.push({ mediaType: b.source.media_type, data: b.source.data });
      else if (b?.type === 'tool_reference') text += (text ? '\n' : '') + `[ferramenta: ${b.tool_name ?? ''}]`;
    }
  }
  return { text, images };
}

/** Lê os dados de notificação de um subagente/tarefa concluída (<task-notification>). */
export function parseTaskNotification(raw: string): TaskNotificationData | null {
  const m = raw.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (!m) return null;
  const inside = m[1];
  const tag = (name: string) => inside.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1]?.trim();
  return {
    taskId: tag('task-id'),
    toolUseId: tag('tool-use-id'),
    status: tag('status'),
    summary: tag('summary'),
    result: tag('result'),
  };
}

const AGENT_MESSAGE_RE = /<(agent-message|cross-session-message)\b([^>]*)>([\s\S]*?)<\/\1>/g;
/** Frase que o CLI põe antes da tag quando a mensagem chega no meio do trabalho. */
const AGENT_PREFIX_RE = /^\s*Another Claude session sent a message(?: while you were working)?:\s*/i;

/**
 * Lê `<agent-message from="…">…</agent-message>` e `<cross-session-message from="…">…</cross-session-message>`
 * (mensagem de outro agente ou de outra sessão para esta conversa), com ou sem a frase "Another Claude session
 * sent a message:" antes. Só vale quando a mensagem INTEIRA é isso: se sobrar texto fora das tags (alguém colou
 * o exemplo numa pergunta, por exemplo), continua sendo texto do usuário e aparece como foi escrito.
 * `origin` é o campo que o CLI manda junto (nome legível do remetente).
 */
export function parseAgentMessages(raw: string, origin?: any): AgentMessageData[] | null {
  if (!raw.includes('<agent-message') && !raw.includes('<cross-session-message')) return null;
  const out: AgentMessageData[] = [];
  for (const m of raw.matchAll(AGENT_MESSAGE_RE)) {
    const from = m[2].match(/\bfrom="([^"]*)"/)?.[1] || undefined;
    const name = origin?.kind === 'peer' && typeof origin.name === 'string' && (!origin.from || origin.from === from) ? origin.name : undefined;
    out.push({ kind: m[1] === 'cross-session-message' ? 'session' : 'agent', from, name, body: m[3].trim() });
  }
  if (!out.length) return null;
  if (raw.replace(AGENT_PREFIX_RE, '').replace(AGENT_MESSAGE_RE, '').trim()) return null;
  return out;
}

/** Resumo que o /compact (ou a compactação automática) põe no lugar da conversa antiga. */
const COMPACT_SUMMARY_RE = /^\s*This session is being continued from a previous conversation/;
export function isCompactSummaryText(text: string): boolean {
  return COMPACT_SUMMARY_RE.test(text);
}

/** `timestamp` (ISO) do transcript / eco do CLI, em ms; ausente ou inválido → undefined. */
export function msgTime(msg: any): number | undefined {
  const t = typeof msg?.timestamp === 'string' ? Date.parse(msg.timestamp) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** Data e hora do envio sob a mensagem: "30/09 às 14:32" (com o ano se não for o atual). Hora local. */
export function formatSentAt(at: number, now = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${p(d.getDate())}/${p(d.getMonth() + 1)}${d.getFullYear() !== new Date(now).getFullYear() ? `/${d.getFullYear()}` : ''}`;
  return `${date} às ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Tenta ler JSON incompleto (entrada de ferramenta ainda chegando). */
export function parsePartialJson(s: string): any {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    /* completa abaixo */
  }
  // Fecha string/objetos/arrays abertos.
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let fixed = s;
  if (esc) fixed = fixed.slice(0, -1);
  if (inStr) fixed += '"';
  fixed = fixed.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
  fixed += stack.reverse().join('');
  try {
    return JSON.parse(fixed);
  } catch {
    return {};
  }
}

const REJECT_RE = /doesn't want to proceed|was rejected|user denied|Permission to use .* (was )?denied|negad/i;

export const isAgentTool = (t: ToolItem) => t.name === 'Agent' || t.name === 'Task';

/** A chamada do subagente já voltou com "lançado em segundo plano": ele segue rodando até a notificação de fim. */
export function launchedInBackground(t: ToolItem): boolean {
  if (!isAgentTool(t)) return false;
  const r = t.result?.structured;
  return r?.status === 'async_launched' || r?.isAsync === true || (t.input?.run_in_background === true && !!t.result && !t.result.isError);
}

export class ChatModel {
  items: Item[] = [];
  tools = new Map<string, ToolItem>();
  private byKey = new Map<string, Item>();
  private streamOrder = new Map<string, string[]>(); // msgId -> chaves dos blocos em ordem
  private finalized = new Map<string, number>(); // msgId -> blocos já finalizados
  private seenAssistant = new Set<string>();
  private seenUuids = new Set<string>();
  private currentMsgId: string | null = null;
  private skipStream = false;
  private turn = 0;
  private noticeSeq = 0;
  status: string | null = null;
  running = false;
  pendingPermissions = new Map<string, ToolItem>();
  /** Tarefas de subagente anunciadas pelo CLI (`task_started`) e ainda sem aviso de fim. */
  private agentTasks = new Map<string, { taskId: string; toolUseId?: string; description: string; type?: string; prompt?: string; background: boolean; kind: 'agent' | 'task' }>();
  /** `task_id` e `tool_use_id` de tarefas que já terminaram (notificação de fim, ao vivo ou no transcript). */
  private endedTasks = new Set<string>();
  /** Cartões recentes do mapa, com estados após terminar (limite para não acumular durante sessões longas). */
  private recentTasks = new Map<string, AgentRun>();
  /** A mensagem em aplicação vem do transcript (histórico), não do fluxo ao vivo. */
  private inHistory = false;
  lastResult?: ResultItem;
  todos: any[] | null = null;
  /** Aumenta a cada mudança (a tela observa). */
  version = 0;
  /** Última chamada ao modelo (agente principal) que usou o cache de prompt: base do contador (`promptCache.ts`). */
  promptCache?: PromptCacheRecord;
  /** Horário do último pedido enviado ao modelo (mensagem do usuário ou resultado de ferramenta). */
  private promptCacheRequestAt?: number;
  /** Uso do contexto (pizza ao lado do modelo, `contextUsage.ts`). A janela só chega no resultado de um turno. */
  contextUsage: ContextUsageState = EMPTY_CONTEXT;
  /** Modelo anunciado no `init` do CLI e modelo da última mensagem do agente principal: servem para achar a janela no `modelUsage`. */
  private initModel?: string;
  private lastMainModel?: string;
  /** Último `/compact` enviado por esta interface e o turno em que o Claude começou a executá-lo (eco do CLI). */
  private compactUuid?: string;
  private compactStartedTurn?: number;

  /**
   * Situação do último `/compact` enviado daqui: `queued` = enviado e o Claude ainda não começou (na fila dele, atrás do
   * turno em andamento); `started` = o Claude começou e o turno ainda não acabou; `null` = nada pendente (ou falhou).
   */
  compactState(): 'queued' | 'started' | null {
    if (!this.compactUuid) return null;
    const it = this.byKey.get(`user:${this.compactUuid}`) as UserItem | undefined;
    if (!it || it.failed) return null;
    if (it.pending) return 'queued';
    return this.compactStartedTurn === this.turn ? 'started' : null;
  }

  private add(item: Item, into?: Item[]) {
    (into ?? this.items).push(item);
    this.byKey.set(item.key, item);
    return item;
  }

  notice(tone: NoticeItem['tone'], text: string, key?: string) {
    const k = key ?? `notice:${++this.noticeSeq}`;
    const existing = this.byKey.get(k) as NoticeItem | undefined;
    if (existing) {
      existing.text = text;
      existing.tone = tone;
    } else this.add({ kind: 'notice', key: k, tone, text });
    this.version++;
  }

  /** Mensagem enviada pela interface (aparece na hora, confirmada pelo eco do CLI). */
  addPendingUser(uuid: string, text: string, images: ImageData[], at = Date.now()) {
    this.add({ kind: 'user', key: `user:${uuid}`, uuid, text, images, pending: true, at });
    this.seenUuids.add(uuid);
    if (isCompactCommand(text)) {
      this.compactUuid = uuid;
      this.compactStartedTurn = undefined;
    }
    this.noteCacheRequest(at);
    this.running = true;
    this.version++;
  }

  failPendingUser(uuid: string, error: string) {
    const it = this.byKey.get(`user:${uuid}`) as UserItem | undefined;
    if (it) {
      it.pending = false;
      it.failed = error;
      this.version++;
    }
    this.running = false;
  }

  private newTool(id: string, name: string, input: any, parentId?: string): ToolItem {
    const t: ToolItem = { kind: 'tool', key: `tool:${id}`, id, name, input, status: 'running', children: [], parentId, live: !this.inHistory };
    this.tools.set(id, t);
    return t;
  }

  private endTurnTools(interrupted: boolean) {
    for (const t of this.tools.values()) {
      if (t.status === 'running' && !t.result) {
        t.status = interrupted ? 'interrupted' : 'done';
        const task = [...this.agentTasks.values()].find((a) => a.toolUseId === t.id);
        if (isAgentTool(t) && !task?.background) this.finishTask(task?.taskId, t.id, interrupted ? 'killed' : 'completed');
      }
      if (t.streaming) t.streaming = false;
      if (t.permission?.status === 'pending') t.permission.status = 'cancelled';
    }
    this.pendingPermissions.clear();
    for (const it of this.items) if ((it.kind === 'text' || it.kind === 'thinking') && it.streaming) it.streaming = false;
  }

  /** Compactação automática informada pelo Claude da conversa (`get_context_usage`); `undefined` apaga o que se sabia. */
  setAutoCompact(info: AutoCompactInfo | undefined) {
    this.contextUsage = { ...this.contextUsage, autoCompact: info };
    this.version++;
  }

  private noteCacheRequest(at: number | undefined) {
    if (at !== undefined) this.promptCacheRequestAt = Math.max(this.promptCacheRequestAt ?? at, at);
  }

  private recordCache(messageId: string | undefined, usage: any, t: { receivedAt?: number; timestamp?: number }) {
    // Sem horário nenhum (replay do buffer do servidor, que não diz quando chegou) não dá para contar:
    // melhor deixar o registro como está do que inventar "agora".
    if (t.receivedAt === undefined && t.timestamp === undefined && this.promptCacheRequestAt === undefined) return;
    const next = recordCacheFrame(this.promptCache, { messageId, ...t, requestAt: this.promptCacheRequestAt, usage });
    if (next === this.promptCache) return;
    if (next?.messageId !== this.promptCache?.messageId) this.promptCacheRequestAt = undefined;
    this.promptCache = next;
  }

  /**
   * Alimenta o contador do cache de prompt. Só o agente principal conta (subagente tem cache próprio).
   * Ao vivo vale a hora em que a tela recebeu; transcript e replay usam o `timestamp` da própria mensagem.
   */
  private trackPromptCache(msg: any, opts: { history?: boolean; replay?: boolean }) {
    if (msg.parent_tool_use_id) return;
    const t = { receivedAt: opts.history || opts.replay ? undefined : Date.now(), timestamp: msgTime(msg) };
    switch (msg.type) {
      case 'user':
        this.noteCacheRequest(t.receivedAt ?? t.timestamp);
        if (msg.isCompactSummary === true && t.timestamp !== undefined) this.promptCache = markCacheCompacted(this.promptCache, t.timestamp);
        return;
      case 'assistant':
        if (msg.message?.usage && msg.message.model !== '<synthetic>') this.recordCache(msg.message.id, msg.message.usage, t);
        return;
      case 'stream_event':
        if (msg.event?.type === 'message_start' && msg.event.message?.usage && msg.event.message.model !== '<synthetic>') this.recordCache(msg.event.message.id, msg.event.message.usage, t);
        return;
      case 'system': {
        const at = t.receivedAt ?? t.timestamp;
        if (msg.subtype === 'compact_boundary' && at !== undefined) this.promptCache = markCacheCompacted(this.promptCache, at);
        return;
      }
    }
  }

  /**
   * Aplica uma mensagem (ao vivo ou do transcript).
   * `history`: linha do transcript. `replay`: mensagem do buffer do servidor entregue de novo (snapshot/ressincronização),
   * que não é "de agora" — só o contador do cache se importa com a diferença.
   */
  apply(msg: any, opts: { history?: boolean; replay?: boolean } = {}) {
    if (!msg || typeof msg !== 'object') return;
    this.version++;
    this.inHistory = !!opts.history;
    this.trackPromptCache(msg, opts);
    const uuid: string | undefined = msg.uuid;
    switch (msg.type) {
      case 'stream_event':
        if (!msg.parent_tool_use_id) this.onStream(msg.event);
        return;
      case 'assistant':
        if (uuid && this.seenUuids.has(uuid)) {
          // Já veio pelo transcript e agora chega de novo pelo fluxo ao vivo (recarregou a janela): nada a
          // desenhar, mas as ferramentas dela passam a valer como deste processo.
          if (!this.inHistory && Array.isArray(msg.message?.content))
            for (const b of msg.message.content) if (b?.type === 'tool_use') {
              const t = this.tools.get(b.id);
              if (t) t.live = true;
            }
          return;
        }
        if (uuid) this.seenUuids.add(uuid);
        this.onAssistant(msg, opts);
        return;
      case 'user':
        this.onUser(msg, opts);
        return;
      case 'result':
        this.onResult(msg);
        return;
      case 'system':
        this.onSystem(msg, opts);
        return;
      case 'control_request':
        if (msg.request?.subtype === 'can_use_tool') this.onPermission(msg.request_id, msg.request);
        return;
      case 'control_cancel_request': {
        const t = this.pendingPermissions.get(msg.request_id);
        if (t?.permission) t.permission.status = 'cancelled';
        this.pendingPermissions.delete(msg.request_id);
        return;
      }
      case 'deck_event':
        this.onDeckEvent(msg);
        return;
      case 'rate_limit_event': {
        const info = msg.rate_limit_info ?? {};
        if (info.status === 'rejected') {
          const when = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '';
          this.notice('warn', `Limite de uso atingido${when ? ` — libera em ${when}` : ''}.`, 'ratelimit');
        }
        return;
      }
      case 'summary':
      case 'ai-title':
      case 'custom-title':
        return;
      default:
        return;
    }
  }

  private onStream(ev: any) {
    if (!ev) return;
    switch (ev.type) {
      case 'message_start': {
        const id = ev.message?.id ?? null;
        this.currentMsgId = id;
        // Reidratação: a mensagem já veio completa do transcript; ignora o streaming dela.
        this.skipStream = !!id && this.seenAssistant.has(id);
        this.running = true;
        this.status = null;
        return;
      }
      case 'content_block_start': {
        if (this.skipStream || !this.currentMsgId) return;
        const key = `${this.currentMsgId}:${ev.index}`;
        if (this.byKey.has(key)) return;
        const cb = ev.content_block ?? {};
        let item: Item | null = null;
        if (cb.type === 'text') item = { kind: 'text', key, text: cb.text ?? '', streaming: true };
        else if (cb.type === 'thinking') item = { kind: 'thinking', key, text: cb.thinking ?? '', streaming: true };
        else if (cb.type === 'redacted_thinking') item = { kind: 'thinking', key, text: '', redacted: true, streaming: true };
        else if (cb.type === 'tool_use' || cb.type === 'server_tool_use' || cb.type === 'mcp_tool_use') {
          if (this.tools.has(cb.id)) return;
          const t = this.newTool(cb.id, cb.name, cb.input && Object.keys(cb.input).length ? cb.input : {});
          t.inputJson = '';
          t.streaming = true;
          item = t;
          this.byKey.set(key, t);
        }
        if (!item) return;
        if (item.kind !== 'tool') this.add(item);
        else this.add(item);
        const order = this.streamOrder.get(this.currentMsgId) ?? [];
        order.push(key);
        this.streamOrder.set(this.currentMsgId, order);
        return;
      }
      case 'content_block_delta': {
        if (this.skipStream || !this.currentMsgId) return;
        const it = this.byKey.get(`${this.currentMsgId}:${ev.index}`);
        if (!it) return;
        const d = ev.delta ?? {};
        if (d.type === 'text_delta' && it.kind === 'text') it.text += d.text ?? '';
        else if (d.type === 'thinking_delta' && it.kind === 'thinking') it.text += d.thinking ?? '';
        else if (d.type === 'input_json_delta' && it.kind === 'tool') {
          it.inputJson = (it.inputJson ?? '') + (d.partial_json ?? '');
          if (it.inputJson.length < 200_000) it.input = parsePartialJson(it.inputJson);
        }
        return;
      }
      case 'content_block_stop': {
        if (this.skipStream || !this.currentMsgId) return;
        const it = this.byKey.get(`${this.currentMsgId}:${ev.index}`);
        if (!it) return;
        if (it.kind === 'tool') {
          if (it.inputJson) it.input = parsePartialJson(it.inputJson);
          it.streaming = false;
        } else if (it.kind === 'text' || it.kind === 'thinking') it.streaming = false;
        return;
      }
      default:
        return;
    }
  }

  private onAssistant(msg: any, opts: { history?: boolean }) {
    const m = msg.message ?? {};
    const blocks: any[] = Array.isArray(m.content) ? m.content : [];
    const parentId: string | undefined = msg.parent_tool_use_id ?? undefined;
    if (msg.error && !blocks.length) {
      this.notice('error', `Erro do Claude: ${typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)}`);
      return;
    }
    if (!opts.history) this.running = true;
    // Mensagens de subagente vão para dentro da ferramenta que o criou.
    if (parentId) {
      const parent = this.tools.get(parentId);
      if (!parent) return;
      // O primeiro retorno do filho é a fonte autoritativa do modelo de agente em primeiro plano.
      // Nunca usar o modelo da mensagem pai: ele pode ser outro modelo.
      if (isAgentTool(parent) && typeof m.model === 'string' && m.model) parent.agentModel ??= m.model;
      for (const b of blocks) {
        if (b.type === 'text' && b.text?.trim()) parent.children.push({ kind: 'text', key: `${m.id}:${parent.children.length}`, text: b.text });
        else if (b.type === 'tool_use') {
          const known = this.tools.get(b.id);
          if (known) {
            if (!this.inHistory) known.live = true; // o transcript já a trouxe; agora chegou ao vivo também
            continue;
          }
          const t = this.newTool(b.id, b.name, b.input ?? {}, parentId);
          parent.children.push(t);
        }
      }
      return;
    }
    // Contexto: o que a última chamada do agente principal leu e escreveu. Sintética e sem tokens não contam
    // (não mudaram o contexto); só roda para mensagem nova (a repetida por replay volta antes, em `apply`).
    if (m.model !== '<synthetic>') {
      if (typeof m.model === 'string' && m.model) this.lastMainModel = m.model;
      const used = usedTokensOf(m.usage);
      if (used > 0) this.contextUsage = { ...this.contextUsage, usedTokens: used };
    }
    const msgId: string = m.id ?? `m${Math.random()}`;
    this.seenAssistant.add(msgId);
    for (const b of blocks) {
      if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
        const existing = this.tools.get(b.id);
        if (existing) {
          if (!this.inHistory) existing.live = true;
          existing.at ??= msgTime(msg);
          existing.input = b.input ?? existing.input;
          existing.streaming = false;
          existing.inputJson = undefined;
          this.bumpFinalized(msgId, existing.key);
          if (existing.name === 'TodoWrite') this.todos = existing.input?.todos ?? this.todos;
          if (existing.name === 'TaskStop' || existing.name === 'KillShell' || existing.name === 'TaskKill') {
            const targetId = existing.input?.task_id || existing.input?.shell_id;
            if (targetId) this.finishTask(String(targetId), undefined, 'killed');
          }
          continue;
        }
        const t = this.newTool(b.id, b.name, b.input ?? {});
        t.at = msgTime(msg);
        this.add(t);
        if (t.name === 'TodoWrite') this.todos = t.input?.todos ?? this.todos;
        if (t.name === 'TaskStop' || t.name === 'KillShell' || t.name === 'TaskKill') {
          const targetId = t.input?.task_id || t.input?.shell_id;
          if (targetId) this.finishTask(String(targetId), undefined, 'killed');
        }
        continue;
      }
      if (b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking') {
        const kind = b.type === 'text' ? 'text' : 'thinking';
        const target = this.nextStreamed(msgId, kind);
        const text = b.type === 'text' ? (b.text ?? '') : b.type === 'thinking' ? (b.thinking ?? '') : '';
        if (target && (target.kind === 'text' || target.kind === 'thinking')) {
          target.text = text || target.text;
          target.streaming = false;
          if (b.type === 'redacted_thinking' && target.kind === 'thinking') target.redacted = true;
          continue;
        }
        if (kind === 'text' && !text.trim()) continue;
        const key = `${msgId}:f${this.items.length}`;
        if (kind === 'text') this.add({ kind: 'text', key, text });
        else this.add({ kind: 'thinking', key, text, redacted: b.type === 'redacted_thinking' });
      }
    }
  }

  /** Próximo bloco transmitido (ainda não finalizado) desta mensagem com o tipo pedido. */
  private nextStreamed(msgId: string, kind: 'text' | 'thinking'): Item | null {
    const order = this.streamOrder.get(msgId);
    if (!order) return null;
    let i = this.finalized.get(msgId) ?? 0;
    while (i < order.length) {
      const it = this.byKey.get(order[i]);
      i++;
      if (!it) continue;
      if (it.kind === 'tool') continue;
      if (it.kind === kind) {
        this.finalized.set(msgId, i);
        return it;
      }
    }
    return null;
  }

  private bumpFinalized(msgId: string, key: string) {
    const order = this.streamOrder.get(msgId);
    if (!order) return;
    const idx = order.indexOf(key);
    if (idx >= 0 && (this.finalized.get(msgId) ?? 0) <= idx) this.finalized.set(msgId, idx + 1);
  }

  private onUser(msg: any, opts: { history?: boolean }) {
    const uuid: string | undefined = msg.uuid;
    if (uuid) {
      const pending = this.byKey.get(`user:${uuid}`) as UserItem | undefined;
      if (pending) {
        pending.pending = false;
        pending.at ??= msgTime(msg);
        if (uuid === this.compactUuid) this.compactStartedTurn = this.turn;
        return;
      }
      if (this.seenUuids.has(uuid)) return;
      this.seenUuids.add(uuid);
    }
    const content = msg.message?.content;
    // Resumo do /compact. No transcript (histórico) vem marcado `isCompactSummary`; ao vivo, no fluxo do CLI,
    // vem só como mensagem sintética (`isSynthetic`) com o texto do resumo — antes caía como bolha do usuário.
    // Tem que ser checado antes do `isVisibleInTranscriptOnly`, que o transcript também põe nele.
    if (msg.isCompactSummary || (msg.isSynthetic && isCompactSummaryText(visibleUserText(content).text))) {
      const summary = visibleUserText(content).text;
      // O resumo ocupa o lugar da conversa antiga (já passou pelo `seenUuids`: só a primeira vez chega aqui).
      this.contextUsage = { ...this.contextUsage, usedTokens: 0 };
      // A marca desta compactação é a última, sem fala do usuário depois dela (senão é de uma compactação antiga).
      let last: CompactItem | undefined;
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        if (it.kind === 'compact') {
          last = it;
          break;
        }
        if (it.kind === 'user') break;
      }
      if (last && !last.summary) last.summary = summary;
      else if (!last || last.summary !== summary) this.add({ kind: 'compact', key: `compact:${uuid ?? this.items.length}`, summary });
      return;
    }
    if (msg.isMeta || msg.isVisibleInTranscriptOnly) {
      // Mensagem de outro agente/sessão: no transcript vem como isMeta, mas é conteúdo que vale mostrar.
      const text = visibleUserText(content).text;
      const am = parseAgentMessages(text, msg.origin);
      if (am) this.add({ kind: 'user', key: uuid ? `user:${uuid}` : `user:h${this.items.length}`, uuid, text: am.map((x) => x.body).join('\n\n'), images: [], source: 'agent', agentMessages: am, at: msgTime(msg) });
      return;
    }
    const parentId: string | undefined = msg.parent_tool_use_id ?? undefined;
    const blocks: any[] = Array.isArray(content) ? content : [];
    const results = blocks.filter((b) => b?.type === 'tool_result');
    if (results.length) {
      const structured = msg.tool_use_result ?? msg.toolUseResult;
      for (const r of results) {
        const t = this.tools.get(r.tool_use_id);
        if (!t) continue;
        const flat = flattenToolResult(r.content);
        t.result = { ...flat, isError: !!r.is_error, structured: results.length === 1 ? structured : undefined };
        const rejected = !!r.is_error && REJECT_RE.test(flat.text);
        t.status = rejected ? 'denied' : r.is_error ? 'error' : 'done';
        t.streaming = false;
        if (t.permission?.status === 'pending') t.permission.status = rejected ? 'denied' : 'allowed';
        if (t.permission) for (const [rid, pt] of this.pendingPermissions) if (pt === t) this.pendingPermissions.delete(rid);
        if (isAgentTool(t) && !launchedInBackground(t)) this.finishTask(undefined, t.id, r.is_error ? 'failed' : 'completed', msgTime(msg));
      }
      return;
    }
    if (parentId) return;
    let { text, images, command } = visibleUserText(content);
    if (/^\[Request interrupted by user/i.test(text)) {
      this.endTurnTools(true);
      this.notice('info', 'Interrompido pelo usuário.');
      return;
    }
    if (/^Caveat: The messages below/i.test(text)) return;
    if (!text && !images.length) return;
    if (command && /^\/(clear|compact)$/.test(command) && opts.history) {
      this.add({ kind: 'notice', key: `cmd:${uuid ?? this.items.length}`, tone: 'info', text: `Comando ${command}` });
      return;
    }

    let source: UserSource = 'user';
    let skillName: string | undefined;
    let taskNotification: TaskNotificationData | undefined;
    let agentMessages: AgentMessageData[] | undefined;

    const tn = parseTaskNotification(text);
    const am = tn ? null : parseAgentMessages(text, msg.origin);
    if (tn) {
      source = 'task';
      taskNotification = tn;
      text = tn.result || tn.summary || text;
      this.finishTask(tn.taskId, tn.toolUseId, tn.status === 'failed' || tn.status === 'killed' ? tn.status : 'completed', msgTime(msg));
    } else if (am) {
      source = 'agent';
      agentMessages = am;
      text = am.map((x) => x.body).join('\n\n');
    } else if (/^(\s*Stop hook feedback:|\s*Hook feedback:)/i.test(text) || (typeof content === 'string' && content.includes('user-prompt-submit-hook'))) {
      source = 'hook';
    } else {
      const lastTool = [...this.items].reverse().find((it) => it.kind === 'tool' || it.kind === 'user');
      if (lastTool && lastTool.kind === 'tool' && lastTool.name === 'Skill') {
        source = 'skill';
        skillName = lastTool.input?.skill ?? lastTool.input?.command ?? 'Skill';
      } else if (/^\s*Base directory for this skill:/.test(text)) {
        source = 'skill';
        skillName = text.match(/skills[\\/]+([^\\/\s]+)/)?.[1] ?? 'Skill';
      } else if (msg.isSynthetic) {
        // O CLI marcou como gerada por ele (não digitada): nunca vira bolha do usuário.
        source = 'auto';
      }
    }

    this.add({ kind: 'user', key: uuid ? `user:${uuid}` : `user:h${this.items.length}`, uuid, text, images, source, skillName, taskNotification, agentMessages, at: msgTime(msg) });
    if (!opts.history && msg.isReplay) this.running = true;
  }

  private onResult(msg: any) {
    this.turn++;
    this.running = false;
    this.status = null;
    const interrupted = msg.subtype === 'error_during_execution';
    this.endTurnTools(interrupted);
    const r: ResultItem = {
      kind: 'result',
      key: `result:${msg.uuid ?? this.turn}`,
      subtype: msg.subtype,
      isError: !!msg.is_error,
      durationMs: msg.duration_ms,
      costUsd: msg.total_cost_usd,
      numTurns: msg.num_turns,
      errors: Array.isArray(msg.errors) ? msg.errors : undefined,
      tokens: tokensFromUsage(msg.usage),
      sessionTokens: tokensFromModelUsage(msg.modelUsage),
    };
    if (this.byKey.has(r.key)) return;
    // Janela do modelo principal (o resultado traz um item por modelo da sessão). Sem casar, mantém a que já sabia.
    const win = windowFromModelUsage(msg.modelUsage, [this.lastMainModel, this.initModel]);
    if (win) this.contextUsage = { ...this.contextUsage, ...win };
    this.lastResult = r;
    this.add(r);
  }

  private onSystem(msg: any, opts: { history?: boolean }) {
    switch (msg.subtype) {
      case 'status':
        this.status = msg.status ?? null;
        if (msg.status === 'requesting' && !opts.history) this.running = true;
        return;
      case 'init':
        if (typeof msg.model === 'string' && msg.model) this.initModel = msg.model;
        return;
      case 'compact_boundary': {
        // Reidratar (transcript + buffer ao vivo) repete a mesma marca: uma só. O contexto zera só na primeira
        // vez: uma marca repetida por replay não pode apagar o uso de mensagens mais novas.
        const key = `compact:${msg.uuid ?? this.items.length}`;
        if (!this.byKey.has(key)) {
          this.add({ kind: 'compact', key });
          this.contextUsage = { ...this.contextUsage, usedTokens: 0 };
        }
        return;
      }
      case 'api_retry':
        this.notice(
          'warn',
          `Falha temporária da API${msg.error_status ? ` (${msg.error_status})` : ''} — tentando de novo (${msg.attempt}/${msg.max_retries})…`,
          `retry:${this.turn}`,
        );
        return;
      case 'permission_denied': {
        const t = this.tools.get(msg.tool_use_id);
        if (t) t.status = 'denied';
        return;
      }
      case 'task_started': {
        const isAgent = msg.task_type === 'local_agent' || (!msg.task_type && !!msg.subagent_type);
        if (opts.history || msg.ambient || msg.skip_transcript || !msg.task_id) return;
        if (this.endedTasks.has(msg.task_id) || (msg.tool_use_id && this.endedTasks.has(msg.tool_use_id))) return;
        this.agentTasks.set(msg.task_id, {
          taskId: msg.task_id,
          toolUseId: msg.tool_use_id || undefined,
          description: String(msg.description ?? ''),
          type: msg.subagent_type || undefined,
          prompt: typeof msg.prompt === 'string' ? msg.prompt : undefined,
          background: !!msg.is_backgrounded,
          kind: isAgent ? 'agent' : 'task',
        });
        return;
      }
      case 'task_notification':
        this.finishTask(msg.task_id, msg.tool_use_id, msg.status === 'failed' || msg.status === 'killed' ? msg.status : 'completed', msgTime(msg));
        return;
      case 'task_updated': {
        const s = msg.patch?.status;
        if (s === 'completed' || s === 'failed' || s === 'killed') this.finishTask(msg.task_id, undefined, s, msgTime(msg));
        else if (msg.patch?.is_backgrounded && this.agentTasks.has(msg.task_id)) this.agentTasks.get(msg.task_id)!.background = true;
        return;
      }
      case 'api_error':
        if (msg.content) this.notice('error', String(msg.content));
        return;
      default:
        return;
    }
  }

  private onPermission(requestId: string, req: any) {
    let t = req.tool_use_id ? this.tools.get(req.tool_use_id) : undefined;
    if (!t) {
      const id = req.tool_use_id ?? `perm-${requestId}`;
      t = this.newTool(id, req.tool_name, req.input ?? {});
      this.add(t);
    }
    if (t.permission?.requestId === requestId && t.permission.status !== 'pending') return;
    t.permission = {
      requestId,
      toolName: req.tool_name,
      input: req.input ?? t.input,
      suggestions: req.permission_suggestions,
      reason: typeof req.decision_reason === 'string' ? req.decision_reason.replace(/\x1b\[[0-9;]*m/g, '') : undefined,
      reasonType: req.decision_reason_type,
      title: req.title,
      displayName: req.display_name,
      description: req.description,
      blockedPath: req.blocked_path,
      suppressAlways: !!req.suppress_always_allow_rule,
      defaultToNo: !!req.default_to_no,
      status: 'pending',
    };
    if (req.input && Object.keys(req.input).length) t.input = req.input;
    this.pendingPermissions.set(requestId, t);
  }

  /** A interface respondeu a um pedido de permissão. */
  answered(requestId: string, status: 'allowed' | 'denied', answer?: string) {
    const t = this.pendingPermissions.get(requestId);
    if (t?.permission) {
      t.permission.status = status;
      t.permission.answer = answer;
      if (status === 'denied') t.status = 'denied';
    }
    this.pendingPermissions.delete(requestId);
    this.version++;
  }

  private onDeckEvent(msg: any) {
    if (msg.event === 'process_ended') {
      this.running = false;
      this.status = null;
      this.endTurnTools(true);
      if (msg.error) this.notice('error', String(msg.error));
      else this.notice('info', 'O processo do Claude foi encerrado. A próxima mensagem retoma esta conversa.');
    } else if (msg.event === 'idle_kill') {
      this.running = false;
      this.endTurnTools(true);
      this.notice('info', 'A conversa ficou parada muito tempo e foi pausada no servidor. A próxima mensagem retoma de onde parou.');
    } else if (msg.event === 'runner_gone') {
      this.running = false;
      this.status = null;
      this.endTurnTools(true);
      this.notice('info', 'O processo desta conversa não está mais rodando no servidor (reinício ou limpeza). A próxima mensagem retoma de onde parou.');
    } else if (msg.event === 'interrupted_before_start') {
      // Parado antes de o Claude receber a mensagem: ela não foi enviada e não roda depois.
      this.running = false;
      this.status = null;
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        if (it.kind !== 'user' || (it.source && it.source !== 'user')) continue;
        if (it.pending) {
          it.pending = false;
          it.failed = 'parada antes de chegar ao Claude';
        }
        break;
      }
      this.notice('info', 'Interrompido antes de o Claude receber a mensagem.');
    }
  }

  /** Junta uma página mais antiga do transcript no começo. */
  prepend(older: ChatModel) {
    for (const [id, t] of older.tools) if (!this.tools.has(id)) this.tools.set(id, t);
    for (const it of older.items) this.byKey.set(it.key, it);
    this.items = [...older.items, ...this.items];
    this.version++;
  }

  /** Quantos pedidos de permissão estão esperando resposta. */
  get pendingCount() {
    return this.pendingPermissions.size;
  }

  /** Atualiza as ferramentas filhas de um agente a partir das linhas do seu arquivo de transcrito. */
  applyAgentTranscript(toolId: string, lines: any[]): boolean {
    const parent = this.tools.get(toolId);
    if (!parent) return false;
    let changed = false;
    const toolsById = new Map<string, ToolItem>();
    for (const ch of parent.children) {
      if (ch.kind === 'tool') toolsById.set((ch as ToolItem).id, ch as ToolItem);
    }
    const newChildren: Item[] = [];
    for (const line of lines) {
      const blocks = Array.isArray(line.message?.content) ? line.message.content : [];
      if (line.type === 'assistant') {
        for (const b of blocks) {
          if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
            let t = toolsById.get(b.id);
            if (!t) {
              t = this.newTool(b.id, b.name, b.input ?? {}, parent.id);
              toolsById.set(b.id, t);
              changed = true;
            } else {
              t.input = b.input ?? t.input;
            }
            if (!newChildren.includes(t)) newChildren.push(t);
          } else if (b.type === 'text' && b.text?.trim()) {
            const key = `agent_txt:${b.id || line.uuid || newChildren.length}`;
            if (!newChildren.some((ch) => ch.key === key)) {
              newChildren.push({ kind: 'text', key, text: b.text });
              changed = true;
            }
          }
        }
      } else if (line.type === 'user') {
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            const t = toolsById.get(b.tool_use_id);
            if (t) {
              const flat = flattenToolResult(b.content);
              const wasDone = t.status === 'done';
              t.result = { ...flat, isError: !!b.is_error };
              t.status = b.is_error ? 'error' : 'done';
              if (!wasDone) changed = true;
            }
          }
        }
      }
    }
    const hasResult = lines.some((l) => l.type === 'result');
    if (hasResult) {
      this.finishTask(undefined, toolId, 'completed');
      changed = true;
    }
    if (newChildren.length > 0 && (changed || parent.children.length !== newChildren.length)) {
      parent.children = newChildren;
      this.version++;
      return true;
    }
    return false;
  }

  private finishTask(taskId?: string, toolUseId?: string, status: 'completed' | 'failed' | 'killed' = 'completed', at?: number) {
    const known = taskId ? this.agentTasks.get(taskId) : [...this.agentTasks.values()].find((a) => a.toolUseId === toolUseId);
    const id = taskId ?? known?.taskId ?? toolUseId;
    const tool = known?.toolUseId ? this.tools.get(known.toolUseId)
      : toolUseId ? this.tools.get(toolUseId)
      : [...this.tools.values()].find((t) => t.result?.structured?.agentId === taskId);
    if (id && (known || tool)) {
      this.recentTasks.set(id, {
        id: known?.toolUseId ?? toolUseId ?? tool?.id ?? id,
        taskId: known?.taskId ?? taskId,
        agentId: tool?.result?.structured?.agentId ?? (known?.kind === 'agent' ? known.taskId : undefined),
        kind: known?.kind ?? (tool && isAgentTool(tool) ? 'agent' : 'task'),
        status,
        finishedAt: at ?? (this.inHistory ? undefined : Date.now()),
        background: known?.background ?? (tool ? launchedInBackground(tool) : true),
        description: known?.description ?? tool?.input?.description ?? '',
        type: known?.type ?? tool?.input?.subagent_type,
        prompt: known?.prompt ?? tool?.input?.prompt,
        model: tool?.result?.structured?.resolvedModel ?? tool?.agentModel,
        models: Array.isArray(tool?.result?.structured?.modelsUsed) ? tool.result.structured.modelsUsed.filter((m: unknown): m is string => typeof m === 'string' && !!m) : undefined,
      });
      if (this.recentTasks.size > 30) this.recentTasks.delete(this.recentTasks.keys().next().value!);
    }
    for (const key of [taskId, toolUseId, known?.toolUseId]) if (key) this.endedTasks.add(key);
    if (taskId) this.agentTasks.delete(taskId);
    if (toolUseId) for (const [key, a] of this.agentTasks) if (a.toolUseId === toolUseId) this.agentTasks.delete(key);
  }

  /** Agentes e outras tarefas para o mapa: os que rodam primeiro, os recém-terminados depois. */
  agentMap(processStartedAt?: number): AgentRun[] {
    const running = this.runningAgents(processStartedAt);
    const tasks: AgentRun[] = [...this.agentTasks.values()]
      .filter((a) => a.kind === 'task')
      .map((a) => ({ id: a.toolUseId ?? a.taskId, taskId: a.taskId, kind: 'task', status: 'working', description: a.description, type: a.type, prompt: a.prompt, background: a.background }));
    const active = new Set([...running, ...tasks].map((a) => a.taskId ?? a.id));
    const order = { working: 0, failed: 1, killed: 2, completed: 3 };
    return [...running, ...tasks, ...[...this.recentTasks.values()].reverse().filter((a) => !active.has(a.taskId ?? a.id))]
      .sort((a, b) => (order[a.status ?? 'working'] - order[b.status ?? 'working']) || (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  }

  /**
   * Subagentes em execução agora (o que a extensão mostra ao lado do seletor de modelo). Conta o que roda
   * em primeiro plano e o que foi lançado em segundo plano e ainda não avisou que terminou.
   *
   * `processStartedAt`: quando o processo do Claude atual começou (ms). Um subagente em segundo plano que só
   * consta no transcript vale se foi lançado depois disso; sem essa informação, só vale o que chegou ao vivo
   * (um agente de um processo antigo já morreu e nunca mandaria o aviso de fim).
   */
  runningAgents(processStartedAt?: number): AgentRun[] {
    const out = new Map<string, AgentRun>();
    const MAX_AGENT_AGE_MS = 60 * 60 * 1000;
    const fresh = (t: ToolItem) => {
      if (t.live) return true;
      if (t.at != null && Date.now() - t.at > MAX_AGENT_AGE_MS) return false;
      return processStartedAt != null && (t.at == null || t.at >= processStartedAt);
    };
    const from = (id: string, background: boolean, tool?: ToolItem, task?: { description: string; type?: string; prompt?: string }): AgentRun => {
      const result = tool?.result?.structured ?? {};
      const models = Array.isArray(result.modelsUsed) ? result.modelsUsed.filter((m: unknown): m is string => typeof m === 'string' && !!m) : undefined;
      return {
        id,
        taskId: task && 'taskId' in task ? String(task.taskId) : (typeof result.agentId === 'string' ? result.agentId : undefined),
        agentId: typeof result.agentId === 'string' ? result.agentId : (task && 'taskId' in task ? String(task.taskId) : undefined),
        kind: 'agent',
        status: 'working',
        description: task?.description || tool?.input?.description || result.description || '',
        type: task?.type ?? tool?.input?.subagent_type ?? result.agentType,
        model: typeof result.resolvedModel === 'string' ? result.resolvedModel : tool?.agentModel,
        models,
        prompt: task?.prompt ?? tool?.input?.prompt ?? (typeof result.prompt === 'string' ? result.prompt : undefined),
        background,
      };
    };
    for (const a of this.agentTasks.values()) {
      // Comando em segundo plano (Bash etc.) não é agente: entra só no mapa, não no "N agentes".
      if (a.kind === 'task') continue;
      const tool = a.toolUseId ? this.tools.get(a.toolUseId) : undefined;
      // Em primeiro plano, a chamada voltando já é o fim dele.
      if (tool && tool.status !== 'running' && !a.background && !launchedInBackground(tool)) continue;
      out.set(a.toolUseId ?? a.taskId, from(a.toolUseId ?? a.taskId, a.background, tool, a));
    }
    for (const t of this.tools.values()) {
      if (!isAgentTool(t) || out.has(t.id) || !fresh(t)) continue;
      if (this.endedTasks.has(t.id) || (t.result?.structured?.agentId && this.endedTasks.has(t.result.structured.agentId))) continue;
      const background = launchedInBackground(t);
      if (t.status === 'running' || (background && t.status === 'done')) out.set(t.id, from(t.id, background, t));
    }
    return [...out.values()];
  }
}
