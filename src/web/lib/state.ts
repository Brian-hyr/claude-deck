// Estado global da interface (signals) + ações que conversam com o servidor local.
import { batch, computed, effect, signal, type Signal } from '@preact/signals';
import { rpc, RpcError } from './rpc';
import { ChatModel, type ImageData } from './chatModel';
import { autoCompactFromResponse } from './contextUsage';
import { isFilePublishing, reportFileEdits, syncFileCopies, wireFileCopies } from './fileCopy';
import {
  DEFAULT_SETTINGS,
  LOCAL_HOST_ID,
  type HostInfo,
  type HostStatus,
  type EffortLevel,
  type PersistedChatTab,
  type PermissionMode,
  type SessionCapabilities,
  type SessionState,
  type Settings,
  type UiState,
  type TerminalTabInfo,
} from '../../shared/types';
import type { AuthPrompt } from '../../shared/protocol';
import { basename, dirname, extname, normalize, relativeTo, tildify } from '../../shared/paths';
import { decodeOpen } from '../../shared/openwin';
import { activityPrefix, chatActivity } from './activity';
import { lastActivityOf, scheduleTabSort, sortTabs } from './tabOrder';

// ------------------------------------------------------------------ tipos da tela

export type ViewerKind = 'text' | 'markdown' | 'html' | 'image' | 'svg' | 'video' | 'audio' | 'json' | 'pdf' | 'csv' | 'binary';

export interface ChatTab {
  sid: string;
  state: Signal<SessionState>;
  model: ChatModel;
  version: Signal<number>;
  loaded: boolean;
  loading: Signal<boolean>;
  loadError: Signal<string | null>;
  historyStart?: number;
  historyFile?: string;
  hasMore: Signal<boolean>;
  lastSeq: number;
  queued: { seq: number; msg: any }[];
  /** Pedido de permissão esperando. "Terminou e não vi" não fica aqui: vem do servidor (`state.unseen`). */
  attention: Signal<'permission' | null>;
  draft: string;
  images: ImageData[];
  /** Processo do Claude para o qual já se perguntou a compactação automática (`ensureAutoCompact`). */
  autoCompactKey?: string;
  /** Depois de uma falha, só tenta de novo a partir deste horário (ms). */
  autoCompactRetryAt?: number;
}

export interface FileTab {
  id: string;
  hostId: string;
  path: string;
  name: string;
  kind: ViewerKind;
  mode: Signal<'view' | 'edit'>;
  content: string;
  savedContent: string;
  mtime: number;
  size: number;
  truncated: boolean;
  binary: boolean;
  dirty: Signal<boolean>;
  loading: Signal<boolean>;
  error: Signal<string | null>;
  changedOnDisk: Signal<boolean>;
  reloadKey: Signal<number>;
  editorState?: unknown;
  pendingLine?: number;
}

export type SidebarView = 'explorer' | 'search' | 'servers' | 'history' | 'settings';

export interface Workspace {
  hostId: string;
  root: string;
}

// ------------------------------------------------------------------ signals

/**
 * Id desta janela do app. Fica no sessionStorage: sobrevive a recarregar a página, mas uma janela
 * nova começa sem id (o servidor dá um). Cada janela tem as suas abas, pasta e arquivos abertos.
 */
const WID_KEY = 'deck.wid';
export let windowId = '';
/**
 * Abas fechadas aqui. O servidor ainda pode mandar um último estado delas enquanto encerra o processo
 * (antes do "encerrada"): elas não voltam como aba fantasma, sem processo por trás.
 */
const closedSids = new Set<string>();
/** Reabrir enquanto o fechamento ainda está no servidor espera o fim dele. */
const closingConversations = new Map<string, Promise<void>>();
/**
 * Servidor + pasta desta janela (fixos: vêm da primeira conversa). Conversa de outro servidor ou
 * pasta abre na janela dela; arquivos de outras pastas podem ser vistos aqui sem mudar isto.
 */
export const windowContext = signal<{ hostId: string; cwd: string } | null>(null);
/** Marca temporária no título: o servidor usa para achar esta janela e trazê-la para a frente. */
const focusMarker = signal<string | null>(null);
function readStoredWid(): string | undefined {
  try {
    return sessionStorage.getItem(WID_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Atalho clicado com o app já aberto: o launcher abre a página com `#nova` (o fragmento sobrevive ao
 * redirecionamento do /auth). A página cria o próprio id e vira uma janela nova e vazia, sem servidor.
 * Com id próprio, até um servidor de versão anterior (que trazia outra janela para a frente) a trata
 * como janela nova. Tira o `#nova` da URL na hora; recarregar (F5) já usa o id salvo.
 */
function takeNewWindowId(first: boolean): string | undefined {
  if (!first || location.hash !== '#nova') return undefined;
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    /* ignora */
  }
  if (readStoredWid()) return undefined;
  try {
    return crypto.randomUUID();
  } catch {
    return undefined;
  }
}

/** Esta página foi aberta para um servidor+pasta que já tem janela: ela se fecha sozinha. */
export const duplicateWindow = signal(false);
export const bootId = signal<string>('');
export const appPlatform = signal<string>('win32');
export const localHome = signal<string>('');
export const settings = signal<Settings>(DEFAULT_SETTINGS);
export const hosts = signal<HostInfo[]>([]);
export const hostStatus = signal<Record<string, HostStatus>>({});
export const caps = signal<Record<string, SessionCapabilities>>({});
export const authPrompts = signal<AuthPrompt[]>([]);
export const chats = signal<ChatTab[]>([]);
export const activeChatId = signal<string | null>(null);
/** Aba de conversa com o nome em edição (renomear direto na aba: duplo clique, F2 ou menu). */
export const renamingSid = signal<string | null>(null);
/** Uma aba está sendo arrastada: a ordenação automática espera o arrasto acabar. */
export const tabDragging = signal(false);
/** Sobe a cada reordenação automática/manual das abas: a faixa de abas rola até a ativa. */
export const tabOrderStamp = signal(0);
export const files = signal<FileTab[]>([]);
export const activeFileId = signal<string | null>(null);
export const workspace = signal<Workspace | null>(null);
/** O explorador de arquivos é sempre a visão inicial da barra lateral (não é restaurada do estado salvo). */
export const sidebarView = signal<SidebarView>('explorer');
export const sidebarVisible = signal(true);
export const editorVisible = signal(false);
export const sidebarWidth = signal(280);
export const editorWidth = signal(Math.round(window.innerWidth * 0.36));
export const expandedDirs = signal<Record<string, string[]>>({});
/** Pastas extras fixadas no explorador (além da raiz do workspace), por servidor. */
export const extraRoots = signal<Record<string, string[]>>({});
/** Raízes do explorador minimizadas pelo usuário (chave hostId:root). */
export const collapsedRoots = signal<Record<string, boolean>>({});
export const explorerRefresh = signal(0);
export const ready = signal(false);
/** Terminal integrado (à direita ou embaixo, conforme settings.terminalPosition). */
export const terminalVisible = signal(false);
export const terminalHeight = signal(240);
export const terminalWidth = signal(Math.round(window.innerWidth * 0.45));
export const terminalTabs = signal<TerminalTabInfo[]>([]);
export const activeTerminalId = signal<string | null>(null);
/** Envio de arquivo em andamento (mostrado na barra de status). */
export const uploadProgress = signal<{ name: string; pct: number } | null>(null);
export const stats = signal<{ rss: number; running: number; sessions: number; hostsConnected: number; channels: number } | null>(null);

/** A pendência manual pertence ao transcript, não à aba (que pode ser fechada). */
export interface PendingConversation { hostId: string; sessionId: string; cwd: string }
export const pendingSupported = signal(false);
export const pendingConversations = signal<Record<string, PendingConversation>>({});
const pendingOps = new Map<string, Promise<boolean>>();
const pendingKey = (hostId: string, sessionId: string) => JSON.stringify([hostId, sessionId]);
export function isPending(hostId: string, sessionId?: string): boolean {
  return !!sessionId && !!pendingConversations.value[pendingKey(hostId, sessionId)];
}
export function pendingCountFor(hostId: string): number {
  return Object.values(pendingConversations.value).filter((p) => p.hostId === hostId).length;
}

async function refreshPending(hostId: string) {
  if (!pendingSupported.value) return;
  try {
    const records = await rpc.call<PendingConversation[]>('pending.list', { hostId });
    const next = { ...pendingConversations.peek() };
    for (const [key, item] of Object.entries(next)) if (item.hostId === hostId) delete next[key];
    for (const item of records) next[pendingKey(item.hostId, item.sessionId)] = item;
    pendingConversations.value = next;
  } catch (e) {
    toast(`Não consegui carregar as pendências: ${errorText(e)}`, 'error');
  }
}

/** Não anunciar sucesso antes do servidor gravar; uma falha mantém a marca na tela. */
export async function setConversationPending(hostId: string, sessionId: string | undefined, cwd: string, pending: boolean): Promise<boolean> {
  if (!sessionId) return false;
  if (!pendingSupported.value) {
    toast('Para marcar conversas, atualize o servidor do Claude Deck quando ele estiver ocioso.', 'error', 8000);
    return false;
  }
  const key = pendingKey(hostId, sessionId);
  const previous = pendingOps.get(key);
  const task = (async () => {
    if (previous) await previous;
    try {
      await rpc.call('pending.set', { hostId, sessionId, cwd, pending });
      const next = { ...pendingConversations.peek() };
      if (pending) next[key] = { hostId, sessionId, cwd };
      else delete next[key];
      pendingConversations.value = next;
      return true;
    } catch (e) {
      toast(`Não consegui ${pending ? 'marcar' : 'desmarcar'} a conversa: ${errorText(e)}`, 'error', 8000);
      return false;
    }
  })();
  pendingOps.set(key, task);
  void task.finally(() => { if (pendingOps.get(key) === task) pendingOps.delete(key); });
  return task;
}

function clearPendingOnOpen(c: ChatTab) {
  const st = c.state.peek();
  if (st.sessionId && (isPending(st.hostId, st.sessionId) || pendingOps.has(pendingKey(st.hostId, st.sessionId))))
    void setConversationPending(st.hostId, st.sessionId, st.cwd, false);
}

export const activeChat = computed(() => chats.value.find((c) => c.sid === activeChatId.value) ?? null);
export const activeFile = computed(() => files.value.find((f) => f.id === activeFileId.value) ?? null);

export function hostLabel(id: string): string {
  if (id === LOCAL_HOST_ID) return 'Local';
  return id;
}

export function hostInfo(id: string): HostInfo | undefined {
  return hosts.value.find((h) => h.id === id);
}

export function hostColor(id: string): string {
  const c = hostInfo(id)?.color ?? '#888888';
  // As cores dos servidores são claras (pensadas para o tema escuro): no claro, escurece.
  return settings.value.theme === 'light' ? `color-mix(in srgb, ${c} 58%, #000)` : c;
}

export function platformOf(hostId: string): 'win32' | 'posix' {
  if (hostId === LOCAL_HOST_ID) return appPlatform.value === 'win32' ? 'win32' : 'posix';
  return hostStatus.value[hostId]?.platform ?? 'posix';
}

export function sameFolder(hostId: string, a: string, b: string): boolean {
  if (!a || !b) return a === b;
  const plat = platformOf(hostId);
  const na = normalize(plat, a);
  const nb = normalize(plat, b);
  return plat === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function homeOf(hostId: string): string | undefined {
  if (hostId === LOCAL_HOST_ID) return localHome.value;
  return hostStatus.value[hostId]?.home;
}

// ------------------------------------------------------------------ avisos e diálogos

export interface Toast {
  id: number;
  tone: 'info' | 'error' | 'success';
  text: string;
}
export const toasts = signal<Toast[]>([]);
let toastSeq = 0;
export function toast(text: string, tone: Toast['tone'] = 'info', ms = 4500) {
  const t = { id: ++toastSeq, tone, text };
  toasts.value = [...toasts.value, t];
  setTimeout(() => (toasts.value = toasts.value.filter((x) => x.id !== t.id)), ms);
}

export function errorText(e: unknown): string {
  return e instanceof RpcError || e instanceof Error ? e.message : String(e);
}

export interface DialogRequest {
  id: number;
  kind: 'confirm' | 'prompt';
  title: string;
  message?: string;
  value?: string;
  okLabel?: string;
  /** Segundo botão de ação (entre Cancelar e o principal): a resposta é o texto 'alt'. */
  altLabel?: string;
  danger?: boolean;
  resolve: (v: string | boolean | null) => void;
}
export const dialogs = signal<DialogRequest[]>([]);
let dialogSeq = 0;
/** Pergunta com três saídas: principal (`ok`), alternativa (`alt`) ou cancelar. */
export function choiceDialog(title: string, message: string, okLabel: string, altLabel: string, danger = false): Promise<'ok' | 'alt' | 'cancel'> {
  return new Promise((resolve) => {
    dialogs.value = [
      ...dialogs.value,
      { id: ++dialogSeq, kind: 'confirm', title, message, okLabel, altLabel, danger, resolve: (v) => resolve(v === true ? 'ok' : v === 'alt' ? 'alt' : 'cancel') },
    ];
  });
}
export function confirmDialog(title: string, message?: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    dialogs.value = [...dialogs.value, { id: ++dialogSeq, kind: 'confirm', title, message, okLabel, danger, resolve: (v) => resolve(!!v) }];
  });
}
export function promptDialog(title: string, value = '', message?: string, okLabel = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    dialogs.value = [...dialogs.value, { id: ++dialogSeq, kind: 'prompt', title, message, value, okLabel, resolve: (v) => resolve(typeof v === 'string' ? v : null) }];
  });
}
export function closeDialog(id: number, value: string | boolean | null) {
  const d = dialogs.value.find((x) => x.id === id);
  dialogs.value = dialogs.value.filter((x) => x.id !== id);
  d?.resolve(value);
}

