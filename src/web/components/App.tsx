// Layout principal (estilo VS Code): barra de atividades | barra lateral | conversas | arquivos.
import { useEffect } from 'preact/hooks';
import {
  activeChat,
  activateChat,
  activeChatId,
  activeFile,
  chats,
  closeChat,
  closeFile,
  commandPalette,
  editorVisible,
  editorWidth,
  files,
  newChat,
  newChatPicker,
  pendingCountFor,
  windowContext,
  workspace,
  quickOpen,
  ready,
  renamingSid,
  saveFile,
  sidebarView,
  sidebarVisible,
  sidebarWidth,
  type SidebarView,
  authPrompts,
  settings,
  sortChatsNow,
  terminalHeight,
  terminalVisible,
  terminalWidth,
  toggleTerminal,
} from '../lib/state';
import { wsConnected, wsEverConnected } from '../lib/rpc';
import { Icon } from './icons';
import { Sash } from './Sash';
import { Explorer, FolderBrowser, installWindowDropGuard } from './Explorer';
import { SearchView } from './SearchView';
import { Servers, AddHostDialog } from './Servers';
import { History } from './History';
import { SettingsView } from './SettingsView';
import { ChatTabs } from './ChatTabs';
import { Chat, Lightbox, Welcome } from './Chat';
import { EditorPanel } from './EditorPanel';
import { TerminalPanel } from './TerminalPanel';
import { StatusBar } from './StatusBar';
import { FileCopyPanel } from './FileCopyPanel';
import { AttentionMenu } from './AttentionMenu';
import { ContextMenuHost } from './ContextMenu';
import { AuthPromptDialog, GenericDialogs, Toasts } from './Dialogs';
import { CommandPalette, NewChatPicker, QuickOpen } from './Pickers';

const VIEWS: { id: SidebarView; icon: string; title: string }[] = [
  { id: 'explorer', icon: 'files', title: 'Explorador (Ctrl+Shift+E)' },
  { id: 'search', icon: 'search', title: 'Buscar em arquivos (Ctrl+Shift+F)' },
  { id: 'servers', icon: 'remote-explorer', title: 'Servidores' },
  { id: 'history', icon: 'history', title: 'Histórico de conversas (Ctrl+Shift+H)' },
];

const TITLES: Record<SidebarView, string> = {
  explorer: 'Explorador',
  search: 'Buscar em arquivos',
  servers: 'Servidores SSH',
  history: 'Histórico de conversas',
  settings: 'Configurações',
};

function ActivityBar() {
  const waiting = chats.value.filter((c) => c.attention.value === 'permission').length;
  const pending = pendingCountFor(windowContext.value?.hostId ?? workspace.value?.hostId ?? 'local');
  const pick = (v: SidebarView) => {
    if (sidebarView.value === v && sidebarVisible.value) sidebarVisible.value = false;
    else {
      sidebarView.value = v;
      sidebarVisible.value = true;
    }
  };
  return (
    <div class="activitybar">
      {VIEWS.map((v) => (
        <button key={v.id} class={`act-btn${sidebarVisible.value && sidebarView.value === v.id ? ' active' : ''}`} title={v.id === 'history' && pending ? `${v.title} · ${pending} pendente(s)` : v.title} onClick={() => pick(v.id)}>
          <Icon name={v.icon} />
          {v.id === 'history' && pending > 0 && <span class="act-badge pending">{pending}</span>}
        </button>
      ))}
      <button class="act-btn" title="Nova conversa (Ctrl+Shift+N)" onClick={() => (newChatPicker.value = {})}>
        <Icon name="comment-discussion" />
        {waiting > 0 && <span class="act-badge warn">{waiting}</span>}
      </button>
      <span class="spacer" />
      <button class={`act-btn${sidebarVisible.value && sidebarView.value === 'settings' ? ' active' : ''}`} title="Configurações (Ctrl+,)" onClick={() => pick('settings')}>
        <Icon name="settings-gear" />
      </button>
    </div>
  );
}

function Sidebar() {
  const v = sidebarView.value;
  return (
    <div class="sidebar" style={{ width: sidebarWidth.value }}>
      <div class="side-title">
        <span class="grow">{TITLES[v]}</span>
      </div>
      {v === 'explorer' && <Explorer />}
      {v === 'search' && <SearchView />}
      {v === 'servers' && <Servers />}
      {v === 'history' && <History />}
      {v === 'settings' && <SettingsView />}
    </div>
  );
}

