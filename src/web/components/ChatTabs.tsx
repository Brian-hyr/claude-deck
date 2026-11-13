// Abas de conversa (em cima): servidor, título, estado (trabalhando / pede permissão / terminou).
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  activateChat,
  activeChatId,
  chats,
  chatTitle,
  closeChat,
  confirmDialog,
  editorVisible,
  files,
  hostColor,
  hostLabel,
  isChatPinned,
  isPending,
  setConversationPending,
  moveChat,
  newChat,
  newChatPicker,
  openNewOrchestrator,
  orchestrations,
  orqOf,
  orqSupported,
  renameChat,
  renamingSid,
  setChatPinned,
  setTabGroupCollapsed,
  tabDragging,
  tabOrderStamp,
  tabStrip,
  toggleChatPinned,
  type ChatTab,
} from '../lib/state';
import { groupColor } from '../lib/tabOrder';
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

/** Marca de orquestração na aba: o orquestrador (com o estado) ou o worker (id da tarefa). */
function OrqTabMark({ c }: { c: ChatTab }) {
  const r = c.state.value.orq;
  if (!r) return null;
  const o = orqOf(c.state.value);
  if (r.role === 'orchestrator') {
    const attention = o && (o.status === 'awaiting_approval' || o.status === 'stalled' || o.status === 'waiting_user');
    return <Icon name="organization" class={`tab-orq${attention ? ' attention' : ''}`} title={o ? `Orquestrador · ${o.title}` : 'Orquestrador'} />;
  }
  return (
    <span class="tab-orq-worker" title={`Worker ${r.workerId ?? ''} da orquestração${o ? ` "${o.title}"` : ''}`}>
      {r.workerId ?? r.taskId}
    </span>
  );
}

/** Arrasto de abas: a aba (ou a âncora do grupo, ao arrastar a etiqueta) e onde ela está passando. */
interface TabDrag {
  dragSid: string | null;
  overKey: string | null;
  start: (sid: string) => void;
  end: () => void;
  over: (key: string) => void;
  /** Solta antes da aba `targetSid` (a posição dela na lista inteira, contando as escondidas). */
  drop: (targetSid: string) => void;
}