/** Seletor de servidor/pasta para nova conversa (quick pick). */
export const newChatPicker = signal<{ hostId?: string } | null>(null);
/** Navegador de pastas (para abrir outra pasta, escolher pasta da conversa ou fixar uma pasta extra). */
export const folderBrowser = signal<{ hostId: string; start?: string; purpose: 'workspace' | 'chat' | 'add-root' | 'move'; move?: { path: string; dir: boolean } } | null>(null);

/** Fixa uma pasta extra no explorador (sem trocar a raiz do workspace). */
export function addExtraRoot(hostId: string, root: string) {
  const list = extraRoots.value[hostId] ?? [];
  if (list.includes(root)) return;
  extraRoots.value = { ...extraRoots.value, [hostId]: [...list, root] };
}

export function removeExtraRoot(hostId: string, root: string) {
  extraRoots.value = { ...extraRoots.value, [hostId]: (extraRoots.value[hostId] ?? []).filter((r) => r !== root) };
}
export const quickOpen = signal(false);
export const commandPalette = signal(false);
export const addHostDialog = signal(false);

// ------------------------------------------------------------------ persistência do layout

let saveTimer: number | undefined;
let missingRestoredTabs: PersistedChatTab[] = [];
function saveUiState() {
  if (!ready.value) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const st: UiState = {
      chatTabs: [
        ...chats.value.map((c) => ({ sid: c.sid, hostId: c.state.value.hostId, cwd: c.state.value.cwd })),
        ...missingRestoredTabs.filter((tab) => !chats.value.some((c) => c.sid === tab.sid)),
      ],
      fileTabs: files.value.map((f) => ({ id: f.id, hostId: f.hostId, path: f.path, view: f.mode.value })),
      activeChat: activeChatId.value ?? undefined,
      activeFile: activeFileId.value ?? undefined,
      workspace: workspace.value ?? undefined,
      sidebarWidth: sidebarWidth.value,
      editorWidth: editorWidth.value,
      sidebarVisible: sidebarVisible.value,
      editorVisible: editorVisible.value,
      expanded: expandedDirs.value,
      extraRoots: extraRoots.value,
      collapsedRoots: collapsedRoots.value,
      terminalVisible: terminalVisible.value,
      terminalHeight: terminalHeight.value,
      terminalWidth: terminalWidth.value,
    };
    rpc.call('state.set', st).catch(() => {});
  }, 600);
}

effect(() => {
  // Dependências observadas para salvar o layout.
  void chats.value;
  void files.value;
  void activeChatId.value;
  void activeFileId.value;
  void workspace.value;
  void sidebarWidth.value;
  void editorWidth.value;
  void sidebarVisible.value;
  void editorVisible.value;
  void expandedDirs.value;
  void extraRoots.value;
  void collapsedRoots.value;
  void terminalVisible.value;
  void terminalHeight.value;
  void terminalWidth.value;
  saveUiState();
});

// A pasta do explorador acompanha a aba de conversa ativa (como uma janela do VS Code).
effect(() => {
  const c = activeChat.value;
  if (!c) return;
  const st = c.state.value;
  const ws = workspace.peek();
  if (!ws || ws.hostId !== st.hostId || ws.root !== st.cwd) workspace.value = { hostId: st.hostId, root: st.cwd };
});

// Atividade da janela, para o começo do título: ⏳ trabalhando, ✅/❌ terminou e ainda não foi vista,
// 🔔 (N) esperando você. Como é `computed`, só muda (e só reescreve o título) quando o texto muda,
// não a cada trecho de resposta que chega.
const windowActivity = computed(() =>
  activityPrefix(
    chats.value.map((c) => {
      void c.version.value; // `model.running` e `pendingCount` não são signals: a versão avisa
      const st = c.state.value;
      return chatActivity({ attention: c.attention.value, pendingCount: c.model.pendingCount, phase: st.phase, modelRunning: c.model.running, unseen: st.unseen, manualPending: isPending(st.hostId, st.sessionId) });
    }),
  ),
);

// Título da janela: atividade + servidor e pasta das conversas dela (o título da conversa já aparece
// na aba). A pasta é a do contexto da janela, não a que o explorador só mostra. A marca de foco fica
// sempre no começo: o servidor acha a janela procurando por ela no título.
effect(() => {
  const c = activeChat.value;
  const ws = workspace.value;
  const ctx = windowContext.value ?? (c ? { hostId: c.state.value.hostId, cwd: c.state.value.cwd } : ws ? { hostId: ws.hostId, cwd: ws.root } : null);
  const where = ctx ? `${hostLabel(ctx.hostId)} · ${tildify(ctx.cwd, homeOf(ctx.hostId))} — ` : '';
  const marker = focusMarker.value;
  document.title = `${marker ? `${marker} ` : ''}${windowActivity.value}${where}Claude Deck`;
});

