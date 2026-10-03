// Barra de status (embaixo), no estilo do VS Code.
import { activeChat, activeFile, chats, connectHost, hostLabel, hostStatus, newChatPicker, settings, sidebarView, sidebarVisible, stats, toast, toggleTerminal, updateSettings, uploadProgress, workspace } from '../lib/state';
import { wsConnected } from '../lib/rpc';
import { copyTerminal, fileCopyJobs, fileCopyLabel, fileCopyPanel } from '../lib/fileCopy';
import { Icon } from './icons';
import { formatBytes } from '../lib/format';
import { MODE_LABELS } from './Composer';
import { openJarvisCentral, probeJarvisTunnel } from '../lib/jarvis';
import { attentionLists, attentionMenu, toggleAttentionMenu } from './AttentionMenu';
import type { PermissionMode } from '../../shared/types';

/**
 * Jarvis · Central é global (outro serviço, outro CT, outro perfil do Brave): nunca anexa
 * host/pasta desta janela. Precisa ser síncrona (sem `await` antes do clique no protocolo) para
 * não perder o gesto do usuário; a sonda do túnel roda depois, só como diagnóstico auxiliar.
 */
function openJarvis() {
  const r = openJarvisCentral();
  if (!r.opened && r.reason) {
    toast(r.reason, 'error', 8000);
    return;
  }
  probeJarvisTunnel().then((up) => {
    if (!up) toast('Túnel do Jarvis (127.0.0.1:47331) não respondeu — confira se a janela abriu mesmo assim.', 'info', 7000);
  });
}

