// Tipos compartilhados entre o servidor (Node) e a interface (navegador).

export type Platform = 'win32' | 'posix';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk';

export const LOCAL_HOST_ID = 'local';

/** Um servidor (alias do ~/.ssh/config) ou o próprio computador. */
export interface HostInfo {
  id: string; // 'local' ou o alias do ssh config
  label: string;
  kind: 'local' | 'ssh';
  /** Resumo seguro para exibir (usuário@host:porta); só o que já está no config. */
  address?: string;
  favorite: boolean;
  /** Pastas abertas recentemente (importadas do VS Code e usadas no app). */
  recentFolders: string[];
  /** Cor da etiqueta (derivada do nome). */
  color: string;
}

export type HostConnState = 'idle' | 'connecting' | 'ready' | 'error' | 'reconnecting';
export type AgentEngine = 'claude' | 'antigravity';

export interface HostStatus {
  id: string;
  state: HostConnState;
  error?: string;
  platform?: Platform;
  home?: string;
  claude?: { path: string; version: string } | null;
  claudeCandidates?: { path: string; version: string }[];
  agy?: { path: string; version: string } | null;
  agyCandidates?: { path: string; version: string }[];
  /**
   * Versão mais nova do Claude Code publicada, quando é maior que a do servidor e ele pode ser atualizado
   * (só SSH). Ausente = em dia, desconhecida ou sem como atualizar. Ver HostRegistry.status.
   */
  claudeLatest?: string;
  channels?: number;
  connections?: number;
}

/** Resultado de `hosts.updateClaude` (atualizar o Claude Code de um servidor). */
export interface ClaudeUpdateResult {
  before: string;
  after: string;
  /** Versão mais nova publicada, se o Deck conseguiu consultar. */
  latest?: string;
  /** A versão subiu. Falso quando o servidor já estava na mais nova do canal dele. */
  changed: boolean;
  /** Final da saída do `claude update`, para mostrar ao usuário. */
  output: string;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mtime: number; // ms
  /** Para links simbólicos: o tipo do alvo (se resolvido). */
  targetType?: 'file' | 'dir' | 'missing';
}

export interface FileClipboard {
  id: string;
  revision: number;
  hostId: string;
  path: string;
  name: string;
}

export type FileCopyState = 'scanning' | 'awaitingDecision' | 'queued' | 'copying' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'uncertain';
export interface FileCopyIssue { path: string; message: string }
export interface FileCopyJob {
  id: string;
  requestId: string;
  destinationWid: string;
  revision: number;
  source: { hostId: string; path: string };
  destination: { hostId: string; path: string };
  state: FileCopyState;
  createdAt: number;
  finishedAt?: number;
  files: number;
  directories: number;
  bytes: number;
  transferred: number;
  copied: number;
  skipped: number;
  omitted: number;
  conflicts: number;
  issueCount: number;
  issues: FileCopyIssue[];
  current?: string;
  error?: string;
}

export interface ReadResult {
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
  mtime: number;
  binary: boolean;
  truncated: boolean;
}

/** Identidade persistida de uma conversa marcada manualmente para abrir depois. */
export interface ManualPendingConversation {
  hostId: string;
  sessionId: string;
  cwd: string;
}

/**
 * Mensagem fixada pelo usuário para voltar a ela depois. É só um marcador de leitura: não entra no transcript
 * nem no contexto do Claude. `anchor` é o `uuid` da linha do transcript (com `#n` quando a mesma linha tem
 * mais de um bloco de texto); `snippet` guarda o começo do texto para a lista não depender de carregar a conversa.
 */
export interface PinnedMessage {
  hostId: string;
  sessionId: string;
  anchor: string;
  role: 'user' | 'assistant';
  snippet: string;
  /** Quando a mensagem foi enviada (ms), se já se sabia ao fixar. */
  at?: number;
  pinnedAt: number;
}

/** Máximo de mensagens fixadas por conversa e tamanho do trecho guardado (limite do servidor). */
export const MAX_PINS_PER_CONVERSATION = 100;
export const PIN_SNIPPET_MAX = 200;

