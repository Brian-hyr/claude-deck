// Lista de servidores (Local + ~/.ssh/config): favoritos, pastas recentes, estado da conexão.
import { useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { rpc } from '../lib/rpc';
import {
  addHostDialog,
  chats,
  claudeUpdateOffer,
  connectHost,
  disconnectHost,
  errorText,
  folderBrowser,
  homeOf,
  hosts,
  hostStatus,
  openChatIn,
  openHostWindow,
  openWorkspace,
  toast,
  toggleFavorite,
  hostLabel,
  installHostAgy,
  installingAgy,
  updateHostClaude,
  updatingClaude,
  windowContext,
} from '../lib/state';
import type { HostInfo } from '../../shared/types';
import { Icon } from './icons';
import { openMenu } from './ContextMenu';
import { tildify } from '../../shared/paths';
import { cliAuthDialog } from './CliAuthDialog';

const expandedHosts = signal<Set<string>>(new Set(['local']));
const checkResults = signal<Record<string, { ok: boolean; ms: number; error?: string; claude?: { version: string } | null; claudeLatest?: string; agy?: { version: string } | null }>>({});
const checking = signal(false);

function stateIcon(id: string) {
  const st = hostStatus.value[id];
  if (!st || st.state === 'idle') return null;
  if (st.state === 'ready') return <Icon name="circle-filled" class="conn-state ready" title="Conectado" style={{ fontSize: 9 }} />;
  if (st.state === 'error') return <Icon name="error" class="conn-state error" title={st.error} />;
  return <Icon name="loading" class="conn-state connecting spin" title="Conectando…" />;
}

export function Servers() {
  const [q, setQ] = useState('');
  const list = hosts.value;
  const chatCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of chats.value) m[c.state.value.hostId] = (m[c.state.value.hostId] ?? 0) + 1;
    return m;
  }, [chats.value]);

  const qNorm = q.trim().toLowerCase();
  const filtered = qNorm
    ? list.filter((h) => {
        const text = `${h.label} ${h.address ?? ''} ${(h.recentFolders ?? []).join(' ')}`.toLowerCase();
        return text.includes(qNorm);
      })
    : list;
  const local = filtered.filter((h) => h.kind === 'local');
  const favs = filtered.filter((h) => h.kind === 'ssh' && h.favorite);
  const others = filtered.filter((h) => h.kind === 'ssh' && !h.favorite);

  return (
    <div class="side-body">
      <div class="search-box">
        <Icon name="search" />
        <input placeholder="Filtrar servidores ou pastas" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} spellcheck={false} />
      </div>
      {local.map((h) => (
        <HostRow key={h.id} host={h} chats={chatCount[h.id] ?? 0} filterQ={q.trim()} />
      ))}
      {favs.length > 0 && <div class="qp-sep" style={{ paddingLeft: 20 }}>Favoritos</div>}
      {favs.map((h) => (
        <HostRow key={h.id} host={h} chats={chatCount[h.id] ?? 0} filterQ={q.trim()} />
      ))}
      {others.length > 0 && <div class="qp-sep" style={{ paddingLeft: 20 }}>Todos os servidores ({others.length})</div>}
      {others.map((h) => (
        <HostRow key={h.id} host={h} chats={chatCount[h.id] ?? 0} filterQ={q.trim()} />
      ))}
      {!filtered.length && <div class="tree-empty">Nenhum servidor ou pasta encontrada.</div>}
      <div style={{ padding: '10px 20px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button class="btn secondary" onClick={() => (addHostDialog.value = true)}>
          <Icon name="add" /> Novo servidor SSH
        </button>
        <button class="btn secondary" disabled={checking.value} onClick={checkAll} title="Testa a conexão de todos os servidores (sem pedir senha)">
          <Icon name={checking.value ? 'loading' : 'pulse'} class={checking.value ? 'spin' : ''} /> Testar todos
        </button>
      </div>
      {Object.keys(checkResults.value).length > 0 && <CheckTable />}
    </div>
  );
}

