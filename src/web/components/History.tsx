// Histórico de conversas (mesmos transcripts da extensão do VS Code), por pasta.
// Só do servidor desta janela: não há como escolher outro servidor aqui, para não abrir conexão SSH
// com servidores alheios. O histórico de outro servidor fica na janela dele (aba Servidores).
import { useEffect, useState } from 'preact/hooks';
import { rpc } from '../lib/rpc';
import { chats, errorText, homeOf, hostLabel, isPending, openHistoryChat, pendingConversations, pendingCountFor, pendingSupported, setConversationPending, toast, windowContext, workspace } from '../lib/state';
import type { SessionSummary } from '../../shared/types';
import { Icon } from './icons';
import { openMenu } from './ContextMenu';
import { timeAgo, formatBytes, formatDateTime } from '../lib/format';
import { tildify } from '../../shared/paths';

interface ProjectRow {
  dir: string;
  name: string;
  cwd?: string;
  mtime: number;
  count: number;
}

export function History() {
  const ctx = windowContext.value;
  const ws = workspace.value;
  // Servidor e pasta das conversas desta janela. A pasta que o explorador só está mostrando não
  // conta; sem contexto ainda (janela nova), vale o que o explorador mostra.
  const hostId = ctx?.hostId ?? ws?.hostId ?? 'local';
  const folder = ctx ? ctx.cwd : ws?.root;
  const [mode, setMode] = useState<'folder' | 'all' | 'pending'>(folder ? 'folder' : 'all');
  const [cwd, setCwd] = useState<string | undefined>(folder);
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [projectDir, setProjectDir] = useState<ProjectRow | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setCwd(folder);
    setProjectDir(null);
    setMode(folder ? 'folder' : 'all');
  }, [hostId, folder]);

  const load = async () => {
    setErr(null);
    setList(null);
    try {
      if (mode === 'pending') {
        setList(await rpc.call('history.pending', { hostId }, 180_000));
      } else if (mode === 'folder' && cwd) {
        setList(await rpc.call('history.list', { h: hostId, cwd }, 180_000));
      } else if (projectDir) {
        setList(await rpc.call('history.listDir', { h: hostId, dir: projectDir.dir }, 180_000));
      } else {
        setProjects(null);
        setProjects(await rpc.call('history.projects', { h: hostId }, 180_000));
        setList([]);
      }
    } catch (e) {
      setErr(errorText(e));
      setList([]);
    }
  };

  const pendingIds = Object.values(pendingConversations.value).filter((p) => p.hostId === hostId).map((p) => p.sessionId).sort().join(',');
  useEffect(() => {
    load();
  }, [hostId, cwd, mode, projectDir?.dir, mode === 'pending' ? pendingIds : '']);

  const openIds = new Set(chats.value.map((c) => c.state.value.sessionId));
  const needle = q.trim().toLowerCase();
  const visible = (list ?? []).filter((s) => (mode === 'pending' || showArchived || !s.archived) && (!needle || `${s.title} ${s.firstPrompt ?? ''}`.toLowerCase().includes(needle)));
  const archivedCount = (list ?? []).filter((s) => s.archived).length;

  const open = (s: SessionSummary) => {
    const dir = s.cwd || cwd || projectDir?.cwd;
    if (!dir) {
      toast('Não sei em que pasta esta conversa rodou.', 'error');
      return;
    }
    openHistoryChat(hostId, dir, s.sessionId, s.title);
  };

  const archive = async (s: SessionSummary, archived: boolean) => {
    await rpc.call('history.archive', { sessionId: s.sessionId, archived });
    setList((l) => (l ?? []).map((x) => (x.sessionId === s.sessionId ? { ...x, archived } : x)));
  };

  const togglePending = async (s: SessionSummary) => {
    const pending = !isPending(hostId, s.sessionId);
    const dir = s.cwd || cwd || projectDir?.cwd;
    if (!dir) return toast('Não sei em que pasta esta conversa rodou.', 'error');
    const ok = await setConversationPending(hostId, s.sessionId, dir, pending);
    if (ok) setList((l) => (l ?? []).map((x) => x.sessionId === s.sessionId ? { ...x, manualPending: pending } : x));
  };

  return (
    <div class="side-body" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 8px 4px 12px', display: 'flex', gap: 6, alignItems: 'center' }}>
        <div
          class="history-host"
          style={{ flex: 1, minWidth: 0, display: 'flex', gap: 6, alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}
          title="Só as conversas do servidor desta janela. Para ver as de outro servidor, abra a janela dele na aba Servidores."
        >
          <Icon name={hostId === 'local' ? 'device-desktop' : 'remote'} style={{ fontSize: 14, color: 'var(--fg-muted)', flex: 'none' }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{hostId === 'local' ? 'Este computador' : hostLabel(hostId)}</span>
        </div>
        <button class="icon-btn" title="Atualizar" onClick={load}>
          <Icon name="refresh" />
        </button>
      </div>
      <div style={{ padding: '0 8px 4px 12px', display: 'flex', gap: 6 }}>
        <div class="seg">
          <button class={mode === 'folder' ? 'on' : ''} disabled={!folder} onClick={() => (setMode('folder'), setProjectDir(null), setCwd(folder))}>
            Pasta atual
          </button>
          <button class={mode === 'all' ? 'on' : ''} onClick={() => (setMode('all'), setProjectDir(null))}>
            Todas as pastas
          </button>
          {pendingSupported.value && <button class={mode === 'pending' ? 'on' : ''} onClick={() => (setMode('pending'), setProjectDir(null))}>
            Pendentes{pendingCountFor(hostId) ? ` (${pendingCountFor(hostId)})` : ''}
          </button>}
        </div>
      </div>
      {mode === 'folder' && cwd && (
        <div class="tree-empty" style={{ padding: '2px 12px 4px 14px' }} title={cwd}>
          <Icon name="folder" style={{ fontSize: 13 }} /> {tildify(cwd, homeOf(hostId))}
        </div>
      )}
      {mode === 'all' && projectDir && (
        <div class="tree-row" style={{ paddingLeft: 10 }} onClick={() => setProjectDir(null)}>
          <Icon name="arrow-left" />
          <span class="label">{projectDir.cwd ? tildify(projectDir.cwd, homeOf(hostId)) : projectDir.name}</span>
        </div>
      )}
      <div class="search-box">
        <Icon name="search" />
        <input placeholder="Buscar conversas" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {list === null && <div class="tree-loading" />}
        {err && <div class="tree-empty" style={{ color: 'var(--err)' }}>{err}</div>}
        {mode === 'all' && !projectDir && projects && (
          <>
            {!projects.length && <div class="tree-empty">Nenhuma conversa em {hostLabel(hostId)}.</div>}
            {projects
              .filter((p) => !needle || (p.cwd ?? p.name).toLowerCase().includes(needle))
              .map((p) => (
                <div key={p.dir} class="tree-row" style={{ paddingLeft: 12 }} title={p.cwd ?? p.name} onClick={() => setProjectDir(p)}>
                  <Icon name="folder" style={{ fontSize: 14, color: '#dcb67a' }} />
                  <span class="label">{p.cwd ? tildify(p.cwd, homeOf(hostId)) : p.name}</span>
                  <span class="desc">
                    {p.count} · {timeAgo(p.mtime)}
                  </span>
                </div>
              ))}
          </>
        )}
        {(mode === 'folder' || projectDir || mode === 'pending') &&
          visible.map((s) => (
            <div
              key={s.sessionId}
              class={`tree-row${openIds.has(s.sessionId) ? ' selected' : ''}${isPending(hostId, s.sessionId) ? ' history-pending' : ''}`}
              style={{ paddingLeft: 12, height: 'auto', minHeight: 22, padding: '3px 8px 3px 12px' }}
              title={`${s.title}${isPending(hostId, s.sessionId) ? '\nPendente de visualização' : ''}\n${s.firstPrompt ? '\n' + s.firstPrompt.slice(0, 300) + '\n' : ''}\n${formatDateTime(s.mtime)} · ${formatBytes(s.size)}`}
              onClick={() => open(s)}
              onContextMenu={(e) =>
                openMenu(e as any, [
                  { label: 'Abrir conversa', icon: 'comment-discussion', action: () => open(s) },
                  { label: isPending(hostId, s.sessionId) ? 'Desmarcar pendência' : 'Marcar como pendente de visualização', icon: 'bookmark', action: () => void togglePending(s) },
                  { label: 'Copiar id da sessão', icon: 'copy', action: () => navigator.clipboard.writeText(s.sessionId) },
                  { label: 'Copiar comando para retomar no terminal', icon: 'terminal', action: () => navigator.clipboard.writeText(`claude --resume ${s.sessionId}`) },
                  { separator: true },
                  s.archived
                    ? { label: 'Desarquivar', icon: 'inbox', action: () => archive(s, false) }
                    : { label: 'Arquivar (ocultar da lista)', icon: 'archive', action: () => archive(s, true) },
                ])
              }
            >
              <Icon name={s.archived ? 'archive' : 'comment'} style={{ fontSize: 14, color: 'var(--fg-muted)', alignSelf: 'flex-start', marginTop: 2 }} />
              <span class="label clamp2">{s.title}{mode === 'pending' && s.cwd ? <small class="history-pending-path">{tildify(s.cwd, homeOf(hostId))}</small> : null}</span>
              <button
                type="button" class={`history-pending-btn${isPending(hostId, s.sessionId) ? ' marked' : ''}`}
                title={isPending(hostId, s.sessionId) ? 'Desmarcar pendência' : 'Marcar como pendente de visualização'}
                onClick={(e) => { e.stopPropagation(); void togglePending(s); }}
              ><Icon name="bookmark" /></button>
              <span class="desc" style={{ alignSelf: 'flex-start' }}>
                {timeAgo(s.mtime)}
              </span>
            </div>
          ))}
        {(mode === 'folder' || projectDir || mode === 'pending') && list && !visible.length && !err && (
          <div class="tree-empty">{needle ? 'Nada encontrado.' : mode === 'pending' ? 'Nenhuma conversa pendente neste servidor.' : 'Nenhuma conversa nesta pasta ainda.'}</div>
        )}
        {mode !== 'pending' && archivedCount > 0 && (
          <div class="tree-empty">
            <a onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Ocultar arquivadas' : `Mostrar ${archivedCount} arquivada(s)`}</a>
          </div>
        )}
      </div>
    </div>
  );
}