export interface SessionSummary {
  sessionId: string;
  title: string;
  firstPrompt?: string;
  mtime: number;
  size: number;
  cwd?: string;
  file: string;
  archived?: boolean;
  /** Marca manual persistida pelo usuário; independe de `SessionState.unseen`, que é automática. */
  manualPending?: boolean;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type SessionPhase =
  | 'starting'
  | 'idle'
  | 'running'
  | 'dormant' // sem processo; retoma com --resume na próxima mensagem
  | 'reconnecting'
  | 'ended'
  | 'error';

/** Estado de uma conversa aberta (aba de chat). */
/** Escolha do gateway para uma conversa no modo automático. */
export interface AutoModelPick {
  /** Valor do seletor de modelo (ex. `flash38[1m]`), ou o nome recebido se o seletor não tiver esse modelo. */
  model: string;
  effort?: EffortLevel;
  /** Rótulo do gateway, ex. "N2 · Flash 3.8 low". */
  label?: string;
}

export interface SessionState {
  sid: string; // id da aba/conversa no app
  hostId: string;
  cwd: string;
  engine?: AgentEngine;
  sessionId?: string; // id do Claude Code / Antigravity (transcript)
  title?: string;
  phase: SessionPhase;
  error?: string;
  model?: string;
  /**
   * Modelo automático (`auto[1m]`): o que o gateway escolheu para esta conversa (descoberto depois do 1º pedido).
   * `model` continua sendo o automático, que é o que o CLI roda; isto é só para mostrar.
   */
  autoPick?: AutoModelPick;
  /** Sem valor explícito, o Claude Code usa seu próprio nível padrão. */
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /**
   * Silencioso: comandos pelo Bash do próprio Claude, fora da tela. Terminal ao Vivo: o Claude
   * digita no terminal visível desta conversa (ferramentas deck_terminal) e lê a tela dele.
   */
  executionMode?: 'silent' | 'terminal';
  /**
   * Aprovar sozinho: o Deck responde "permitir" a todo pedido de permissão de ferramenta desta
   * conversa (útil quando o usuário está longe do PC). Perguntas (AskUserQuestion) e aprovação de
   * plano (ExitPlanMode) continuam esperando o usuário.
   */
  autoApprove?: boolean;
  /** Terminal ligado a esta conversa no modo Terminal ao Vivo. */
  terminalId?: string;
  claudeVersion?: string;
  runnerId?: string;
  createdAt: number;
  /** Janela do app dona da conversa (cada janela só mostra as suas). */
  wid?: string;
  /**
   * Um turno terminou (ou terminou com erro) e ninguém viu ainda. O servidor guarda: sobrevive a
   * recarregar a janela, fechar o app e reiniciar. Some quando a conversa é vista ou um turno novo começa.
   */
  unseen?: 'done' | 'error';
  /**
   * Quando o turno em andamento começou (ms). Vem do servidor, não da tela: recarregar a janela ou
   * reconectar não zera a contagem. Ausente quando não há turno em andamento.
   */
  turnStartedAt?: number;
  /**
   * Quando o processo atual do Claude foi iniciado (ms). A interface usa para saber se um subagente em
   * segundo plano, visto só no transcript, ainda pode estar rodando (se foi lançado depois disso).
   * Ausente enquanto não houve partida neste app (e em servidores antigos).
   */
  processStartedAt?: number;
  /**
   * Último momento (ms) em que o trabalho da conversa mudou de fato: um turno começou ou terminou
   * (com sucesso ou erro). Serve para ordenar as abas por atividade recente. Não muda a cada trecho de
   * resposta. Ausente em conversa que ainda não teve atividade e em servidores antigos: a interface
   * usa o que ela mesma observou e, por fim, `createdAt`.
   */
  lastActivityAt?: number;
  /** Papel da conversa numa orquestração (orquestrador ou worker). Ausente nas conversas comuns. */
  orq?: SessionOrqRole;
}

/** Vínculo de uma conversa com uma orquestração. */
export interface SessionOrqRole {
  /** Id da orquestração. */
  id: string;
  role: 'orchestrator' | 'worker';
  /** Só workers: tarefa (T3) e id do worker (T3.1 = tarefa + tentativa). */
  taskId?: string;
  workerId?: string;
}

// ------------------------------------------------------------------ orquestrador

/** Esforço do orquestrador (planeja e verifica): Alto ou acima. */
export const ORQ_EFFORTS = ['high', 'xhigh', 'max'] as const;
export type OrqEffort = (typeof ORQ_EFFORTS)[number];
/** Esforço dos workers (os chats que o orquestrador abre): Médio ou acima; Baixo nunca. */
export const ORQ_WORKER_EFFORTS = ['medium', 'high', 'xhigh', 'max'] as const;
export type OrqWorkerEffort = (typeof ORQ_WORKER_EFFORTS)[number];

export type OrqStatus =
  | 'planning' // estudando o projeto, perguntando e montando o plano
  | 'awaiting_approval' // plano enviado: só cria workers depois do botão "Aprovar"
  | 'running'
  | 'waiting_user' // o orquestrador pediu algo ao usuário: sem lembretes até ele responder
  | 'paused' // o usuário pausou: nada é entregue sozinho ao orquestrador
  | 'stalled' // parou várias vezes com tarefas pendentes: precisa do usuário
  | 'done'
  | 'cancelled';

export type OrqTaskStatus = 'pending' | 'in_progress' | 'review' | 'done' | 'blocked' | 'cancelled';
export type OrqWorkerRole = 'implement' | 'review' | 'research';
export type OrqWorkerState = 'starting' | 'working' | 'waiting_permission' | 'waiting_answer' | 'idle' | 'error' | 'stopped' | 'closed';
export type OrqReportStatus = 'done' | 'done_with_concerns' | 'needs_context' | 'blocked';

export interface OrqTaskView {
  id: string;
  title: string;
  status: OrqTaskStatus;
  deps: string[];
  files: string[];
  workers: string[];
}

export interface OrqWorkerView {
  id: string;
  taskId: string;
  sid: string;
  role: OrqWorkerRole;
  state: OrqWorkerState;
  model?: string;
  effort: OrqWorkerEffort;
  report?: OrqReportStatus;
  costUsd?: number;
  startedAt: number;
}

/** Resumo de uma orquestração para a interface (painel do orquestrador e marcas nas abas). */
export interface OrchestrationView {
  id: string;
  hostId: string;
  cwd: string;
  wid?: string;
  orchestratorSid: string;
  title: string;
  status: OrqStatus;
  stateDir: string;
  createdAt: number;
  settings: { workerPermissionMode: PermissionMode; maxParallel: number; requireApproval: boolean };
  tasks: OrqTaskView[];
  workers: OrqWorkerView[];
  /** Eventos dos workers ainda não entregues ao orquestrador. */
  queued: number;
  /** Resumo do plano (plan_submit), para o usuário aprovar sabendo o quê. */
  planSummary?: string;
  /** Modelos recusados pelo gateway agora (o Deck trocou de modelo por causa deles). */
  exhaustedModels?: { model: string; kind: 'exhausted' | 'unavailable'; until: number; reason: string }[];
  /** Resumo final (orq_finish). */
  summary?: string;
}

export interface ModelOption {
  value: string;
  displayName: string;
  description?: string;
  supportsAutoMode?: boolean;
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

/** Informações vindas do `initialize` do CLI (cacheadas por servidor). */
export interface SessionCapabilities {
  models: ModelOption[];
  commands: SlashCommandInfo[];
  account?: { email?: string; subscriptionType?: string; apiProvider?: string; tokenSource?: string };
}

export type BrowserId = 'brave' | 'edge' | 'chrome' | 'firefox';

export interface Settings {
  theme: 'dark' | 'light';
  uiFontSize: number;
  editorFontSize: number;
  chatFontSize: number;
  editorWordWrap: boolean;
  editorTabSize: number;
  defaultPermissionMode: PermissionMode;
  defaultModel: string; // '' = padrão do servidor
  defaultEngine: AgentEngine;
  sendWithCtrlEnter: boolean;
  notifications: boolean;
  showThinking: boolean;
  remoteIdleHours: number;
  /** Quando o processo do Claude é morto à força (código 137, ex.: monitor do servidor/OOM) no meio de uma tarefa, manda a mensagem abaixo para ele seguir. */
  autoResumeOnKill: boolean;
  /** Texto enviado ao retomar sozinho ('' = "continue"). */
  autoResumeMessage: string;
  /** Quedas seguidas (em até 5 min uma da outra) antes de desistir e esperar o usuário. */
  autoResumeMax: number;
  localClaudePath: string; // '' = automático
  hostClaudePath: Record<string, string>;
  localAgyPath: string; // '' = automático
  hostAgyPath: Record<string, string>;
  maxOpenFileMB: number;
  /** Onde o terminal integrado abre: à direita da conversa (padrão) ou embaixo. */
  terminalPosition: 'right' | 'bottom';
  /** Colore palavras da saída do terminal (regras "My Custom" do MobaXterm). */
  terminalHighlight: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  uiFontSize: 13,
  editorFontSize: 14,
  chatFontSize: 14,
  editorWordWrap: false,
  editorTabSize: 2,
  defaultPermissionMode: 'default',
  defaultModel: 'flash38[1m]',
  defaultEngine: 'claude',
  sendWithCtrlEnter: false,
  notifications: true,
  showThinking: false,
  remoteIdleHours: 6,
  autoResumeOnKill: false,
  autoResumeMessage: 'continue',
  autoResumeMax: 5,
  localClaudePath: '',
  hostClaudePath: {},
  localAgyPath: '',
  hostAgyPath: {},
  maxOpenFileMB: 20,
  terminalPosition: 'right',
  terminalHighlight: true,
};

/** Estado de interface persistido (abas abertas, layout). */
export interface UiState {
  chatTabs: PersistedChatTab[];
  fileTabs: PersistedFileTab[];
  activeChat?: string;
  activeFile?: string;
  workspace?: { hostId: string; root: string };
  sidebarWidth?: number;
  editorWidth?: number;
  /** Obsoleto: a barra lateral sempre abre no explorador; só existe em estados salvos antigos. */
  sidebarView?: string;
  sidebarVisible?: boolean;
  editorVisible?: boolean;
  expanded?: Record<string, string[]>;
  /** Pastas extras fixadas no explorador (além da raiz do workspace), por servidor. */
  extraRoots?: Record<string, string[]>;
  /** Raízes do explorador minimizadas pelo usuário (chave hostId:root). */
  collapsedRoots?: Record<string, boolean>;
  /** Colunas de tamanho e data nas linhas do explorador (ausente = escondidas). */
  explorerDetails?: boolean;
  /** Painel de terminal aberto (à direita ou embaixo, conforme a configuração). */
  terminalVisible?: boolean;
  terminalHeight?: number;
  terminalWidth?: number;
  /** Grupos de abas recolhidos (id da orquestração cujas conversas formam o grupo). */
  collapsedTabGroups?: string[];
}

/**
 * Posição de uma janela no Windows, lida e reaplicada pelo servidor (Win32), em pixels físicos de tela.
 * Com a janela maximizada (ou minimizada), x/y/width/height são o retângulo para onde ela volta ao restaurar.
 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface TerminalTabInfo {
  id: string;
  hostId: string;
  title: string;
  cwd?: string;
  /** Conversa que controla o terminal (modo Terminal ao Vivo). */
  sid?: string;
  wid?: string;
}

export interface PersistedChatTab {
  sid: string;
  hostId: string;
  cwd: string;
  sessionId?: string;
  title?: string;
  runnerId?: string;
  /** Aba fixada: fica no começo da faixa, na ordem em que as fixadas estão salvas. */
  pinned?: boolean;
}

export interface PersistedFileTab {
  id: string;
  hostId: string;
  path: string;
  view?: string;
}

export interface Workspace {
  hostId: string;
  root: string;
}

/** Uma ocorrência de busca por conteúdo dentro de um arquivo. */
export interface SearchMatch {
  file: string; // caminho relativo à raiz, sempre com '/'
  line: number; // 1-based
  text: string; // linha inteira (recortada se muito longa)
  hlStart: number; // índice do início do trecho a destacar, dentro de `text`
  hlLen: number;
}

export interface SearchResult {
  matches: SearchMatch[];
  filesWithMatches: number;
  truncated: boolean;
}

// ------------------------------------------------------------------ Claude Code settings.json

export type ClaudeSettingsScope = 'user' | 'project';

export interface ClaudeModelPickerOption {
  model: string;
  label?: string;
  description?: string;
  behavesAs?: string;
}

export interface ClaudeSettingsJson {
  env?: Record<string, string>;
  model?: string;
  modelPicker?: {
    options?: ClaudeModelPickerOption[];
    replaceBuiltInOptions?: boolean;
  };
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  modelSettings?: Record<string, { effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }>;
  alwaysApproveResubmissions?: boolean;
  theme?: string;
  tui?: string;
  agentPushNotifEnabled?: boolean;
  hasCompletedOnboarding?: boolean;
  [key: string]: unknown;
}

export interface ClaudeSettingsGetParams {
  hostId: string;
  scope: ClaudeSettingsScope;
  cwd?: string;
}

export interface ClaudeSettingsGetResult {
  exists: boolean;
  path: string;
  scope: ClaudeSettingsScope;
  hostId: string;
  settings: ClaudeSettingsJson;
  raw: string;
  mtime: number;
  error?: string;
}

export interface ClaudeSettingsSaveParams {
  hostId: string;
  scope: ClaudeSettingsScope;
  cwd?: string;
  settings?: ClaudeSettingsJson;
  raw?: string;
}

export interface ClaudeSettingsSaveResult {
  ok: boolean;
  path: string;
  mtime: number;
  backupPath?: string;
}