// A primeira conversa fixa o contexto de uma janela que ainda não tinha.
effect(() => {
  if (windowContext.value) return;
  const first = chats.value[0];
  if (first) windowContext.value = { hostId: first.state.value.hostId, cwd: first.state.value.cwd };
});

let pendingHostLoaded = '';
effect(() => {
  const hostId = windowContext.value?.hostId ?? workspace.value?.hostId;
  if (!hostId || hostId === pendingHostLoaded || !pendingSupported.value) return;
  pendingHostLoaded = hostId;
  void refreshPending(hostId);
});

/** Esta janela é a do servidor+pasta dados? (sem contexto ainda = aceita o primeiro) */
export function isThisWindow(hostId: string, cwd: string): boolean {
  const ctx = windowContext.value;
  return !ctx || (ctx.hostId === hostId && sameFolder(hostId, ctx.cwd, cwd));
}

/** Título da aba: o do Claude (ai-title) ou o renomeado; antes disso, o começo da 1ª mensagem. */
export function chatTitle(c: ChatTab): string {
  const st = c.state.value;
  if (st.title) return st.title;
  // Só o que o próprio usuário escreveu: mensagem automática (skill, hook, subagente, outro agente) não vira título.
  const first = c.model.items.find((i) => i.kind === 'user' && (!i.source || i.source === 'user')) as { text?: string } | undefined;
  if (first?.text) return first.text.replace(/\s+/g, ' ').slice(0, 60);
  return st.sessionId && !c.loaded ? 'Conversa' : 'Nova conversa';
}

/**
 * Grava o nome dado pelo usuário (vale na aba, no histórico e no /resume do terminal).
 * Nome vazio ou igual ao atual não faz nada: apagar o campo nunca deixa a aba sem nome.
 */
export async function renameChat(c: ChatTab, raw: string): Promise<void> {
  const title = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title || title === chatTitle(c)) return;
  try {
    await rpc.call('sessions.rename', { sid: c.sid, title });
  } catch (e) {
    toast(`Não consegui renomear: ${errorText(e)}`, 'error');
  }
}

// ------------------------------------------------------------------ inicialização

export async function init() {
  wireEvents();
  wireFileCopies();
  effect(() => {
    for (const f of files.value) void f.dirty.value;
    void reportFileEdits().catch(() => {});
  });
  rpc.connect();
  await loadAll(true);
  rpc.onReconnect(() => {
    loadAll(false).catch((e) => toast(`Falha ao recarregar: ${errorText(e)}`, 'error'));
  });
  setInterval(refreshStats, 5000);
  refreshStats();
  // Abas se reorganizam sozinhas de tempos em tempos (não precisa ser em tempo real).
  scheduleTabSort({ canRun: () => !tabDragging.peek() && renamingSid.peek() === null, run: () => void reorderChatsByActivity() });
}

async function refreshStats() {
  try {
    stats.value = await rpc.call('app.stats', undefined, 10_000);
  } catch {
    /* desconectado */
  }
}

async function loadAll(first: boolean) {
  const info = await rpc.call('app.info');
  const bootChanged = !!bootId.value && bootId.value !== info.bootId;
  batch(() => {
    bootId.value = info.bootId;
    appPlatform.value = info.platform;
    localHome.value = info.home;
    settings.value = info.settings;
    pendingSupported.value = info.manualPending === true;
    caps.value = info.caps ?? {};
    authPrompts.value = info.prompts ?? [];
  });
  applyTheme();
  // A pasta precisa chegar ao window.attach ANTES de o servidor escolher uma janela salva.
  const rawTarget = first ? new URLSearchParams(location.search).get('open') : null;
  const target = decodeOpen(rawTarget);
  if (target && info.windowRestore !== true)
    throw new Error('O servidor do Claude Deck ainda não restaura conversas por pasta. Espere as conversas terminarem e abra pelo atalho para atualizá-lo.');
  const newWid = takeNewWindowId(first);
  const att = await rpc
    .call<{ wid: string; state: UiState; duplicate?: boolean; context?: { hostId: string; cwd: string } | null }>('window.attach', { wid: readStoredWid() ?? newWid, target: target ?? undefined })
    .catch((e) => {
      if ((e as RpcError).code === 'nomethod')
        throw new Error('O servidor do Claude Deck é de uma versão antiga (foi iniciado antes da última atualização). Feche as janelas, rode "npm run app:stop" e abra de novo pelo atalho.');
      throw e;
    });
  if (att.duplicate) {
    // Este servidor+pasta já tem janela aberta: o servidor trouxe aquela para a frente.
    duplicateWindow.value = true;
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      /* ignora */
    }
    setTimeout(() => window.close(), 150);
    return;
  }
  windowId = att.wid;
  windowContext.value = att.context ?? null;
  try {
    sessionStorage.setItem(WID_KEY, att.wid);
  } catch {
    /* sem sessionStorage: cada recarga vira janela nova */
  }
  const [hl, sts, allSessions] = await Promise.all([rpc.call('hosts.list'), rpc.call('hosts.statuses'), rpc.call('sessions.list')]);
  // Esta janela só mostra as conversas dela (menos as que ela acabou de fechar e ainda estão encerrando).
  const sessions = (allSessions as SessionState[]).filter((s) => s.wid === windowId && !closedSids.has(s.sid));
  const pendingHost = att.context?.hostId ?? (sessions[0]?.hostId ?? att.state?.workspace?.hostId ?? 'local');
  await refreshPending(pendingHost);
  batch(() => {
    hosts.value = hl;
    hostStatus.value = Object.fromEntries((sts as HostStatus[]).map((s) => [s.id, s]));
  });
  const st: UiState = att.state ?? { chatTabs: [], fileTabs: [] };
  if (first) {
    // Ordem das abas: a salva, depois as que o servidor tem e a interface não conhecia.
    const byId = new Map<string, SessionState>((sessions as SessionState[]).map((s) => [s.sid, s]));
    missingRestoredTabs = st.chatTabs.filter((tab) => !byId.has(tab.sid));
    if (missingRestoredTabs.length) toast(`${missingRestoredTabs.length} conversa(s) salva(s) não foram encontradas no servidor. O estado foi preservado; procure-as no Histórico.`, 'error', 9000);
    const order = [...new Set([...st.chatTabs.map((t) => t.sid).filter((sid) => byId.has(sid)), ...byId.keys()])];
    const tabs = order.map((sid) => makeChat(byId.get(sid)!));
    batch(() => {
      chats.value = tabs;
      activeChatId.value = st.activeChat && byId.has(st.activeChat) ? st.activeChat : (tabs[0]?.sid ?? null);
      if (st.sidebarWidth) sidebarWidth.value = st.sidebarWidth;
      if (st.editorWidth) editorWidth.value = Math.min(st.editorWidth, window.innerWidth - 500);
      sidebarView.value = 'explorer';
      if (st.sidebarVisible !== undefined) sidebarVisible.value = st.sidebarVisible;
      if (st.expanded) expandedDirs.value = st.expanded;
      if (st.extraRoots) extraRoots.value = st.extraRoots;
      if (st.collapsedRoots) collapsedRoots.value = st.collapsedRoots;
      if (st.terminalHeight) terminalHeight.value = st.terminalHeight;
      if (st.terminalWidth) terminalWidth.value = Math.max(320, Math.min(st.terminalWidth, window.innerWidth - 500));
      if (st.terminalVisible !== undefined) terminalVisible.value = st.terminalVisible;
      if (!tabs.length && st.workspace) workspace.value = st.workspace;
    });
    // Arquivos abertos antes.
    for (const f of st.fileTabs ?? []) openFile(f.hostId, f.path, { activate: false, mode: f.view as any }).catch(() => {});
    if (st.activeFile) activeFileId.value = files.value.find((f) => f.id === st.activeFile)?.id ?? files.value[0]?.id ?? null;
    editorVisible.value = files.value.length > 0 && st.editorVisible !== false;
    // Reanexa conversas remotas que continuam vivas nos servidores.
    rpc.call('sessions.reattach', {}).catch(() => {});
    await syncTerminals();
    ready.value = true;
    const activeLoad = activeChat.value ? loadChat(activeChat.value) : Promise.resolve();
    // Abriu a janela: organiza as abas já, sem esperar o primeiro ciclo de 30 minutos.
    void organizeOnOpen(activeLoad);
    consumeOpenTarget(rawTarget, !!st.chatTabs.length || sessions.length > 0);
  } else {
    // Reconexão: sincroniza abas; se o servidor reiniciou, recarrega as conversas do zero.
    const byId = new Map<string, SessionState>((sessions as SessionState[]).map((s) => [s.sid, s]));
    const kept = chats.value.filter((c) => byId.has(c.sid));
    for (const s of byId.values()) if (!kept.some((c) => c.sid === s.sid)) kept.push(makeChat(s));
    const wasLoaded = new Set(kept.filter((c) => c.loaded).map((c) => c.sid));
    for (const c of kept) {
      c.state.value = byId.get(c.sid)!;
      if (bootChanged) resetChat(c);
    }
    chats.value = kept;
    if (activeChatId.value && !byId.has(activeChatId.value)) activeChatId.value = kept[0]?.sid ?? null;
    // O servidor reiniciou: as conversas abertas recarregam do zero (a aba visível sempre;
    // o componente não recarrega sozinho porque a aba é a mesma).
    for (const c of kept) {
      if (bootChanged) {
        if (wasLoaded.has(c.sid) || c.sid === activeChatId.value) loadChat(c).catch(() => {});
      } else if (c.loaded) resync(c).catch(() => {});
    }
    if (bootChanged) rpc.call('sessions.reattach', {}).catch(() => {});
    await syncTerminals();
  }
  await syncFileCopies(info.fileCopy === 1, bootChanged);
}