function ChatTabItem({ c, drag, groupColor: color }: { c: ChatTab; drag: TabDrag; groupColor?: string }) {
  const st = c.state.value;
  const active = c.sid === activeChatId.value;
  const editing = renamingSid.value === c.sid;
  const pinned = isChatPinned(c.sid);
  const otherPinned = chats.value.some((x) => x.sid !== c.sid && isChatPinned(x.sid));
  const pinnedLast = pinned && !isChatPinned(chats.value[chats.value.findIndex((x) => x.sid === c.sid) + 1]?.sid ?? '');
  const closeOthers = (keep: (x: ChatTab) => boolean) => chats.value.filter((x) => !keep(x) && !isChatPinned(x.sid)).forEach((x) => closeChat(x.sid, true));
  return (
    <div
      data-sid={c.sid}
      class={`tab${active ? ' active' : ''}${editing ? ' renaming' : ''}${pinned ? ' pinned' : ''}${pinnedLast ? ' pinned-last' : ''}${color ? ' in-group' : ''}${drag.overKey === c.sid && drag.dragSid !== c.sid ? ' drag-over' : ''}`}
      style={color ? { '--group-color': color } : undefined}
      title={`${chatTitle(c)}\n${hostLabel(st.hostId)} · ${st.cwd}${pinned ? '\nFixada: fica sempre no começo (arraste entre as fixadas para mudar a ordem)' : ''}\nDuplo clique ou F2 para renomear`}
      draggable={!editing}
      onDragStart={() => drag.start(c.sid)}
      onDragEnd={drag.end}
      onDragOver={(e) => {
        if (drag.dragSid) {
          e.preventDefault();
          drag.over(c.sid);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        drag.drop(c.sid);
      }}
      onClick={() => activateChat(c.sid)}
      // O 1º clique do duplo já ativou a aba (e o composer já pegou o foco): não reativar aqui.
      onDblClick={() => (renamingSid.value = c.sid)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          // Fixada não fecha pelo botão do meio (clique sem querer); só pelo menu.
          if (!pinned) closeChat(c.sid);
        }
      }}
      onContextMenu={(e) =>
        openMenu(e as any, [
          { label: 'Nova conversa na mesma pasta', icon: 'add', action: () => newChat(st.hostId, st.cwd) },
          { label: 'Renomear', icon: 'edit', kb: 'F2', action: () => (renamingSid.value = c.sid) },
          { label: pinned ? 'Desafixar aba' : 'Fixar aba (sempre no começo)', icon: pinned ? 'pinned' : 'pin', action: () => toggleChatPinned(c.sid) },
          {
            label: isPending(st.hostId, st.sessionId) ? 'Desmarcar pendência' : 'Marcar como pendente de visualização',
            icon: 'bookmark',
            disabled: !st.sessionId,
            action: () => void setConversationPending(st.hostId, st.sessionId, st.cwd, !isPending(st.hostId, st.sessionId)),
          },
          { separator: true },
          { label: 'Fechar', icon: 'close', kb: pinned ? undefined : 'Ctrl+Shift+W', action: () => closeChat(c.sid) },
          { label: `Fechar as outras${otherPinned ? ' (menos as fixadas)' : ''}`, action: () => closeOthers((x) => x.sid === c.sid) },
          { label: `Fechar todas de ${hostLabel(st.hostId)}${otherPinned || pinned ? ' (menos as fixadas)' : ''}`, action: () => closeOthers((x) => x.state.value.hostId !== st.hostId) },
        ])
      }
    >
      <TabStatus c={c} />
      <OrqTabMark c={c} />
      {isPending(st.hostId, st.sessionId) && <Icon name="bookmark" class="tab-manual-pending" title="Pendente de visualização" />}
      {editing ? <TabRename c={c} /> : <span class="tab-label">{chatTitle(c)}</span>}
      {pinned ? (
        <button
          class="close pin"
          title="Fixada — clique para desafixar"
          aria-label="Desafixar aba"
          onClick={(e) => {
            e.stopPropagation();
            setChatPinned(c.sid, false);
          }}
        >
          <i class="codicon codicon-pinned" />
        </button>
      ) : (
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
      )}
    </div>
  );
}

/** Estado das conversas escondidas no grupo recolhido, como o ícone da aba (o que pede você não fica escondido). */
function hiddenStatus(tabs: ChatTab[]): { icon: string; cls: string; title: string } | null {
  let running = 0;
  let done = 0;
  let error = 0;
  for (const c of tabs) {
    void c.version.value;
    const st = c.state.value;
    if (st.phase === 'error' || st.unseen === 'error') error++;
    else if (st.phase === 'running' || c.model.running) running++;
    else if (st.unseen === 'done') done++;
  }
  if (error) return { icon: 'error', cls: 'error', title: `${error} com erro` };
  if (done) return { icon: 'circle-filled', cls: 'done', title: `${done} terminou (não visto)` };
  if (running) return { icon: 'loading', cls: 'spin running', title: `${running} trabalhando` };
  return null;
}

