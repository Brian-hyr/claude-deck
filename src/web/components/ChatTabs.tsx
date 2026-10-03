// Abas de conversa (em cima): servidor, título, estado (trabalhando / pede permissão / terminou).
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  activateChat,
  activeChatId,
  chats,
  chatTitle,
  closeChat,
  editorVisible,
  files,
  hostColor,
  hostLabel,
  isPending,
  setConversationPending,
  moveChat,
  newChat,
  newChatPicker,
  renameChat,
  renamingSid,
  tabDragging,
  tabOrderStamp,
  type ChatTab,
} from '../lib/state';
import { Icon } from './icons';
import { openMenu } from './ContextMenu';

/** Nome da aba virando campo de texto: Enter/clicar fora grava, Esc cancela, vazio mantém o nome. */
function TabRename({ c }: { c: ChatTab }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false); // Enter/Esc/blur disparam em sequência: só o primeiro vale.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = ref.current?.value ?? '';
    renamingSid.value = null;
    if (save) void renameChat(c, value);
  };
  return (
    <input
      ref={ref}
      class="tab-rename"
      defaultValue={chatTitle(c)}
      maxLength={200}
      spellcheck={false}
      title="Enter grava · Esc cancela"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.isComposing) finish(true);
        else if (e.key === 'Escape') finish(false);
        e.stopPropagation(); // atalhos globais (Ctrl+Tab, Alt+1…) não podem roubar a digitação
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    />
  );
}

function TabStatus({ c }: { c: ChatTab }) {
  const st = c.state.value;
  void c.version.value;
  const att = c.attention.value;
  if (att === 'permission' || c.model.pendingCount)
    return (
      <span class="tab-status" title="Esperando sua permissão">
        <Icon name="bell-dot" class="perm pulse" />
      </span>
    );
  const procStart = st.processStartedAt ?? (st.phase !== 'ended' && st.phase !== 'dormant' ? (st.createdAt ?? 0) : undefined);
  const runningAgents = c.model.runningAgents(procStart);
  if (st.phase === 'running' || c.model.running || runningAgents.length > 0)
    return (
      <span class="tab-status" title="Trabalhando">
        <Icon name="loading" class="spin" style={{ color: 'var(--claude)' }} />
      </span>
    );
  if (st.phase === 'starting' || st.phase === 'reconnecting')
    return (
      <span class="tab-status" title={st.phase === 'starting' ? 'Iniciando' : 'Reconectando'}>
        <Icon name="sync" class="spin" style={{ color: 'var(--warn)' }} />
      </span>
    );
  // "Terminou e não vi" vem do servidor (`unseen`), que guarda até você abrir a conversa.
  if (st.phase === 'error' || st.unseen === 'error')
    return (
      <span class="tab-status" title={st.error ?? (st.unseen === 'error' ? 'Terminou com erro (não visto)' : 'Erro')}>
        <Icon name="error" class="error" />
      </span>
    );
  if (st.unseen === 'done')
    return (
      <span class="tab-status" title="Terminou (não visto)">
        <Icon name="circle-filled" class="done" style={{ fontSize: 10 }} />
      </span>
    );
  return (
    <span class="tab-status">
      <Icon name="comment" style={{ color: st.hostId !== 'local' ? hostColor(st.hostId) : 'var(--fg-faint)' }} />
    </span>
  );
}