function makeChat(st: SessionState): ChatTab {
  return {
    sid: st.sid,
    state: signal(st),
    model: new ChatModel(),
    version: signal(0),
    loaded: false,
    loading: signal(false),
    loadError: signal(null),
    hasMore: signal(false),
    lastSeq: 0,
    queued: [],
    attention: signal(null),
    draft: '',
    images: [],
  };
}

/** A conversa está no modo Terminal ao Vivo (o servidor guarda o modo; vale depois de reiniciar). */
export function isLiveTerminal(c: ChatTab): boolean {
  return c.state.value.executionMode === 'terminal';
}

/**
 * Pergunta ao Claude da conversa em que valor a compactação automática dispara (o usuário pode definir 250k–500k, bem abaixo
 * da janela do modelo; vem de `CLAUDE_CODE_AUTO_COMPACT_WINDOW` ou das configurações, do computador/servidor da
 * conversa, então só o próprio Claude sabe). Sem método novo no servidor: usa o `sessions.control` que já existia.
 * Só para a conversa à vista (a pizza só aparece nela), só com o Claude parado (não disputa o processo no meio de
 * um turno) e uma vez por processo; falha (processo parado, Claude Code antigo) tenta de novo só depois de 30 s.
 */
export function ensureAutoCompact(c: ChatTab) {
  const st = c.state.peek();
  if (!c.loaded || activeChatId.peek() !== c.sid || st.phase !== 'idle') return;
  const key = `${st.runnerId ?? ''}:${st.processStartedAt ?? 0}`;
  if (c.autoCompactKey === key) return;
  if (c.autoCompactRetryAt && Date.now() < c.autoCompactRetryAt) return;
  c.autoCompactKey = key;
  rpc
    .call('sessions.control', { sid: c.sid, request: { subtype: 'get_context_usage', detail: 'summary' } }, 45_000)
    .then((r) => {
      if (c.autoCompactKey !== key) return; // a conversa foi zerada ou o processo trocou enquanto esperava
      c.model.setAutoCompact(autoCompactFromResponse(r));
      c.version.value++;
    })
    .catch(() => {
      if (c.autoCompactKey === key) c.autoCompactKey = undefined;
      c.autoCompactRetryAt = Date.now() + 30_000;
    });
}

function resetChat(c: ChatTab) {
  c.autoCompactKey = undefined;
  c.autoCompactRetryAt = undefined;
  c.model = new ChatModel();
  c.loaded = false;
  c.lastSeq = 0;
  c.queued = [];
  c.historyStart = undefined;
  c.historyFile = undefined;
  c.version.value++;
}

// ------------------------------------------------------------------ eventos do servidor

let bumpScheduled = new Set<ChatTab>();
let rafId = 0;
function bump(c: ChatTab) {
  bumpScheduled.add(c);
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const list = bumpScheduled;
    bumpScheduled = new Set();
    batch(() => {
      for (const x of list) x.version.value++;
    });
  });
}

/**
 * Viu o que tinha terminado nesta conversa: some o aviso aqui e no servidor (que é quem guarda,
 * para valer depois de recarregar a janela ou reiniciar o app). Servidor antigo sem esse método:
 * o erro é ignorado e o aviso some só nesta janela.
 */
export function markSeen(c: ChatTab) {
  if (!c.state.value.unseen) return;
  c.state.value = { ...c.state.value, unseen: undefined };
  rpc.call('sessions.seen', { sid: c.sid }).catch(() => {});
}

/** A conversa à vista (aba ativa, janela visível e com foco) não tem nada "não visto". */
function markSeenIfVisible(c: ChatTab) {
  if (!c.state.value.unseen) return;
  if (activeChatId.peek() !== c.sid || document.visibilityState !== 'visible' || !document.hasFocus()) return;
  markSeen(c);
}

// O aviso chega (ou a aba ativa muda) enquanto você já está olhando para a conversa: não há o que avisar.
effect(() => {
  const c = activeChat.value;
  if (c?.state.value.unseen) markSeenIfVisible(c);
});

/** Voltou para a janela: a conversa que já estava ativa foi vista. As outras esperam você abrir a aba. */
function onWindowShown() {
  const c = activeChat.peek();
  if (c) markSeenIfVisible(c);
}

function wireEvents() {
  window.addEventListener('focus', onWindowShown);
  document.addEventListener('visibilitychange', onWindowShown);
  rpc.on('window.focus', ({ marker, hostId, folder, resume }: { marker?: string; hostId?: string; folder?: string; resume?: string } = {}) => {
    if (marker) {
      focusMarker.value = marker;
      setTimeout(() => {
        if (focusMarker.peek() === marker) focusMarker.value = null;
      }, 6000);
    }
    window.focus();
    // Veio do histórico de outra janela: retoma a conversa aqui, que é a janela da pasta dela.
    if (resume && hostId && folder && isThisWindow(hostId, folder)) void openHistoryChat(hostId, folder, resume);
  });
  rpc.on('window.unmark', ({ marker }: { marker?: string } = {}) => {
    if (marker && focusMarker.peek() === marker) focusMarker.value = null;
  });
  rpc.on('host.status', (st: HostStatus) => {
    hostStatus.value = { ...hostStatus.value, [st.id]: st };
  });
  rpc.on('caps', ({ hostId, caps: c }) => {
    caps.value = { ...caps.value, [hostId]: c };
  });
  rpc.on('hosts.update', (list: HostInfo[]) => {
    hosts.value = list;
  });
  rpc.on('auth.prompt', (p: AuthPrompt) => {
    authPrompts.value = [...authPrompts.value.filter((x) => x.promptId !== p.promptId), p];
  });
  rpc.on('auth.closed', ({ promptId }) => {
    authPrompts.value = authPrompts.value.filter((x) => x.promptId !== promptId);
  });
  rpc.on('pending.changed', (item: PendingConversation & { pending: boolean }) => {
    const next = { ...pendingConversations.peek() };
    const key = pendingKey(item.hostId, item.sessionId);
    if (item.pending) next[key] = { hostId: item.hostId, sessionId: item.sessionId, cwd: item.cwd };
    else delete next[key];
    pendingConversations.value = next;
  });
  rpc.on('session.state', (st: SessionState) => {
    const c = chats.value.find((x) => x.sid === st.sid);
    if (!c) {
      // Conversa de outra janela: não é daqui. Aba fechada aqui (encerrando): não volta.
      if (st.wid === windowId && st.phase !== 'ended' && !closedSids.has(st.sid)) chats.value = [...chats.value, makeChat(st)];
      return;
    }
    if (st.phase === 'ended') return;
    noteActivity(c.state.peek(), st);
    c.state.value = st;
    if (st.phase === 'running') cancelDoneNotification(st.sid);
    if (st.phase === 'idle') ensureAutoCompact(c);
  });
  rpc.on('session.msg', ({ sid, seq, msg }) => {
    const c = chats.value.find((x) => x.sid === sid);
    if (!c) return;
    cancelDoneNotification(sid);
    if (!c.loaded) {
      // Aba ainda não aberta: não guarda nada (ao abrir, histórico + snapshot do servidor trazem
      // tudo). Só enquanto ela está carregando é que o que chega precisa esperar na fila.
      if (c.loading.value) c.queued.push({ seq, msg });
      else if (msg.type === 'result') explorerRefresh.value++;
      return;
    }
    if (seq <= c.lastSeq) return;
    c.lastSeq = seq;
    c.model.apply(msg);
    onModelEvent(c, msg);
    bump(c);
  });
  rpc.on('session.attention', ({ sid, kind, error }) => {
    const c = chats.value.find((x) => x.sid === sid);
    if (!c) return;
    const visible = activeChatId.value === sid && document.visibilityState === 'visible' && document.hasFocus();
    if (kind === 'permission') {
      cancelDoneNotification(sid);
      c.attention.value = 'permission';
      if (!visible) notify(c, 'Claude pede permissão');
    } else if (kind === 'done') {
      cancelDoneNotification(sid);
      // Aguarda 3,5 s: se o Claude estiver em loop com subagentes (SendMessage / Task),
      // o próximo passo começa logo em seguida e cancela o aviso falso de "terminou".
      // (O "não visto" da aba e do título não passa por aqui: o servidor marca e guarda.)
      const timer = setTimeout(() => {
        doneTimers.delete(sid);
        const cur = chats.value.find((x) => x.sid === sid);
        if (!cur) return;
        const isRunning = cur.state.value.phase === 'running' || cur.model.running;
        if (isRunning) return; // ainda está trabalhando!
        const isVis = activeChatId.value === sid && document.visibilityState === 'visible' && document.hasFocus();
        if (!isVis) notify(cur, error ? 'Claude terminou com erro' : 'Claude terminou');
      }, 3500);
      doneTimers.set(sid, timer);
    }
  });
  rpc.on('term.data', ({ id, data, pos }: { id: string; data: string; pos?: number }) => {
    const set = termListeners.get(id);
    if (set) for (const fn of set) fn(data, pos);
  });
  // Terminal aberto pelo servidor para o Claude (modo Terminal ao Vivo).
  rpc.on('term.opened', (t: TerminalTabInfo) => {
    if (t.wid === windowId) addTerminalTab(t);
  });
  rpc.on('term.update', (t: TerminalTabInfo) => {
    if (terminalTabs.value.some((x) => x.id === t.id)) terminalTabs.value = terminalTabs.value.map((x) => (x.id === t.id ? { ...x, ...t } : x));
  });
  // O Claude vai digitar: mostra o painel e a aba do terminal dele.
  rpc.on('term.reveal', ({ id, wid }: { id: string; sid: string; wid?: string }) => {
    if (wid === windowId) void showTerminal(id);
  });
  rpc.on('term.exit', ({ id }: { id: string; exitCode: number }) => {
    const list = terminalTabs.value.filter((t) => t.id !== id);
    terminalTabs.value = list;
    if (activeTerminalId.value === id) {
      activeTerminalId.value = list[list.length - 1]?.id ?? null;
    }
    if (list.length === 0) {
      terminalVisible.value = false;
    }
  });
}