/** Último painel clicado/focado: Ctrl+W fecha o arquivo também depois de clicar numa visualização
 *  (markdown, imagem, vídeo), que não recebe foco de teclado. */
let lastPanel: 'editor' | 'other' = 'other';

function useShortcuts() {
  // Arquivo do Windows solto fora do explorador nunca vira download/abertura pelo navegador.
  useEffect(() => installWindowDropGuard(), []);
  useEffect(() => {
    const track = (e: Event) => {
      const t = e.target as HTMLElement | null;
      lastPanel = t?.closest?.('.editor-panel') ? 'editor' : 'other';
    };
    window.addEventListener('pointerdown', track, true);
    window.addEventListener('focusin', track, true);
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (authPrompts.value.length) return;
      if (e.key === 'F2' && !ctrl && !e.altKey && !e.shiftKey) {
        // F2 renomeia a conversa ativa, exceto onde ele já tem outro uso (renomear arquivo no explorador,
        // campos de texto, editor de código).
        if ((e.target as HTMLElement | null)?.closest?.('.tree-row, .cm-editor, input')) return;
        const c = activeChat.value;
        if (c) {
          e.preventDefault();
          renamingSid.value = c.sid;
        }
      } else if (ctrl && e.shiftKey && k === 'n') {
        e.preventDefault();
        newChatPicker.value = {};
      } else if (ctrl && !e.shiftKey && k === 'n') {
        e.preventDefault();
        const c = activeChat.value;
        if (c) newChat(c.state.value.hostId, c.state.value.cwd);
        else newChatPicker.value = {};
      } else if (ctrl && e.shiftKey && k === 'p') {
        e.preventDefault();
        commandPalette.value = true;
      } else if (ctrl && !e.shiftKey && k === 'p') {
        e.preventDefault();
        quickOpen.value = true;
      } else if (ctrl && e.shiftKey && k === 'e') {
        e.preventDefault();
        sidebarView.value = 'explorer';
        sidebarVisible.value = true;
      } else if (ctrl && e.shiftKey && k === 'f') {
        e.preventDefault();
        sidebarView.value = 'search';
        sidebarVisible.value = true;
      } else if (ctrl && e.shiftKey && k === 'h') {
        e.preventDefault();
        sidebarView.value = 'history';
        sidebarVisible.value = true;
      } else if (ctrl && e.altKey && k === 'o') {
        // Organiza as abas agora (de resto elas se organizam sozinhas a cada 30 minutos).
        e.preventDefault();
        sortChatsNow();
      } else if (ctrl && e.altKey && k === 'b') {
        e.preventDefault();
        editorVisible.value = !editorVisible.value;
      } else if (ctrl && !e.shiftKey && k === 'b') {
        e.preventDefault();
        sidebarVisible.value = !sidebarVisible.value;
      } else if (ctrl && k === ',') {
        e.preventDefault();
        sidebarView.value = 'settings';
        sidebarVisible.value = true;
      } else if (ctrl && e.key === 'Tab') {
        e.preventDefault();
        const list = chats.value;
        if (!list.length) return;
        const i = list.findIndex((c) => c.sid === activeChatId.value);
        const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
        activateChat(next.sid);
      } else if (ctrl && e.shiftKey && k === 'w') {
        e.preventDefault();
        const c = activeChat.value;
        if (c) closeChat(c.sid);
      } else if (ctrl && !e.shiftKey && k === 'w') {
        // Ctrl+W fecha o arquivo ativo se o foco estiver no painel de arquivos.
        // Fora dele não faz nada (sem isso, a janela do app fecharia).
        e.preventDefault();
        const inEditor = (document.activeElement as HTMLElement | null)?.closest('.editor-panel') || lastPanel === 'editor';
        const f = activeFile.value;
        if (inEditor && f) closeFile(f.id);
      } else if (ctrl && !e.shiftKey && k === 't') {
        // Ctrl+T: nova conversa (na mesma pasta da atual), como uma aba nova.
        e.preventDefault();
        const c = activeChat.value;
        if (c) newChat(c.state.value.hostId, c.state.value.cwd);
        else newChatPicker.value = {};
      } else if (ctrl && !e.shiftKey && k === 's') {
        const f = activeFile.value;
        e.preventDefault();
        // O CodeMirror também tem Ctrl+S. Rodar os dois abre DOIS diálogos de conflito
        // ou grava o mesmo arquivo em paralelo (perde a proteção de mtime).
        if ((e.target as HTMLElement)?.closest('.cm-editor')) return;
        if (f?.dirty.value) saveFile(f);
      } else if (e.altKey && /^[1-9]$/.test(e.key)) {
        const c = chats.value[Number(e.key) - 1];
        if (c) {
          e.preventDefault();
          activateChat(c.sid);
        }
      } else if (ctrl && k === 'l' && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('deck:focus-composer'));
      } else if ((ctrl && (e.code === 'Backquote' || k === '`')) || (ctrl && !e.shiftKey && k === 'j')) {
        e.preventDefault();
        toggleTerminal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', track, true);
      window.removeEventListener('focusin', track, true);
    };
  }, []);
}

