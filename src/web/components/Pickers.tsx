// Paletas: nova conversa (servidor + pasta), abrir arquivo (Ctrl+P) e comandos (Ctrl+Shift+P).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { rpc } from '../lib/rpc';
import {
  activeChat,
  activateChat,
  addHostDialog,
  chats,
  chatTitle,
  closeChat,
  commandPalette,
  connectHost,
  editorVisible,
  folderBrowser,
  homeOf,
  hostLabel,
  hosts,
  hostStatus,
  newChat,
  newChatPicker,
  openFile,
  openTerminal,
  platformOf,
  quickOpen,
  sidebarView,
  sidebarVisible,
  settings,
  sortChatsNow,
  toggleTerminal,
  updateSettings,
  windowHostId,
  workspace,
  toast,
  errorText,
} from '../lib/state';
import { QuickPick, type QPItem } from './QuickPick';
import { Icon } from './icons';
import { join, tildify } from '../../shared/paths';
import { openJarvisCentral, probeJarvisTunnel } from '../lib/jarvis';

/** Passo 1: escolher servidor. Passo 2: escolher pasta (recentes, pasta pessoal, outra…). */
export function NewChatPicker() {
  const st = newChatPicker.value;
  const [hostId, setHostId] = useState<string | null>(st?.hostId ?? null);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => setHostId(st?.hostId ?? null), [st]);
  if (!st) return null;
  const close = () => (newChatPicker.value = null);

  if (!hostId) {
    const list = hosts.value;
    const items: QPItem[] = [
      ...list
        .filter((h) => h.kind === 'local' || h.favorite)
        .map((h) => ({ id: h.id, label: h.kind === 'local' ? 'Este computador' : h.label, desc: h.kind === 'local' ? 'Windows' : (hostStatus.value[h.id]?.state === 'ready' ? 'conectado · ' : '') + (h.address ?? ''), icon: h.kind === 'local' ? 'device-desktop' : 'remote', group: 'Favoritos' })),
      ...list.filter((h) => h.kind === 'ssh' && !h.favorite).map((h) => ({ id: h.id, label: h.label, desc: h.address, icon: 'remote', group: 'Outros servidores' })),
      { id: '__add', label: 'Adicionar servidor SSH…', icon: 'add', group: 'Outros servidores', alwaysShow: true },
    ];
    return (
      <QuickPick
        key="host"
        title={
          <>
            <Icon name="comment-discussion" /> Nova conversa — escolha o servidor
          </>
        }
        placeholder="Digite o nome do servidor"
        items={items}
        onClose={close}
        onPick={(it) => {
          if (it.id === '__add') {
            close();
            addHostDialog.value = true;
            return;
          }
          setHostId(it.id);
          if (it.id !== 'local') {
            setConnecting(true);
            connectHost(it.id)
              .catch(() => close())
              .finally(() => setConnecting(false));
          }
        }}
      />
    );
  }

  const h = hosts.value.find((x) => x.id === hostId);
  const home = homeOf(hostId);
  const recent = h?.recentFolders ?? [];
  const items: QPItem[] = [
    ...recent.map((f) => ({ id: `r:${f}`, label: tildify(f, home), desc: f === home ? 'pasta pessoal' : '', icon: 'folder', group: 'Pastas recentes' })),
    ...(home && !recent.includes(home) ? [{ id: `r:${home}`, label: '~', desc: 'pasta pessoal', icon: 'home', group: 'Pastas recentes' }] : []),
    ...(workspace.value?.hostId === hostId && !recent.includes(workspace.value.root) ? [{ id: `r:${workspace.value.root}`, label: tildify(workspace.value.root, home), desc: 'aberta no explorador', icon: 'folder-opened', group: 'Pastas recentes' }] : []),
    { id: '__browse', label: 'Escolher outra pasta…', icon: 'folder-opened', group: 'Outras', alwaysShow: true },
  ];
  return (
    <QuickPick
      key={`folder:${hostId}`}
      title={
        <>
          <Icon name="comment-discussion" /> Nova conversa em {hostLabel(hostId)} — escolha a pasta
          {connecting && <Icon name="loading" class="spin" />}
        </>
      }
      placeholder="Pasta (ou digite um caminho e Enter)"
      items={items}
      loading={connecting}
      onClose={close}
      onSubmitRaw={(q) => {
        const p = q.trim();
        if (!p) return;
        close();
        newChat(hostId, p.startsWith('~') && home ? join(platformOf(hostId), home, p.slice(1).replace(/^[\\/]/, '')) : p).catch((e) => toast(errorText(e), 'error'));
      }}
      onPick={(it, q) => {
        close();
        if (it.id === '__browse') {
          folderBrowser.value = { hostId, purpose: 'chat' };
          return;
        }
        const folder = it.id.slice(2);
        void q;
        newChat(hostId, folder).catch((e) => toast(errorText(e), 'error'));
      }}
    />
  );
}