/** Reações da interface a mensagens (recarregar arquivos editados pelo Claude etc.). */
function onModelEvent(c: ChatTab, msg: any) {
  if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b?.type !== 'tool_result' || b.is_error) continue;
      const t = c.model.tools.get(b.tool_use_id);
      const p = t?.input?.file_path ?? t?.input?.notebook_path;
      if (t && p && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t.name)) fileChangedExternally(c.state.value.hostId, p);
    }
  }
  if (msg.type === 'result') {
    explorerRefresh.value++;
    if (c.model.pendingCount === 0 && c.attention.value === 'permission') c.attention.value = null;
  }
}

const doneTimers = new Map<string, any>();
const activeNotifications = new Map<string, Notification>();

function cancelDoneNotification(sid: string) {
  const t = doneTimers.get(sid);
  if (t) {
    clearTimeout(t);
    doneTimers.delete(sid);
  }
  const n = activeNotifications.get(sid);
  if (n) {
    try {
      n.close();
    } catch {}
    activeNotifications.delete(sid);
  }
}

function notify(c: ChatTab, title: string) {
  if (!settings.value.notifications || !('Notification' in window)) return;
  const body = `${hostLabel(c.state.value.hostId)} · ${chatTitle(c)}`;
  const show = () => {
    const n = new Notification(title, { body, tag: `deck-${c.sid}`, silent: false });
    activeNotifications.set(c.sid, n);
    n.onclose = () => {
      if (activeNotifications.get(c.sid) === n) activeNotifications.delete(c.sid);
    };
    n.onclick = () => {
      window.focus();
      activateChat(c.sid);
      n.close();
    };
  };
  if (Notification.permission === 'granted') show();
  else if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => p === 'granted' && show());
}

// ------------------------------------------------------------------ conversas

export async function loadChat(c: ChatTab) {
  if (c.loaded || c.loading.value) return;
  c.loading.value = true;
  c.loadError.value = null;
  try {
    const st = c.state.value;
    if (st.sessionId) {
      try {
        const page = await rpc.call('history.load', { h: st.hostId, sessionId: st.sessionId, cwd: st.cwd }, 120_000);
        for (const line of page.lines) c.model.apply(line, { history: true });
        c.historyStart = page.start;
        c.historyFile = page.file;
        c.hasMore.value = page.start > 0;
      } catch (e) {
        if ((e as RpcError).code !== 'notfound') c.loadError.value = `Não consegui ler o histórico: ${errorText(e)}`;
      }
    }
    const snap = await rpc.call('sessions.snapshot', { sid: c.sid });
    c.state.value = snap.state;
    for (const m of snap.messages as { seq: number; msg: any }[]) {
      if (m.seq <= c.lastSeq) continue;
      c.lastSeq = m.seq;
      c.model.apply(m.msg, { replay: true });
    }
    for (const p of snap.pending ?? []) c.model.apply(p);
    for (const q of c.queued) {
      if (q.seq <= c.lastSeq) continue;
      c.lastSeq = q.seq;
      c.model.apply(q.msg, { replay: true });
    }
    c.queued = [];
    c.loaded = true;
    if (c.model.pendingCount) c.attention.value = 'permission';
  } catch (e) {
    c.loadError.value = errorText(e);
  } finally {
    c.loading.value = false;
    c.version.value++;
  }
  ensureAutoCompact(c);
}

/** Após reconectar ao servidor (mesma execução): busca o que chegou enquanto estava fora. */
async function resync(c: ChatTab) {
  const snap = await rpc.call('sessions.snapshot', { sid: c.sid });
  c.state.value = snap.state;
  for (const m of snap.messages as { seq: number; msg: any }[]) {
    if (m.seq <= c.lastSeq) continue;
    c.lastSeq = m.seq;
    c.model.apply(m.msg, { replay: true });
  }
  bump(c);
}

export async function loadEarlier(c: ChatTab) {
  if (!c.historyFile || !c.historyStart) return;
  const st = c.state.value;
  const page = await rpc.call('history.load', { h: st.hostId, file: c.historyFile, before: c.historyStart }, 120_000);
  const older = new ChatModel();
  for (const line of page.lines) older.apply(line, { history: true });
  c.model.prepend(older);
  c.historyStart = page.start;
  c.hasMore.value = page.start > 0;
  c.version.value++;
}

export function activateChat(sid: string) {
  const entered = activeChatId.peek() !== sid;
  activeChatId.value = sid;
  const c = chats.value.find((x) => x.sid === sid);
  if (c) {
    markSeen(c);
    if (entered) clearPendingOnOpen(c); // clicar na aba já ativa não é reabrir
    loadChat(c);
    ensureAutoCompact(c); // já carregada e agora à vista (a primeira vez cai no fim do `loadChat`)
  }
}

/**
 * Nova conversa (ou retomada do histórico). Se o servidor+pasta não é o desta janela, ela vai para
 * a janela daquele servidor+pasta (abrindo ou trazendo para a frente) e devolve `undefined`.
 */
export async function newChat(hostId: string, cwd: string, opts: { resume?: string; title?: string; replaceSid?: string } = {}): Promise<ChatTab | undefined> {
  if (!isThisWindow(hostId, cwd)) {
    await openHostWindow(hostId, cwd, opts.resume);
    return undefined;
  }
  let st: SessionState;
  try {
    st = await rpc.call('sessions.create', {
      hostId,
      cwd,
      resume: opts.resume,
      title: opts.title,
      permissionMode: settings.value.defaultPermissionMode,
      model: settings.value.defaultModel || undefined,
      start: !opts.resume,
    });
  } catch (e) {
    // O servidor sabe de uma janela desta pasta que esta aqui não conhecia (fechada ou aberta):
    // a conversa vai para lá, junto com as que já estavam nela.
    if ((e as RpcError).code === 'otherwindow') {
      await openHostWindow(hostId, cwd, opts.resume);
      return undefined;
    }
    throw e;
  }
  let c = chats.value.find((x) => x.sid === st.sid);
  if (!c) {
    c = makeChat(st);
    const list = [...chats.value];
    const idx = opts.replaceSid ? list.findIndex((x) => x.sid === opts.replaceSid) : -1;
    if (idx >= 0) list.splice(idx + 1, 0, c);
    else list.push(c);
    chats.value = list;
  }
  if (opts.replaceSid) await closeChat(opts.replaceSid, true);
  activeChatId.value = c.sid;
  if (opts.resume) clearPendingOnOpen(c); // retomada do Histórico bem-sucedida
  sidebarView.value = sidebarView.value === 'servers' ? 'explorer' : sidebarView.value;
  loadChat(c);
  // Lembra a pasta nos recentes do servidor.
  hosts.value = hosts.value.map((h) => (h.id === hostId ? { ...h, recentFolders: [cwd, ...h.recentFolders.filter((f) => f !== cwd)].slice(0, 15) } : h));
  return c;
}

/** Aba desta janela com a conversa do CLI `sessionId` naquele servidor. */
function tabOfConversation(hostId: string, sessionId: string): ChatTab | undefined {
  return chats.value.find((c) => c.state.value.sessionId === sessionId && c.state.value.hostId === hostId);
}

/** Retomadas em andamento: cliques repetidos (duplo clique, histórico + atalho) esperam a mesma. */
const opening = new Map<string, Promise<ChatTab | undefined>>();

/**
 * Abre uma conversa do histórico. Uma conversa nunca fica em duas abas: se já está aberta nesta
 * janela, só ativa a aba; se está em outra janela, traz aquela janela para a frente na aba dela.
 */
export function openHistoryChat(hostId: string, cwd: string, sessionId: string, title?: string): Promise<ChatTab | undefined> {
  const key = `${hostId}\n${sessionId}`;
  const busy = opening.get(key);
  if (busy) return busy;
  const p = openHistoryChatNow(hostId, cwd, sessionId, title).finally(() => opening.delete(key));
  opening.set(key, p);
  return p;
}