export function ChatTabs() {
  const [dragSid, setDragSid] = useState<string | null>(null);
  const [overSid, setOverSid] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const list = chats.value;
  for (const c of list) void c.version.value; // o título pode vir da 1ª mensagem (modelo)
  // Depois de reordenar, a aba ativa pode ter ido parar fora da faixa visível: traz de volta.
  const orderStamp = tabOrderStamp.value;
  useLayoutEffect(() => {
    if (!orderStamp) return;
    scrollRef.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [orderStamp]);
  // Conversa aberta por fora das abas (menu da barra de status, Alt+número): a aba dela pode estar
  // fora da faixa visível. Clicar numa aba já visível não mexe na rolagem (`nearest`).
  const activeId = activeChatId.value;
  useLayoutEffect(() => {
    scrollRef.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);
  return (
    <div class="tabs">
      <div ref={scrollRef} class="tabs-scroll" onWheel={(e) => ((e.currentTarget as HTMLElement).scrollLeft += e.deltaY)}>
        {list.map((c, i) => {
          const st = c.state.value;
          const active = c.sid === activeChatId.value;
          const editing = renamingSid.value === c.sid;
          return (
            <div
              key={c.sid}
              class={`tab${active ? ' active' : ''}${editing ? ' renaming' : ''}${overSid === c.sid && dragSid !== c.sid ? ' drag-over' : ''}`}
              title={`${chatTitle(c)}\n${hostLabel(st.hostId)} · ${st.cwd}\nDuplo clique ou F2 para renomear`}
              draggable={!editing}
              onDragStart={() => (setDragSid(c.sid), (tabDragging.value = true))}
              onDragEnd={() => (setDragSid(null), setOverSid(null), (tabDragging.value = false))}
              onDragOver={(e) => {
                if (dragSid) {
                  e.preventDefault();
                  setOverSid(c.sid);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragSid && dragSid !== c.sid) moveChat(dragSid, i);
                setDragSid(null);
                setOverSid(null);
              }}
              onClick={() => activateChat(c.sid)}
              // O 1º clique do duplo já ativou a aba (e o composer já pegou o foco): não reativar aqui.
              onDblClick={() => (renamingSid.value = c.sid)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeChat(c.sid);
                }
              }}
              onContextMenu={(e) =>
                openMenu(e as any, [
                  { label: 'Nova conversa na mesma pasta', icon: 'add', action: () => newChat(st.hostId, st.cwd) },
                  { label: 'Renomear', icon: 'edit', kb: 'F2', action: () => (renamingSid.value = c.sid) },
                  {
                    label: isPending(st.hostId, st.sessionId) ? 'Desmarcar pendência' : 'Marcar como pendente de visualização',
                    icon: 'bookmark',
                    disabled: !st.sessionId,
                    action: () => void setConversationPending(st.hostId, st.sessionId, st.cwd, !isPending(st.hostId, st.sessionId)),
                  },
                  { separator: true },
                  { label: 'Fechar', icon: 'close', kb: 'Ctrl+Shift+W', action: () => closeChat(c.sid) },
                  { label: 'Fechar as outras', action: () => chats.value.filter((x) => x.sid !== c.sid).forEach((x) => closeChat(x.sid, true)) },
                  { label: `Fechar todas de ${hostLabel(st.hostId)}`, action: () => chats.value.filter((x) => x.state.value.hostId === st.hostId).forEach((x) => closeChat(x.sid, true)) },
                ])
              }
            >
              <TabStatus c={c} />
              {isPending(st.hostId, st.sessionId) && <Icon name="bookmark" class="tab-manual-pending" title="Pendente de visualização" />}
              {editing ? <TabRename c={c} /> : <span class="tab-label">{chatTitle(c)}</span>}
              <button
                class="close"
                title="Fechar conversa"
                onClick={(e) => {
                  e.stopPropagation();
                  closeChat(c.sid);
                }}
              >
                <i class="codicon codicon-close" />
              </button>
            </div>
          );
        })}
      </div>
      <div class="tabs-actions">
        <button class="icon-btn" title="Nova conversa (Ctrl+Shift+N)" onClick={() => (newChatPicker.value = {})}>
          <Icon name="add" />
        </button>
        {!editorVisible.value && files.value.length > 0 && (
          <button class="icon-btn" title="Mostrar arquivos abertos" onClick={() => (editorVisible.value = true)}>
            <Icon name="layout-sidebar-right" />
          </button>
        )}
      </div>
    </div>
  );
}