export function App() {
  useShortcuts();
  if (!ready.value) {
    return (
      <div class="empty-chat" style={{ height: '100%' }}>
        <Icon name="loading" class="spin" style={{ fontSize: 28 }} />
        <div>{wsEverConnected.value ? 'Carregando…' : 'Conectando ao Claude Deck…'}</div>
      </div>
    );
  }
  const chat = activeChat.value;
  const showEditor = editorVisible.value && files.value.length > 0;
  const termBottom = terminalVisible.value && settings.value.terminalPosition === 'bottom';
  const termRight = terminalVisible.value && !termBottom;
  return (
    <div class="app">
      <div class="main">
        <ActivityBar />
        {sidebarVisible.value && <Sidebar />}
        {sidebarVisible.value && (
          <Sash getStart={() => sidebarWidth.value} onDrag={(dx, start) => (sidebarWidth.value = Math.max(170, Math.min(640, start + dx)))} onDoubleClick={() => (sidebarWidth.value = 280)} />
        )}
        <div class="workbench">
          <div class="workbench-top">
            <div class="center">
              {chats.value.length > 0 && <ChatTabs />}
              {chat ? <Chat key={chat.sid} c={chat} /> : <Welcome />}
            </div>
            {termRight && (
              <Sash
                getStart={() => terminalWidth.value}
                onDrag={(dx, start) =>
                  (terminalWidth.value = Math.max(320, Math.min(window.innerWidth - 420 - (showEditor ? editorWidth.value : 0), start - dx)))
                }
                onDoubleClick={() => (terminalWidth.value = Math.round(window.innerWidth * 0.45))}
              />
            )}
            {termRight && (
              <div style={{ width: terminalWidth.value, flex: 'none', display: 'flex', minWidth: 320 }}>
                <TerminalPanel dock="right" />
              </div>
            )}
            {showEditor && (
              <Sash
                getStart={() => editorWidth.value}
                onDrag={(dx, start) => (editorWidth.value = Math.max(260, Math.min(window.innerWidth - 480, start - dx)))}
                onDoubleClick={() => (editorWidth.value = Math.round(window.innerWidth * 0.36))}
              />
            )}
            {showEditor && (
              <div style={{ width: editorWidth.value, flex: 'none', display: 'flex', minWidth: 260 }}>
                <EditorPanel />
              </div>
            )}
          </div>
          {termBottom && (
            <Sash
              orientation="horizontal"
              getStart={() => terminalHeight.value}
              onDrag={(dy, start) => (terminalHeight.value = Math.max(120, Math.min(window.innerHeight - 200, start - dy)))}
              onDoubleClick={() => (terminalHeight.value = 240)}
            />
          )}
          {termBottom && (
            <div style={{ height: terminalHeight.value, flex: 'none', display: 'flex' }}>
              <TerminalPanel dock="bottom" />
            </div>
          )}
        </div>
      </div>
      <StatusBar />
      <AttentionMenu />
      <ContextMenuHost />
      <NewChatPicker />
      <QuickOpen />
      <CommandPalette />
      <FolderBrowser />
      <AddHostDialog />
      <FileCopyPanel />
      <GenericDialogs />
      <AuthPromptDialog />
      <Lightbox />
      <Toasts />
      {!wsConnected.value && wsEverConnected.value && (
        <div class="offline-bar">
          <Icon name="loading" class="spin" /> Reconectando ao servidor local do Claude Deck…
        </div>
      )}
    </div>
  );
}