async function openHistoryChatNow(hostId: string, cwd: string, sessionId: string, title?: string): Promise<ChatTab | undefined> {
  const closing = closingConversations.get(`${hostId}\n${sessionId}`);
  if (closing) await closing;
  const existing = tabOfConversation(hostId, sessionId);
  if (existing) {
    const wasActive = activeChatId.peek() === existing.sid;
    activateChat(existing.sid);
    if (wasActive) clearPendingOnOpen(existing); // abrir explicitamente pelo Histórico
    window.focus();
    return existing;
  }
  // Aberta em outra janela (ou numa aba que esta ainda não mostra)?
  const elsewhere = await findOpenConversation(hostId, sessionId);
  if (elsewhere && elsewhere.wid === windowId) return showOwnConversation(elsewhere);
  if (elsewhere && (await goToConversationWindow(elsewhere, sessionId))) return undefined;
  try {
    return await newChat(hostId, cwd, { resume: sessionId, title });
  } catch (e) {
    if ((e as RpcError).code !== 'alreadyopen') throw e;
    // Abriram em outra janela entre a consulta e agora: vai até ela.
    const now = await findOpenConversation(hostId, sessionId);
    if (now && now.wid === windowId) return showOwnConversation(now);
    if (now && (await goToConversationWindow(now, sessionId))) return undefined;
    throw e;
  }
}

/** A conversa aberta em alguma aba de qualquer janela (o servidor sabe de todas). */
async function findOpenConversation(hostId: string, sessionId: string): Promise<SessionState | undefined> {
  try {
    const all = await rpc.call<SessionState[]>('sessions.list');
    return all.find((s) => s.hostId === hostId && s.sessionId === sessionId && s.phase !== 'ended' && !closedSids.has(s.sid));
  } catch {
    return undefined;
  }
}

/** A conversa é desta janela, mas a aba ainda não apareceu (evento a caminho): mostra e ativa. */
function showOwnConversation(st: SessionState): ChatTab {
  let c = chats.value.find((x) => x.sid === st.sid);
  if (!c) {
    c = makeChat(st);
    chats.value = [...chats.value, c];
  }
  const wasActive = activeChatId.peek() === c.sid;
  activateChat(c.sid);
  if (wasActive) clearPendingOnOpen(c);
  window.focus();
  return c;
}

/**
 * Traz para a frente a janela da pasta da conversa, que ativa a aba dela (ou reabre a janela, se
 * estiver fechada, com as abas de antes). Mesma pasta desta janela (aba presa numa janela antiga
 * fechada): devolve false e o servidor passa a aba para cá ao retomar.
 */
async function goToConversationWindow(st: SessionState, sessionId: string): Promise<boolean> {
  if (windowContext.value && isThisWindow(st.hostId, st.cwd)) return false;
  await openHostWindow(st.hostId, st.cwd, sessionId);
  return true;
}

export async function closeChat(sid: string, silent = false) {
  const c = chats.value.find((x) => x.sid === sid);
  if (!c) return;
  const st = c.state.value;
  if (!silent && (st.phase === 'running' || c.model.running || c.model.pendingCount)) {
    const ok = await confirmDialog('Fechar conversa em andamento?', 'O Claude ainda está trabalhando nesta conversa. Fechar interrompe o trabalho (o histórico fica salvo).', 'Fechar', true);
    if (!ok) return;
  }
  closedSids.add(sid);
  const idx = chats.value.findIndex((x) => x.sid === sid);
  const list = chats.value.filter((x) => x.sid !== sid);
  chats.value = list;
  if (activeChatId.value === sid) {
    const next = list[Math.min(idx, list.length - 1)];
    activeChatId.value = next?.sid ?? null;
    if (next) {
      clearPendingOnOpen(next);
      loadChat(next);
    }
  }
  const key = st.sessionId ? `${st.hostId}\n${st.sessionId}` : undefined;
  const done = rpc.call('sessions.close', { sid }).then(
    () => { closedSids.delete(sid); },
    (e) => {
      closedSids.delete(sid);
      toast(`Não consegui fechar a conversa: ${errorText(e)}`, 'error', 8000);
      void rpc.call<SessionState[]>('sessions.list').then((all) => {
        const live = all.find((s) => s.sid === sid && s.phase !== 'ended');
        if (live && live.wid === windowId && !chats.value.some((x) => x.sid === sid)) showOwnConversation(live);
      }).catch(() => {});
    },
  );
  if (key) {
    closingConversations.set(key, done);
    void done.then(() => { if (closingConversations.get(key) === done) closingConversations.delete(key); });
  }
}

export function moveChat(sid: string, toIndex: number) {
  const list = [...chats.value];
  const from = list.findIndex((c) => c.sid === sid);
  if (from < 0) return;
  const [c] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, c);
  chats.value = list;
}

/**
 * Quando esta interface viu cada conversa começar/terminar um turno. Só serve contra um servidor
 * antigo, que ainda não manda `lastActivityAt` (a interface nova abre sem esperar a troca do servidor).
 */
const observedActivity = new Map<string, number>();

function noteActivity(prev: SessionState, next: SessionState) {
  const working = (s: SessionState) => s.phase === 'running' || s.phase === 'starting' || s.phase === 'reconnecting';
  if (working(prev) !== working(next) || (next.unseen && next.unseen !== prev.unseen)) observedActivity.set(next.sid, Date.now());
}

/**
 * Reordena as abas desta janela: 1) terminou e não foi vista, 2) esperando você, 3) trabalhando,
 * 4) paradas, da atividade mais recente para a mais antiga (regras em `lib/tabOrder.ts`).
 * Devolve `false` quando a ordem já estava certa (nada é regravado).
 */
export function reorderChatsByActivity(knownPending?: ReadonlySet<string>): boolean {
  const cur = chats.peek();
  const ids = new Set(cur.map((c) => c.sid));
  for (const sid of observedActivity.keys()) if (!ids.has(sid)) observedActivity.delete(sid);
  const next = sortTabs(cur, (c) => {
    const st = c.state.peek();
    return {
      attention: c.attention.peek(),
      // Aba ainda não aberta nesta janela: o modelo dela está vazio, o pedido pendente vem da sondagem.
      pendingCount: Math.max(c.model.pendingCount, knownPending?.has(c.sid) ? 1 : 0),
      phase: st.phase,
      modelRunning: c.model.running,
      unseen: st.unseen,
      manualPending: isPending(st.hostId, st.sessionId),
      lastActivityAt: lastActivityOf(st, observedActivity.get(c.sid)),
    };
  });
  if (next.every((c, i) => c === cur[i])) return false;
  chats.value = next;
  tabOrderStamp.value++;
  return true;
}

/**
 * Primeira abertura da janela: organiza uma vez, logo. Ao abrir, só a conversa ativa é carregada; as
 * outras não têm o modelo montado, então um pedido de permissão delas não aparece na interface e a aba
 * pareceria "trabalhando". Por isso, antes de ordenar, lê o estado pendente das que estão trabalhando
 * (só uma conversa trabalhando pode estar esperando resposta; as paradas nem são consultadas).
 * Não espera mais que alguns segundos: sem resposta, a aba fica como "trabalhando" até o próximo ciclo.
 */
async function organizeOnOpen(activeLoad: Promise<unknown>) {
  const pending = new Set<string>();
  const working = new Set(['running', 'reconnecting', 'starting']);
  const probes = chats
    .peek()
    .filter((c) => !c.loaded && !c.loading.peek() && working.has(c.state.peek().phase))
    .map(async (c) => {
      try {
        const snap = await rpc.call('sessions.snapshot', { sid: c.sid }, 8_000);
        if (snap?.pending?.length) pending.add(c.sid);
      } catch {
        /* sem resposta (servidor ocupado ou antigo): segue como "trabalhando" */
      }
    });
  await Promise.race([Promise.all([activeLoad, ...probes]), new Promise((r) => setTimeout(r, 4_000))]);
  // A aba também passa a mostrar o sino (como mostraria se o pedido tivesse chegado com a janela aberta):
  // sem isso, ela subiria para o grupo "pede resposta" com o ícone de "trabalhando".
  for (const c of chats.peek()) if (pending.has(c.sid) && !c.attention.peek()) c.attention.value = 'permission';
  reorderChatsByActivity(pending);
}

// Um arrasto que nunca termina (a aba foi fechada no meio dele e o `dragend` se perdeu) não pode
// desligar a organização automática para sempre.
effect(() => {
  if (!tabDragging.value) return;
  const t = setTimeout(() => (tabDragging.value = false), 120_000);
  return () => clearTimeout(t);
});

/** Atalho/paleta: organiza agora, sem esperar o próximo ciclo. */
export function sortChatsNow() {
  if (chats.peek().length < 2) return toast('Há menos de duas abas para organizar.', 'info', 2500);
  toast(reorderChatsByActivity() ? 'Abas organizadas.' : 'As abas já estão na ordem.', 'info', 2500);
}

/** Contexto do arquivo aberto no editor, no formato que a extensão do VS Code usa. */
export function editorContextFor(c: ChatTab, selection: { from: number; to: number; text: string; fromLine: number; toLine: number } | null, includeFile: boolean): string {
  const f = activeFile.value;
  if (!f || f.hostId !== c.state.value.hostId) return '';
  if (selection && selection.text.trim()) {
    return `<ide_selection>The user selected the lines ${selection.fromLine} to ${selection.toLine} from ${f.path}:\n${selection.text}\n\nThis may or may not be related to the current task.</ide_selection>\n`;
  }
  if (includeFile) return `<ide_opened_file>The user opened the file ${f.path} in the IDE. This may or may not be related to the current task.</ide_opened_file>\n`;
  return '';
}

/**
 * Liga/desliga o modo Terminal ao Vivo da conversa. Ao ligar, o servidor liga a conversa a um
 * terminal (o ativo, se for do mesmo servidor e livre; senão abre um na pasta da conversa) e o
 * painel aparece nele. Vale a partir da próxima mensagem, sem reiniciar o Claude.
 */