function TabGroupView({ id, tabs, shown, collapsed, drag }: { id: string; tabs: ChatTab[]; shown: ChatTab[]; collapsed: boolean; drag: TabDrag }) {
  void orchestrations.value;
  const color = groupColor(id);
  const orchestrator = tabs.find((c) => c.state.value.orq?.role === 'orchestrator');
  const o = orqOf((orchestrator ?? tabs[0]).state.value);
  const title = o?.title ?? 'Orquestração';
  const anchor = (orchestrator ?? tabs[0]).sid;
  const hidden = tabs.filter((c) => !shown.includes(c));
  const status = collapsed ? hiddenStatus(hidden) : null;
  const key = `group:${id}`;
  const closeGroup = async () => {
    const ok = await confirmDialog(
      `Fechar as ${tabs.length} conversas do grupo?`,
      `Orquestração "${title}". As que estiverem trabalhando são interrompidas; o histórico fica salvo.`,
      'Fechar o grupo',
      true,
    );
    if (ok) for (const c of tabs) closeChat(c.sid, true);
  };
  return (
    <div class={`tab-group${collapsed ? ' collapsed' : ''}`} style={{ '--group-color': color }}>
      <div
        class={`tab-group-chip${drag.overKey === key ? ' drag-over' : ''}`}
        role="button"
        aria-expanded={!collapsed}
        title={`Orquestração "${title}" · ${tabs.length} conversas${collapsed && hidden.length ? ` (${hidden.length} escondida${hidden.length > 1 ? 's' : ''}${status ? `: ${status.title}` : ''})` : ''}\nClique para ${collapsed ? 'expandir' : 'recolher'} · arraste para mover o grupo${collapsed ? '\nRecolhido, as que esperam você e a aba ativa continuam à vista' : ''}`}
        draggable
        onDragStart={() => drag.start(anchor)}
        onDragEnd={drag.end}
        onDragOver={(e) => {
          if (drag.dragSid) {
            e.preventDefault();
            drag.over(key);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          drag.drop(tabs[0].sid);
        }}
        onClick={() => setTabGroupCollapsed(id, !collapsed)}
        onContextMenu={(e) =>
          openMenu(e as any, [
            { label: collapsed ? 'Expandir o grupo' : 'Recolher o grupo', icon: collapsed ? 'unfold' : 'fold', action: () => setTabGroupCollapsed(id, !collapsed) },
            { label: 'Ir para o orquestrador', icon: 'organization', disabled: !orchestrator, action: () => orchestrator && activateChat(orchestrator.sid) },
            { separator: true },
            { label: `Fechar o grupo (${tabs.length} conversas)…`, icon: 'close-all', danger: true, action: () => void closeGroup() },
          ])
        }
      >
        <Icon name="organization" />
        <span class="tab-group-label">{title}</span>
        {collapsed && <span class="tab-group-count">{tabs.length}</span>}
        {status && <Icon name={status.icon} class={`tab-group-status ${status.cls}`} />}
        <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} class="tab-group-chevron" />
      </div>
      {shown.map((c) => (
        <ChatTabItem key={c.sid} c={c} drag={drag} groupColor={color} />
      ))}
    </div>
  );
}

export function ChatTabs() {
  const [dragSid, setDragSid] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const list = chats.value;
  for (const c of list) void c.version.value; // o título pode vir da 1ª mensagem (modelo)
  const strip = tabStrip.value;
  const drag: TabDrag = {
    dragSid,
    overKey,
    start: (sid) => (setDragSid(sid), (tabDragging.value = true)),
    end: () => (setDragSid(null), setOverKey(null), (tabDragging.value = false)),
    over: setOverKey,
    drop: (targetSid) => {
      const to = chats.peek().findIndex((x) => x.sid === targetSid);
      if (dragSid && dragSid !== targetSid && to >= 0) moveChat(dragSid, to);
      setDragSid(null);
      setOverKey(null);
    },
  };
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
        {strip.segments.map((s) =>
          s.kind === 'tab' ? (
            <ChatTabItem key={s.tab.sid} c={s.tab} drag={drag} />
          ) : (
            <TabGroupView key={s.key} id={s.id} tabs={s.tabs} shown={s.shown} collapsed={s.collapsed} drag={drag} />
          ),
        )}
      </div>
      <div class="tabs-actions">
        <button
          class="icon-btn"
          title="Nova conversa (Ctrl+Shift+N) — clique com botão direito para escolher motor"
          onClick={() => (newChatPicker.value = {})}
          onContextMenu={(e) =>
            openMenu(e, [
              { label: 'Nova conversa (Claude Code)', icon: 'hubot', action: () => (newChatPicker.value = { engine: 'claude' }) },
              { label: 'Nova conversa (Antigravity CLI)', icon: 'sparkle', action: () => (newChatPicker.value = { engine: 'antigravity' }) },
            ])
          }
        >
          <Icon name="add" />
        </button>
        {orqSupported.value && (
          <button class="icon-btn" title="Novo orquestrador: divide uma tarefa grande em várias conversas e acompanha até concluir" onClick={() => openNewOrchestrator()}>
            <Icon name="organization" />
          </button>
        )}
        {!editorVisible.value && files.value.length > 0 && (
          <button class="icon-btn" title="Mostrar arquivos abertos" onClick={() => (editorVisible.value = true)}>
            <Icon name="layout-sidebar-right" />
          </button>
        )}
      </div>
    </div>
  );
}