async function checkAll() {
  checking.value = true;
  checkResults.value = {};
  const targets = hosts.value.filter((h) => h.kind === 'ssh');
  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const h = targets[i++];
      try {
        const r = await rpc.call('hosts.check', { id: h.id }, 60_000);
        checkResults.value = { ...checkResults.value, [h.id]: r };
      } catch (e) {
        checkResults.value = { ...checkResults.value, [h.id]: { ok: false, ms: 0, error: errorText(e) } };
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  checking.value = false;
  const ok = Object.values(checkResults.value).filter((r) => r.ok).length;
  toast(`Teste concluído: ${ok} de ${targets.length} servidores acessíveis desta rede.`, 'info', 6000);
}

function CheckTable() {
  const res = checkResults.value;
  const ids = Object.keys(res).sort((a, b) => Number(res[b].ok) - Number(res[a].ok) || a.localeCompare(b));
  return (
    <div style={{ padding: '0 12px 16px 20px' }}>
      <table class="check-table">
        <tbody>
          {ids.map((id) => (
            <tr key={id}>
              <td class={res[id].ok ? 'ok' : 'bad'}>
                <Icon name={res[id].ok ? 'pass' : 'error'} style={{ fontSize: 13 }} />
              </td>
              <td>{id}</td>
              <td style={{ color: 'var(--fg-muted)' }}>
                {res[id].ok ? (
                  <>
                    <span>{res[id].claude ? `Claude ${res[id].claude!.version}${res[id].claudeLatest ? ` → ${res[id].claudeLatest} disponível` : ''}` : 'sem Claude'}</span>
                    <span style={{ margin: '0 6px', opacity: 0.4 }}>·</span>
                    <span>{res[id].agy ? `Agy ${res[id].agy!.version}` : 'sem Agy'}</span>
                  </>
                ) : res[id].error}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HostRow({ host, chats: nChats, filterQ }: { host: HostInfo; chats: number; filterQ?: string }) {
  const isExpandedManual = expandedHosts.value.has(host.id);
  const qLower = filterQ?.toLowerCase() ?? '';
  const matchesFolder = !!qLower && (host.recentFolders ?? []).some((f) => f.toLowerCase().includes(qLower));
  const open = isExpandedManual || matchesFolder;
  const st = hostStatus.value[host.id];
  const toggle = () => {
    const s = new Set(expandedHosts.value);
    if (open) s.delete(host.id);
    else s.add(host.id);
    expandedHosts.value = s;
  };
  const recent = useMemo(() => {
    let list = host.recentFolders.length ? host.recentFolders : [];
    if (qLower && !host.label.toLowerCase().includes(qLower) && !(host.address ?? '').toLowerCase().includes(qLower)) {
      list = list.filter((f) => f.toLowerCase().includes(qLower));
    }
    return list;
  }, [host.recentFolders, qLower, host.label, host.address]);

  const startChat = (folder?: string) => openChatIn(host.id, folder);
  const offer = claudeUpdateOffer(host.id);
  const updating = updatingClaude.value.has(host.id);
  const isInstallingAgy = installingAgy.value.has(host.id);
  // Só o explorador desta janela mostra arquivos, e só do servidor dela: "Abrir pasta…" e
  // "Abrir no explorador" não aparecem para os outros servidores (eles têm a janela deles).
  const ctx = windowContext.value;
  const canBrowse = !ctx || ctx.hostId === host.id;

  const menu = (e: MouseEvent) =>
    openMenu(e, [
      { label: 'Abrir a janela do servidor', icon: 'multiple-windows', action: () => openHostWindow(host.id) },
      { separator: true },
      { label: 'Nova conversa…', icon: 'comment-discussion', action: () => (folderBrowser.value = { hostId: host.id, purpose: 'chat' }) },
      { label: 'Entrar no Claude Code…', icon: 'account', action: () => (cliAuthDialog.value = { hostId: host.id, engine: 'claude' }) },
      { label: 'Entrar no Antigravity…', icon: 'account', action: () => (cliAuthDialog.value = { hostId: host.id, engine: 'antigravity' }) },
      ...(canBrowse ? [{ label: 'Abrir pasta…', icon: 'folder-opened', action: () => (folderBrowser.value = { hostId: host.id, purpose: 'workspace' as const }) }] : []),
      { separator: true },
      ...(host.kind === 'ssh'
        ? [
            { label: host.favorite ? 'Tirar dos favoritos' : 'Marcar como favorito', icon: host.favorite ? 'star-full' : 'star-empty', action: () => toggleFavorite(host.id) },
            { label: st?.state === 'ready' ? 'Reconectar' : 'Conectar', icon: 'plug', action: () => connectHost(host.id, true).catch(() => {}) },
            ...(offer
              ? [{ label: updating ? 'Atualizando o Claude Code…' : `Atualizar Claude Code (${offer.from} → ${offer.to})…`, icon: 'arrow-circle-up', disabled: updating, action: () => void updateHostClaude(host.id) }]
              : []),
            ...(!st?.agy
              ? [{ label: isInstallingAgy ? 'Instalando Antigravity CLI…' : 'Instalar Antigravity CLI…', icon: isInstallingAgy ? 'loading' : 'cloud-download', disabled: isInstallingAgy, action: () => void installHostAgy(host.id) }]
              : []),
            ...(st?.state === 'ready'
              ? [{ label: 'Desconectar', icon: 'debug-disconnect', action: () => void disconnectHost(host.id) }]
              : []),
            { separator: true },
            { label: 'Copiar comando ssh', icon: 'copy', action: () => navigator.clipboard.writeText(`ssh ${/\s/.test(host.id) ? `"${host.id}"` : host.id}`) },
          ]
        : [
            ...(!st?.agy
              ? [{ label: isInstallingAgy ? 'Instalando Antigravity CLI…' : 'Instalar Antigravity CLI…', icon: isInstallingAgy ? 'loading' : 'cloud-download', disabled: isInstallingAgy, action: () => void installHostAgy(host.id) }]
              : []),
          ]),
    ]);

  return (
    <>
      <div
        class="tree-row"
        style={{ paddingLeft: 6 }}
        onClick={() => openHostWindow(host.id)}
        onContextMenu={menu as any}
        title={`${host.address ? `${host.label}\n${host.address}${st?.error ? '\n' + st.error : ''}` : host.label}\nClique para abrir a janela dele (se já está aberta, ela vem para a frente)`}
      >
        <span class="twistie" title={open ? 'Recolher pastas' : 'Mostrar pastas'} onClick={(e) => (e.stopPropagation(), toggle())}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </span>
        <span class="host-dot" style={{ background: host.color }} />
        <Icon name={host.kind === 'local' ? 'device-desktop' : 'remote'} style={{ fontSize: 14, color: 'var(--fg-muted)' }} />
        <span class="label">{host.kind === 'local' ? host.label : host.label}</span>
        {nChats > 0 && (
          <span class="desc" title={`${nChats} conversa(s) aberta(s)`}>
            <Icon name="comment" style={{ fontSize: 12 }} /> {nChats}
          </span>
        )}
        {offer && (
          <button
            class="icon-btn claude-update-btn"
            style={{ color: 'var(--warn)' }}
            disabled={updating}
            title={`Claude Code ${offer.from} → ${offer.to}. Clique para atualizar este servidor.`}
            onClick={(e) => (e.stopPropagation(), void updateHostClaude(host.id))}
          >
            <Icon name={updating ? 'loading' : 'arrow-circle-up'} class={updating ? 'spin' : ''} />
          </button>
        )}
        {stateIcon(host.id)}
        <span class="actions">
          <button class="icon-btn" title="Nova conversa (pasta pessoal)" onClick={(e) => (e.stopPropagation(), startChat())}>
            <Icon name="comment-discussion" />
          </button>
          {canBrowse && (
            <button class="icon-btn" title="Abrir pasta…" onClick={(e) => (e.stopPropagation(), (folderBrowser.value = { hostId: host.id, purpose: 'workspace' }))}>
              <Icon name="folder-opened" />
            </button>
          )}
          {host.kind === 'ssh' && (
            <button class="icon-btn" title={host.favorite ? 'Tirar dos favoritos' : 'Favorito'} onClick={(e) => (e.stopPropagation(), toggleFavorite(host.id))}>
              <Icon name={host.favorite ? 'star-full' : 'star-empty'} />
            </button>
          )}
        </span>
      </div>
      {open && (
        <>
          {st?.state === 'error' && (
            <div class="tree-empty" style={{ paddingLeft: 44, color: 'var(--err)' }}>
              {st.error}
              <div>
                <button class="btn secondary" style={{ marginTop: 6, height: 22 }} onClick={() => connectHost(host.id, true).catch(() => {})}>
                  Tentar de novo
                </button>
              </div>
            </div>
          )}
          {st?.state === 'ready' && st.claude === null && host.kind === 'ssh' && (
            <div class="tree-empty" style={{ paddingLeft: 44, color: 'var(--warn)' }}>
              Claude Code não encontrado neste servidor.
            </div>
          )}
          {st?.state === 'ready' && st.agy === null && (
            <div class="tree-empty" style={{ paddingLeft: 44, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span>Antigravity CLI não encontrado.</span>
              <button
                class="btn secondary"
                style={{ height: 20, padding: '0 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                disabled={isInstallingAgy}
                onClick={(e) => (e.stopPropagation(), void installHostAgy(host.id))}
              >
                <Icon name={isInstallingAgy ? 'loading' : 'cloud-download'} class={isInstallingAgy ? 'spin' : ''} style={{ fontSize: 12 }} />
                {isInstallingAgy ? 'Instalando…' : 'Instalar'}
              </button>
            </div>
          )}
          {recent.map((f) => (
            <div
              key={f}
              class="tree-row"
              style={{ paddingLeft: 40 }}
              title={`${f}\nClique para abrir a janela desta pasta (se já está aberta, ela vem para a frente)`}
              onClick={() => openHostWindow(host.id, f)}
              onContextMenu={(e) =>
                openMenu(e as any, [
                  { label: 'Abrir a janela desta pasta', icon: 'multiple-windows', action: () => openHostWindow(host.id, f) },
                  { separator: true },
                  { label: 'Nova conversa aqui', icon: 'comment-discussion', action: () => startChat(f) },
                  ...(canBrowse ? [{ label: 'Abrir no explorador', icon: 'folder-opened', action: () => openWorkspace(host.id, f) }] : []),
                  { label: 'Copiar caminho', icon: 'copy', action: () => navigator.clipboard.writeText(f) },
                  { separator: true },
                  {
                    label: 'Remover dos recentes',
                    icon: 'close',
                    action: () => {
                      rpc.call('hosts.removeRecent', { id: host.id, folder: f });
                      hosts.value = hosts.value.map((h) => (h.id === host.id ? { ...h, recentFolders: h.recentFolders.filter((x) => x !== f) } : h));
                    },
                  },
                ])
              }
            >
              <Icon name="folder" style={{ fontSize: 14, color: '#dcb67a' }} />
              <span class="label">{tildify(f, homeOf(host.id))}</span>
              <span class="actions">
                <button class="icon-btn" title="Nova conversa nesta pasta" onClick={(e) => (e.stopPropagation(), startChat(f))}>
                  <Icon name="comment-discussion" />
                </button>
              </span>
            </div>
          ))}
          <div class="tree-row" style={{ paddingLeft: 40, color: 'var(--fg-muted)' }} onClick={() => (folderBrowser.value = { hostId: host.id, purpose: 'chat' })}>
            <Icon name="add" style={{ fontSize: 14 }} />
            <span class="label">Nova conversa em outra pasta…</span>
          </div>
        </>
      )}
    </>
  );
}

/** Diálogo para acrescentar um servidor ao ~/.ssh/config. */
export function AddHostDialog() {
  const [alias, setAlias] = useState('');
  const [hostName, setHostName] = useState('');
  const [user, setUser] = useState('root');
  const [port, setPort] = useState('22');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const aliasFocused = useRef(false);
  if (!addHostDialog.value) {
    aliasFocused.current = false;
    return null;
  }
  const close = () => (addHostDialog.value = false);
  const save = async () => {
    setBusy(true);
    try {
      const list = await rpc.call('hosts.add', { alias: alias.trim(), hostName: hostName.trim(), user: user.trim() || undefined, port: Number(port) || 22, identityFile: key.trim() || undefined });
      hosts.value = list;
      toast(`${alias} adicionado ao ~/.ssh/config (cópia de segurança em config.claude-deck.bak).`, 'success', 6000);
      close();
      connectHost(alias.trim()).catch(() => {});
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="overlay" onMouseDown={close}>
      <div class="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div class="dialog-head">
          <Icon name="remote" /> <span class="grow">Novo servidor SSH</span>
        </div>
        <div class="dialog-body">
          <div class="field">
            <label>Nome (alias)</label>
            <input
              ref={(el) => {
                // Foco na hora em que o campo aparece (autoFocus não vale para elementos inseridos depois).
                if (el && !aliasFocused.current) {
                  aliasFocused.current = true;
                  el.focus();
                }
              }}
              class="input"
              value={alias}
              onInput={(e) => setAlias((e.target as HTMLInputElement).value)}
              placeholder="MEU-SERVIDOR"
            />
          </div>
          <div class="field">
            <label>Endereço (HostName)</label>
            <input class="input" value={hostName} onInput={(e) => setHostName((e.target as HTMLInputElement).value)} placeholder="10.0.0.5 ou servidor.exemplo.com" />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div class="field" style={{ flex: 2 }}>
              <label>Usuário</label>
              <input class="input" value={user} onInput={(e) => setUser((e.target as HTMLInputElement).value)} />
            </div>
            <div class="field" style={{ flex: 1 }}>
              <label>Porta</label>
              <input class="input" value={port} onInput={(e) => setPort((e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <div class="field">
            <label>Chave (IdentityFile) — opcional</label>
            <input class="input" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} placeholder="~/.ssh/id_ed25519" />
            <span class="hint">Sem chave, o app tenta as chaves padrão e depois pede a senha.</span>
          </div>
        </div>
        <div class="dialog-foot">
          <button class="btn secondary" onClick={close}>
            Cancelar
          </button>
          <button class="btn" disabled={busy || !alias.trim() || !hostName.trim()} onClick={save}>
            Adicionar
          </button>
        </div>
      </div>
    </div>
  );
}

export { hostLabel };