export async function toggleChatExecutionMode(c: ChatTab) {
  const st = c.state.value;
  const next = st.executionMode === 'terminal' ? 'silent' : 'terminal';
  const active = terminalTabs.value.find((t) => t.id === activeTerminalId.value);
  const prefer = active && active.hostId === st.hostId && (!active.sid || active.sid === c.sid) ? active.id : undefined;
  try {
    const r = await rpc.call<{ terminalId: string | null }>('sessions.setExecutionMode', { sid: c.sid, mode: next, terminalId: prefer }, 60_000);
    if (next === 'terminal') {
      if (r.terminalId) await showTerminal(r.terminalId);
      toast('Terminal ao Vivo: o Claude vai digitar os comandos neste terminal e ler a saída dele.', 'info', 4000);
    } else {
      toast('Silencioso: o Claude volta a rodar os comandos em segundo plano (Bash).', 'info', 3000);
    }
  } catch (e) {
    toast(errorText(e), 'error', 8000);
  }
}

export async function sendMessage(c: ChatTab, text: string, images: ImageData[], context = '') {
  const trimmed = text.trim();
  if (!trimmed && !images.length) return;
  // Comandos tratados pela própria interface.
  if (/^\/(clear|new)\s*$/.test(trimmed)) {
    const st = c.state.value;
    await newChat(st.hostId, st.cwd, { replaceSid: c.sid });
    return;
  }
  const uuid = crypto.randomUUID();
  const content: any[] = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }));
  // No modo Terminal ao Vivo, o painel já fica à vista (o aviso ao Claude é do servidor).
  const tid = c.state.value.terminalId;
  if (isLiveTerminal(c) && tid) void showTerminal(tid);
  content.push({ type: 'text', text: context + trimmed });
  c.model.addPendingUser(uuid, trimmed, images);
  c.attention.value = null;
  markSeen(c);
  c.version.value++;
  try {
    await rpc.call('sessions.send', { sid: c.sid, content, uuid }, 180_000);
  } catch (e) {
    c.model.failPendingUser(uuid, errorText(e));
    c.version.value++;
    toast(errorText(e), 'error', 8000);
  }
}

export async function respondPermission(c: ChatTab, requestId: string, response: any, label?: string) {
  c.model.answered(requestId, response.behavior === 'allow' ? 'allowed' : 'denied', label);
  if (!c.model.pendingCount && c.attention.value === 'permission') c.attention.value = null;
  c.version.value++;
  try {
    await rpc.call('sessions.respond', { sid: c.sid, requestId, response });
  } catch (e) {
    toast(`Falha ao responder: ${errorText(e)}`, 'error');
  }
}

export async function interruptChat(c: ChatTab) {
  try {
    await rpc.call('sessions.interrupt', { sid: c.sid });
    if (isLiveTerminal(c)) toast('Claude interrompido. O comando no terminal pode continuar; use Ctrl+C nele para parar.');
  } catch (e) {
    toast(`Não consegui interromper: ${errorText(e)}`, 'error');
  }
}