export function StatusBar() {
  const c = activeChat.value;
  const hostId = c?.state.value.hostId ?? workspace.value?.hostId ?? 'local';
  const st = hostStatus.value[hostId];
  const remote = hostId !== 'local';
  const cls = !remote ? 'local' : st?.state === 'error' ? 'error' : st?.state === 'connecting' || st?.state === 'reconnecting' ? 'connecting' : '';
  // Assina a versão de cada conversa e o recarregamento do arquivo ativo (campos não-signal).
  for (const x of chats.value) void x.version.value;
  const running = chats.value.filter((x) => x.state.value.phase === 'running' || x.model.running).length;
  // Esperando você (permissão, pergunta, plano) e terminadas que ninguém viu: cada uma conta uma vez e
  // abre a lista delas (ver AttentionMenu).
  const { waiting, finished, pending } = attentionLists();
  const finishedErrors = finished.filter((x) => x.state.value.unseen === 'error').length;
  const openMenu = attentionMenu.value?.kind;
  const f = activeFile.value;
  if (f) void f.reloadKey.value;
  const s = stats.value;
  return (
    <div class="statusbar">
      <span
        class={`sb-item sb-remote ${cls}`}
        title={remote ? `${hostId}: ${st?.state ?? 'desconectado'}${st?.error ? '\n' + st.error : ''}\nClique para ver os servidores` : 'Este computador'}
        onClick={() => {
          if (remote && st?.state === 'error') connectHost(hostId, true).catch(() => {});
          else {
            sidebarView.value = 'servers';
            sidebarVisible.value = true;
          }
        }}
      >
        <Icon name={remote ? 'remote' : 'device-desktop'} />
        {remote ? `SSH: ${hostLabel(hostId)}` : 'Local'}
        {st?.state === 'connecting' || st?.state === 'reconnecting' ? <Icon name="loading" class="spin" /> : null}
      </span>
      {!wsConnected.value && (
        <span class="sb-item sb-warn">
          <Icon name="debug-disconnect" /> Sem conexão com o servidor local
        </span>
      )}
      {remote && st?.claude && <span class="sb-item" title={st.claude.path}>Claude {st.claude.version}</span>}
      {remote && st?.state === 'ready' && st.claude === null && (
        <span class="sb-item sb-warn">
          <Icon name="warning" /> Claude não encontrado no servidor
        </span>
      )}
      <span class="grow" />
      {fileCopyJobs.value.length > 0 && (
        <button class="sb-item click file-copy-status" title="Ver andamento, cancelar e conferir os resultados das cópias" onClick={() => (fileCopyPanel.value = !fileCopyPanel.value)}>
          <Icon name="copy" /> {fileCopyJobs.value.filter((j) => !copyTerminal(j)).length ? `${fileCopyLabel(fileCopyJobs.value.find((j) => !copyTerminal(j))!)} · ${fileCopyJobs.value.filter((j) => !copyTerminal(j)).length} cópia(s)` : 'Cópias'}
        </button>
      )}
      {uploadProgress.value && (
        <span class="sb-item" title="Enviando arquivo">
          <Icon name="cloud-upload" /> {uploadProgress.value.name} {uploadProgress.value.pct}%
        </span>
      )}
      {running > 0 && (
        <span class="sb-item" title="Conversas trabalhando agora">
          <Icon name="loading" class="spin" /> {running} trabalhando
        </span>
      )}
      {waiting.length > 0 && (
        <span
          class={`sb-item click sb-attn sb-warn${openMenu === 'waiting' ? ' open' : ''}`}
          role="button"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'waiting'}
          title="Conversas esperando sua resposta (permissão, pergunta ou plano). Clique para ver quais."
          onClick={(e) => toggleAttentionMenu('waiting', e.currentTarget as HTMLElement)}
        >
          <Icon name="bell-dot" /> {waiting.length} esperando você
        </span>
      )}
      {pending.length > 0 && (
        <span
          class={`sb-item click sb-attn sb-pending${openMenu === 'pending' ? ' open' : ''}`}
          role="button" aria-haspopup="menu" aria-expanded={openMenu === 'pending'}
          title="Conversas desta janela marcadas para ver depois. Clique para abrir uma delas."
          onClick={(e) => toggleAttentionMenu('pending', e.currentTarget as HTMLElement)}
        >
          <Icon name="bookmark" /> {pending.length} {pending.length === 1 ? 'pendente' : 'pendentes'}
        </span>
      )}
      {finished.length > 0 && (
        <span
          class={`sb-item click sb-attn sb-done${finishedErrors ? ' has-error' : ''}${openMenu === 'finished' ? ' open' : ''}`}
          role="button"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'finished'}
          title={`Terminaram e esperam você olhar${finishedErrors ? ` (${finishedErrors} com erro)` : ''}. Clique para ver quais.`}
          onClick={(e) => toggleAttentionMenu('finished', e.currentTarget as HTMLElement)}
        >
          <Icon name={finishedErrors ? 'error' : 'pass'} /> {finished.length} {finished.length === 1 ? 'concluída' : 'concluídas'}
        </span>
      )}
      {c && (
        <span class="sb-item" title="Modo de permissão da conversa atual">
          <Icon name={MODE_LABELS[(c.state.value.permissionMode ?? 'default') as PermissionMode]?.icon ?? 'shield'} />
          {MODE_LABELS[(c.state.value.permissionMode ?? 'default') as PermissionMode]?.label}
        </span>
      )}
      {f && (
        <span class="sb-item" title={f.path}>
          {f.kind === 'text' ? 'Texto' : f.kind.toUpperCase()} · {formatBytes(f.size)}
        </span>
      )}
      {s && (
        <span class="sb-item" title={`Memória do servidor do Claude Deck. ${s.hostsConnected} servidor(es) conectado(s), ${s.channels} canal(is) SSH.`}>
          <Icon name="server-process" /> {formatBytes(s.rss)}
        </span>
      )}
      <span class="sb-item click" title="Alternar terminal integrado (Ctrl+` ou Ctrl+J)" onClick={toggleTerminal}>
        <Icon name="terminal" />
      </span>
      <span class="sb-item click" title="Alternar tema" onClick={() => updateSettings({ theme: settings.value.theme === 'dark' ? 'light' : 'dark' })}>
        <Icon name="color-mode" />
      </span>
      <span class="sb-item click" title="Nova conversa (Ctrl+Shift+N)" onClick={() => (newChatPicker.value = {})}>
        <Icon name="comment-discussion" />
      </span>
      <span class="sb-item click" title="Jarvis · Central — janela própria, fora desta pasta/servidor" onClick={openJarvis}>
        <Icon name="radio-tower" /> Jarvis · Central
      </span>
    </div>
  );
}