/** Ctrl+P: abrir arquivo da pasta aberta no explorador. */
export function QuickOpen() {
  const open = quickOpen.value;
  const ws = workspace.value;
  const [filesList, setFiles] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !ws) return;
    setFiles(null);
    setErr(null);
    rpc
      .call('fs.findFiles', { h: ws.hostId, root: ws.root, limit: 30000 }, 60_000)
      .then(setFiles)
      .catch((e) => setErr(errorText(e)));
  }, [open, ws?.hostId, ws?.root]);
  const items = useMemo<QPItem[]>(() => (filesList ?? []).map((p) => ({ id: p, label: p.split('/').pop()!, desc: p, search: p, icon: 'file' })), [filesList]);
  if (!open) return null;
  const close = () => (quickOpen.value = false);
  if (!ws)
    return <QuickPick title="Abrir arquivo" items={[]} emptyText="Abra uma pasta ou conversa primeiro." onClose={close} onPick={close} />;
  return (
    <QuickPick
      title={
        <>
          <Icon name="go-to-file" /> Abrir arquivo em {hostLabel(ws.hostId)}: {tildify(ws.root, homeOf(ws.hostId))}
        </>
      }
      placeholder="Nome do arquivo (busca aproximada)"
      items={items}
      loading={!filesList && !err}
      emptyText={err ?? 'Nada encontrado.'}
      limit={80}
      onClose={close}
      onPick={(it) => {
        close();
        const plat = platformOf(ws.hostId);
        openFile(ws.hostId, join(plat, ws.root, plat === 'win32' ? it.id.replace(/\//g, '\\') : it.id));
      }}
    />
  );
}

/** Ctrl+Shift+P: comandos do app. */
export function CommandPalette() {
  if (!commandPalette.value) return null;
  const close = () => (commandPalette.value = false);
  const c = activeChat.value;
  const cmds: (QPItem & { run: () => void })[] = [
    { id: 'new', label: 'Nova conversa…', kb: 'Ctrl+Shift+N', icon: 'comment-discussion', run: () => (newChatPicker.value = {}) },
    ...(c ? [{ id: 'new-same', label: 'Nova conversa na mesma pasta', kb: 'Ctrl+N', icon: 'add', run: () => newChat(c.state.value.hostId, c.state.value.cwd) }] : []),
    ...(c ? [{ id: 'close', label: 'Fechar conversa atual', kb: 'Ctrl+Shift+W', icon: 'close', run: () => closeChat(c.sid) }] : []),
    { id: 'sort-tabs', label: 'Organizar abas agora (terminou › pede resposta › trabalhando › paradas)', kb: 'Ctrl+Alt+O', icon: 'sort-precedence', run: sortChatsNow },
    { id: 'open-file', label: 'Abrir arquivo…', kb: 'Ctrl+P', icon: 'go-to-file', run: () => (quickOpen.value = true) },
    { id: 'open-folder', label: 'Abrir pasta…', icon: 'folder-opened', run: () => (folderBrowser.value = { hostId: windowHostId(), purpose: 'workspace' }) },
    ...(workspace.value
      ? [{ id: 'add-root', label: 'Adicionar pasta ao explorador…', icon: 'new-folder', run: () => (folderBrowser.value = { hostId: workspace.value!.hostId, purpose: 'add-root' as const }) }]
      : []),
    { id: 'servers', label: 'Mostrar servidores', icon: 'remote', run: () => ((sidebarView.value = 'servers'), (sidebarVisible.value = true)) },
    { id: 'explorer', label: 'Mostrar explorador de arquivos', kb: 'Ctrl+Shift+E', icon: 'files', run: () => ((sidebarView.value = 'explorer'), (sidebarVisible.value = true)) },
    { id: 'search', label: 'Buscar em arquivos…', kb: 'Ctrl+Shift+F', icon: 'search', run: () => ((sidebarView.value = 'search'), (sidebarVisible.value = true)) },
    { id: 'history', label: 'Mostrar histórico de conversas', kb: 'Ctrl+Shift+H', icon: 'history', run: () => ((sidebarView.value = 'history'), (sidebarVisible.value = true)) },
    { id: 'term-toggle', label: 'Terminal: Alternar terminal integrado', kb: 'Ctrl+`', icon: 'terminal', run: toggleTerminal },
    { id: 'term-new', label: 'Terminal: Novo terminal integrado', icon: 'add', run: () => openTerminal() },
    { id: 'term-new-local', label: 'Terminal: Novo terminal local (PowerShell)', icon: 'terminal-powershell', run: () => openTerminal('local') },
    { id: 'add-host', label: 'Adicionar servidor SSH…', icon: 'add', run: () => (addHostDialog.value = true) },
    // Global (outro serviço, outro CT, outro perfil do Brave): janela própria, nunca a desta
    // pasta/servidor. Síncrona (sem `await` antes do clique no protocolo) para não perder o gesto.
    {
      id: 'jarvis',
      label: 'Jarvis · Central (janela separada)',
      icon: 'radio-tower',
      run: () => {
        const r = openJarvisCentral();
        if (!r.opened && r.reason) {
          toast(r.reason, 'error', 8000);
          return;
        }
        probeJarvisTunnel().then((up) => {
          if (!up) toast('Túnel do Jarvis (127.0.0.1:47331) não respondeu — confira se a janela abriu mesmo assim.', 'info', 7000);
        });
      },
    },
    { id: 'sidebar', label: 'Mostrar/ocultar barra lateral', kb: 'Ctrl+B', icon: 'layout-sidebar-left', run: () => (sidebarVisible.value = !sidebarVisible.value) },
    { id: 'editor', label: 'Mostrar/ocultar painel de arquivos', kb: 'Ctrl+Alt+B', icon: 'layout-sidebar-right', run: () => (editorVisible.value = !editorVisible.value) },
    { id: 'theme', label: settings.value.theme === 'dark' ? 'Tema claro' : 'Tema escuro', icon: 'color-mode', run: () => updateSettings({ theme: settings.value.theme === 'dark' ? 'light' : 'dark' }) },
    { id: 'zoom-in', label: 'Aumentar fonte do chat', icon: 'zoom-in', run: () => updateSettings({ chatFontSize: Math.min(24, settings.value.chatFontSize + 1) }) },
    { id: 'zoom-out', label: 'Diminuir fonte do chat', icon: 'zoom-out', run: () => updateSettings({ chatFontSize: Math.max(10, settings.value.chatFontSize - 1) }) },
    { id: 'settings', label: 'Configurações', kb: 'Ctrl+,', icon: 'settings-gear', run: () => ((sidebarView.value = 'settings'), (sidebarVisible.value = true)) },
    ...chats.value.map((x) => ({ id: `go:${x.sid}`, label: `Ir para: ${chatTitle(x)}`, desc: `${hostLabel(x.state.value.hostId)} · ${x.state.value.cwd}`, icon: 'comment', run: () => activateChat(x.sid) })),
  ];
  return (
    <QuickPick
      title={
        <>
          <Icon name="terminal-cmd" /> Comandos
        </>
      }
      placeholder="Digite um comando"
      items={cmds}
      onClose={close}
      onPick={(it) => {
        close();
        (cmds.find((x) => x.id === it.id) as any)?.run();
      }}
    />
  );
}