export async function setChatMode(c: ChatTab, mode: PermissionMode) {
  try {
    await rpc.call('sessions.setMode', { sid: c.sid, mode });
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export async function setChatModel(c: ChatTab, model: string | null) {
  try {
    await rpc.call('sessions.setModel', { sid: c.sid, model });
    toast(`Modelo: ${model || 'padrão do servidor'}`, 'success', 2500);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export async function setChatEffort(c: ChatTab, effort: EffortLevel | null) {
  try {
    await rpc.call('sessions.setEffort', { sid: c.sid, effort }, 75_000);
    toast(`Esforço: ${effort ?? 'padrão do Claude Code'}`, 'success', 3000);
  } catch (e) {
    toast(`Não alterei o esforço: ${errorText(e)}`, 'error', 8000);
  }
}

// ------------------------------------------------------------------ arquivos

const EXT_KIND: Record<string, ViewerKind> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  svg: 'svg',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  ogv: 'video',
  wav: 'audio',
  mp3: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  weba: 'audio',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  ndjson: 'json',
  geojson: 'json',
  webmanifest: 'json',
  ipynb: 'json',
  pdf: 'pdf',
  csv: 'csv',
  tsv: 'csv',
};

export function viewerKindFor(path: string): ViewerKind {
  const name = basename(path).toLowerCase();
  if (name === '.claude.json' || name.endsWith('.jsonl')) return 'json';
  return EXT_KIND[extname(path)] ?? 'text';
}

/** Visualizadores que não precisam do conteúdo como texto (usam o fluxo HTTP). */
export function isStreamedKind(k: ViewerKind) {
  return k === 'image' || k === 'video' || k === 'audio' || k === 'pdf';
}

export function rawUrl(hostId: string, path: string, download = false) {
  return `/api/raw?h=${encodeURIComponent(hostId)}&p=${encodeURIComponent(path)}${download ? '&dl=1' : ''}`;
}

export function fileId(hostId: string, path: string) {
  return `${hostId}::${path}`;
}

export async function openFile(hostId: string, path: string, opts: { activate?: boolean; line?: number; mode?: 'view' | 'edit' } = {}) {
  const id = fileId(hostId, path);
  let f = files.value.find((x) => x.id === id);
  if (!f) {
    const kind = viewerKindFor(path);
    f = {
      id,
      hostId,
      path,
      name: basename(path),
      kind,
      mode: signal(opts.mode ?? (kind === 'text' ? 'edit' : 'view')),
      content: '',
      savedContent: '',
      mtime: 0,
      size: 0,
      truncated: false,
      binary: false,
      dirty: signal(false),
      loading: signal(true),
      error: signal(null),
      changedOnDisk: signal(false),
      reloadKey: signal(0),
      pendingLine: opts.line,
    };
    files.value = [...files.value, f];
    loadFile(f);
  } else if (opts.line) {
    f.pendingLine = opts.line;
    f.reloadKey.value++;
  }
  if (opts.activate !== false) {
    activeFileId.value = id;
    editorVisible.value = true;
  }
  return f;
}

export async function loadFile(f: FileTab) {
  const contentBefore = f.content;
  f.loading.value = true;
  f.error.value = null;
  try {
    if (isStreamedKind(f.kind)) {
      const st = await rpc.call('fs.stat', { h: f.hostId, p: f.path });
      f.size = st.size;
      f.mtime = st.mtime;
    } else {
      const r = await rpc.call('fs.read', { h: f.hostId, p: f.path }, 180_000);
      if (f.dirty.peek() || f.content !== contentBefore) { f.changedOnDisk.value = true; return; }
      f.size = r.size;
      f.mtime = r.mtime;
      f.truncated = r.truncated;
      f.binary = r.binary;
      if (r.binary) {
        f.content = '';
        f.savedContent = '';
        if (f.kind === 'text' || f.kind === 'json' || f.kind === 'csv' || f.kind === 'markdown') f.kind = 'binary';
      } else {
        f.content = r.content;
        f.savedContent = r.content;
      }
      f.editorState = undefined;
      f.dirty.value = false;
    }
    f.changedOnDisk.value = false;
  } catch (e) {
    f.error.value = errorText(e);
  } finally {
    f.loading.value = false;
    f.reloadKey.value++;
  }
}

export async function saveFile(f: FileTab, force = false): Promise<boolean> {
  if (isFilePublishing(f.hostId, f.path)) { toast('O arquivo está recebendo uma cópia. Espere a publicação terminar.', 'info'); return false; }
  if (f.truncated) {
    toast('Arquivo grande demais: aberto só em parte, não dá para salvar.', 'error');
    return false;
  }
  try {
    const sentContent = f.content;
    const st = await rpc.call('fs.write', {
      h: f.hostId,
      p: f.path,
      content: sentContent,
      expectedMtime: force ? undefined : f.mtime,
      // Servidores (SFTP) só guardam a hora em segundos: o tamanho ajuda a notar mudança no mesmo segundo.
      expectedSize: force || !f.mtime ? undefined : f.size,
    });
    f.mtime = st.mtime;
    f.size = st.size;
    f.savedContent = sentContent;
    f.dirty.value = f.content !== sentContent;
    f.changedOnDisk.value = false;
    toast(`Salvo: ${f.name}`, 'success', 1800);
    return true;
  } catch (e) {
    if ((e as RpcError).code === 'conflict') {
      const ok = await confirmDialog('O arquivo mudou no disco', `${f.name} foi alterado por outro programa (ou pelo Claude) depois que você abriu. Sobrescrever com a sua versão?`, 'Sobrescrever', true);
      if (ok) return saveFile(f, true);
      return false;
    }
    toast(`Não salvou: ${errorText(e)}`, 'error', 8000);
    return false;
  }
}

export async function closeFile(id: string) {
  const f = files.value.find((x) => x.id === id);
  if (!f) return;
  if (f.dirty.value) {
    const ok = await confirmDialog(`Descartar alterações em ${f.name}?`, 'As alterações não salvas serão perdidas.', 'Descartar', true);
    if (!ok) return;
  }
  const idx = files.value.findIndex((x) => x.id === id);
  const list = files.value.filter((x) => x.id !== id);
  files.value = list;
  if (activeFileId.value === id) activeFileId.value = list[Math.min(idx, list.length - 1)]?.id ?? null;
  if (!list.length) editorVisible.value = false;
}

/** O Claude (ou outro programa) mudou um arquivo aberto. */
export function fileChangedExternally(hostId: string, path: string) {
  const plat = platformOf(hostId);
  const norm = (p: string) => (plat === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p);
  for (const f of files.value) {
    if (f.hostId !== hostId || norm(f.path) !== norm(path)) continue;
    if (f.dirty.value) f.changedOnDisk.value = true;
    else loadFile(f);
  }
}

export function relPath(hostId: string, p: string): string {
  const ws = workspace.value;
  if (ws && ws.hostId === hostId) {
    const r = relativeTo(platformOf(hostId), ws.root, p);
    if (r !== null && r !== '') return r;
  }
  return p;
}

export function resolveInCwd(hostId: string, cwd: string, p: string): string {
  const plat = platformOf(hostId);
  if (plat === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/')) return p;
  const sep = plat === 'win32' ? '\\' : '/';
  return cwd.replace(/[\\/]+$/, '') + sep + p.replace(/^\.[\\/]/, '').replace(/\//g, sep);
}

export { dirname as pathDirname };

// ------------------------------------------------------------------ servidores

export async function connectHost(id: string, force = false) {
  try {
    return await rpc.call<HostStatus>('hosts.connect', { id, force }, 180_000);
  } catch (e) {
    toast(`${id}: ${errorText(e)}`, 'error', 9000);
    throw e;
  }
}

export async function toggleFavorite(id: string) {
  const h = hostInfo(id);
  if (!h) return;
  await rpc.call('hosts.favorite', { id, favorite: !h.favorite });
  hosts.value = hosts.value.map((x) => (x.id === id ? { ...x, favorite: !x.favorite } : x));
}

/** Servidor desta janela (o do contexto; sem contexto ainda, o do explorador ou este computador). */
export function windowHostId(): string {
  return windowContext.value?.hostId ?? workspace.value?.hostId ?? LOCAL_HOST_ID;
}

/**
 * Mostra uma pasta no explorador, sem mudar a pasta das conversas. Só pastas do servidor desta
 * janela: os arquivos de outro servidor ficam na janela dele (nada de conexão SSH alheia aqui).
 */
export async function openWorkspace(hostId: string, root: string) {
  const ctx = windowContext.value;
  if (ctx && ctx.hostId !== hostId) {
    toast(`Esta janela é de ${hostLabel(ctx.hostId)}. Para ver os arquivos de ${hostLabel(hostId)}, abra a janela dele na aba Servidores.`, 'info', 7000);
    return;
  }
  workspace.value = { hostId, root };
  sidebarView.value = 'explorer';
  sidebarVisible.value = true;
  rpc.call('hosts.addRecent', { id: hostId, folder: root }).catch(() => {});
  hosts.value = hosts.value.map((h) => (h.id === hostId ? { ...h, recentFolders: [root, ...h.recentFolders.filter((f) => f !== root)].slice(0, 15) } : h));
}

/** Nova conversa no servidor, na pasta dada ou (sem ela) na pasta pessoal do servidor. */
export async function openChatIn(hostId: string, folder?: string): Promise<boolean> {
  let cwd = folder;
  if (!cwd) {
    try {
      const st = hostId === LOCAL_HOST_ID ? null : await connectHost(hostId); // já avisa se falhar
      cwd = st?.home ?? homeOf(hostId);
    } catch {
      return false;
    }
  }
  if (!cwd) return false;
  try {
    await newChat(hostId, cwd);
    return true;
  } catch (e) {
    toast(errorText(e), 'error', 8000);
    return false;
  }
}

/**
 * Vai para a janela do servidor/pasta: se já está aberta, o servidor a traz para a frente; senão
 * abre (ou reabre, com as abas de antes). É a própria janela? Só retoma o histórico, se pedido.
 */
export async function openHostWindow(hostId: string, folder?: string, resume?: string) {
  if (folder && windowContext.value && isThisWindow(hostId, folder)) {
    if (resume) await openHistoryChat(hostId, folder, resume);
    window.focus();
    return;
  }
  try {
    const info = await rpc.call<{ windowRestore?: boolean }>('app.info');
    if (info.windowRestore !== true)
      throw new Error('O servidor ainda não restaura conversas por pasta. Espere as conversas terminarem e abra pelo atalho para atualizá-lo.');
    const r = await rpc.call<{ launched?: boolean; focused?: boolean; pending?: boolean; wid?: string }>('window.open', { hostId, folder, resume });
    if (r?.wid && r.focused === false) toast(`A janela de ${hostLabel(hostId)} já está aberta. Procure-a na barra de tarefas; este navegador não permitiu trazê-la para a frente automaticamente.`, 'info', 6000);
  } catch (e) {
    toast(
      (e as RpcError).code === 'nomethod'
        ? 'O servidor do Claude Deck é de uma versão antiga. Feche as janelas, rode "npm run app:stop" e abra de novo pelo atalho.'
        : `Não abri a janela nova: ${errorText(e)}`,
      'error',
      8000,
    );
  }
}

/**
 * Janela aberta pela aba Servidores: a URL traz `?open=` com o servidor/pasta da primeira conversa.
 * Tira o parâmetro da URL na hora, para recarregar (F5) não abrir outra conversa.
 */
function consumeOpenTarget(raw: string | null, hasSavedChats: boolean) {
  if (raw === null) return;
  const url = new URL(location.href);
  url.searchParams.delete('open');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  const t = decodeOpen(raw);
  if (!t) return;
  // Veio do histórico: retoma aquela conversa aqui (se já está numa aba, só a ativa).
  if (t.r && t.f) {
    void openHistoryChat(t.h, t.f, t.r);
    return;
  }
  if (!hasSavedChats) void openChatIn(t.h, t.f);
}

// ------------------------------------------------------------------ terminal

/** `pos` = posição do pedaço desde a abertura do terminal (para não repetir o que veio no replay). */
type TermDataListener = (data: string, pos?: number) => void;
const termListeners = new Map<string, Set<TermDataListener>>();
const terminalSyncListeners = new Set<() => void>();
export function onTerminalSync(fn: () => void) {
  terminalSyncListeners.add(fn);
  return () => { terminalSyncListeners.delete(fn); };
}

function addTerminalTab(t: TerminalTabInfo) {
  if (!terminalTabs.value.some((x) => x.id === t.id)) terminalTabs.value = [...terminalTabs.value, t];
}

/** Mostra o painel na aba do terminal (buscando-o no servidor se esta janela ainda não o conhece). */
export async function showTerminal(id: string) {
  if (!terminalTabs.value.some((t) => t.id === id)) {
    const list = await rpc.call<TerminalTabInfo[]>('term.list').catch(() => [] as TerminalTabInfo[]);
    const t = list.find((x) => x.id === id);
    if (!t) return;
    addTerminalTab(t);
  }
  activeTerminalId.value = id;
  terminalVisible.value = true;
}

/** Depois de conectar (ou reconectar): as abas de terminal que continuam vivas no servidor. */
async function syncTerminals() {
  const list = await rpc.call<TerminalTabInfo[]>('term.list').catch(() => null);
  if (!list) return;
  terminalTabs.value = list;
  if (!list.some((t) => t.id === activeTerminalId.value)) activeTerminalId.value = list[list.length - 1]?.id ?? null;
  if (!list.length) terminalVisible.value = false;
  for (const fn of terminalSyncListeners) fn();
}

export function onTerminalData(id: string, fn: TermDataListener) {
  let s = termListeners.get(id);
  if (!s) termListeners.set(id, (s = new Set()));
  s.add(fn);
  return () => {
    s?.delete(fn);
    if (s?.size === 0) termListeners.delete(id);
  };
}

export async function openTerminal(hostId?: string, cwd?: string) {
  const targetHost = hostId ?? activeChat.value?.state.value.hostId ?? workspace.value?.hostId ?? 'local';
  const targetCwd = cwd ?? activeChat.value?.state.value.cwd ?? workspace.value?.root ?? '';
  try {
    const term = await rpc.call<TerminalTabInfo>('term.open', { hostId: targetHost, cwd: targetCwd });
    terminalTabs.value = [...terminalTabs.value, term];
    activeTerminalId.value = term.id;
    terminalVisible.value = true;
    return term;
  } catch (err: any) {
    toast(`Falha ao abrir terminal: ${errorText(err)}`, 'error');
    throw err;
  }
}

export async function closeTerminal(id: string) {
  try {
    await rpc.call('term.close', { id });
  } catch {}
  const list = terminalTabs.value.filter((t) => t.id !== id);
  terminalTabs.value = list;
  if (activeTerminalId.value === id) {
    activeTerminalId.value = list[list.length - 1]?.id ?? null;
  }
  if (list.length === 0) {
    terminalVisible.value = false;
  }
}

export function toggleTerminal() {
  terminalVisible.value = !terminalVisible.value;
  if (terminalVisible.value && terminalTabs.value.length === 0) {
    openTerminal().catch(() => {});
  }
}

// ------------------------------------------------------------------ configurações e tema

export async function updateSettings(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch };
  applyTheme();
  try {
    settings.value = await rpc.call('settings.set', patch);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export function applyTheme() {
  const s = settings.value;
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.style.setProperty('--ui-font-size', `${s.uiFontSize}px`);
  root.style.setProperty('--editor-font-size', `${s.editorFontSize}px`);
  root.style.setProperty('--chat-font-size', `${s.chatFontSize}px`);
}

// Avisa antes de fechar a janela com arquivos não salvos.
window.addEventListener('beforeunload', (e) => {
  if (files.value.some((f) => f.dirty.value)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

export { dirname };
export { LOCAL_HOST_ID };
