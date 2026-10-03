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

export interface HostStatus {
  id: string;
  state: HostConnState;
  error?: string;
  platform?: Platform;
  home?: string;
  claude?: { path: string; version: string } | null;
  claudeCandidates?: { path: string; version: string }[];
  channels?: number;
  connections?: number;
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
export interface SessionState {
  sid: string; // id da aba/conversa no app
  hostId: string;
  cwd: string;
  sessionId?: string; // id do Claude Code (transcript)
  title?: string;
  phase: SessionPhase;
  error?: string;
  model?: string;
  /** Sem valor explícito, o Claude Code usa seu próprio nível padrão. */
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /**
   * Silencioso: comandos pelo Bash do próprio Claude, fora da tela. Terminal ao Vivo: o Claude
   * digita no terminal visível desta conversa (ferramentas deck_terminal) e lê a tela dele.
   */
  executionMode?: 'silent' | 'terminal';
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
  sendWithCtrlEnter: boolean;
  notifications: boolean;
  showThinking: boolean;
  remoteIdleHours: number;
  localClaudePath: string; // '' = automático
  hostClaudePath: Record<string, string>;
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
  defaultModel: '',
  sendWithCtrlEnter: false,
  notifications: true,
  showThinking: false,
  remoteIdleHours: 6,
  localClaudePath: '',
  hostClaudePath: {},
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
  /** Painel de terminal aberto (à direita ou embaixo, conforme a configuração). */
  terminalVisible?: boolean;
  terminalHeight?: number;
  terminalWidth?: number;
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
