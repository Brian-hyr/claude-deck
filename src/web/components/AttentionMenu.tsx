// Menu que abre para cima a partir da barra de status: lista as conversas desta janela que esperam
// você (permissão, pergunta, plano) ou que terminaram sem ninguém ver, e leva direto até a escolhida,
// sem procurar entre as abas.
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { activateChat, chats, chatTitle, isPending, type ChatTab } from '../lib/state';
import { chatActivity } from '../lib/activity';
import { firstLine, timeAgo, truncate } from '../lib/format';
import type { ToolItem } from '../lib/chatModel';
import { Icon } from './icons';

/** `waiting`: esperando você. `finished`: terminou (ou terminou com erro) e ainda não foi vista. */
export type AttentionKind = 'waiting' | 'finished' | 'pending';

export interface AttentionLists {
  waiting: ChatTab[];
  finished: ChatTab[];
  pending: ChatTab[];
}

/**
 * Conversas desta janela que pedem você, na ordem das abas. Cada uma entra numa lista só, pelo estado
 * mais urgente (`chatActivity`): esperando resposta vale mais que "terminou", e conversa trabalhando
 * em outro turno não entra em nenhuma. Assina o que a tela precisa para atualizar sozinha.
 */
export function attentionLists(): AttentionLists {
  const waiting: ChatTab[] = [];
  const finished: ChatTab[] = [];
  const pending: ChatTab[] = [];
  for (const c of chats.value) {
    void c.version.value; // `pendingCount` e `running` não são signals: a versão avisa
    const st = c.state.value;
    const kind = chatActivity({ attention: c.attention.value, pendingCount: c.model.pendingCount, phase: st.phase, modelRunning: c.model.running, unseen: st.unseen, manualPending: isPending(st.hostId, st.sessionId) });
    if (kind === 'waiting') waiting.push(c);
    else if (kind === 'pending') pending.push(c);
    else if (kind === 'done' || kind === 'error') finished.push(c);
  }
  return { waiting, finished, pending };
}

/** Qual menu está aberto e de onde ele sai (borda esquerda do item da barra de status). */
export const attentionMenu = signal<{ kind: AttentionKind; left: number } | null>(null);

/** Clicar no item abre o menu dele; clicar de novo (ou no outro item) fecha/troca. */
export function toggleAttentionMenu(kind: AttentionKind, anchor: HTMLElement) {
  if (attentionMenu.value?.kind === kind) {
    attentionMenu.value = null;
    return;
  }
  attentionMenu.value = { kind, left: anchor.getBoundingClientRect().left };
}

/** `refocus`: depois de fechar pelo teclado o cursor volta para a caixa de mensagem. */
function closeAttentionMenu(refocus = false) {
  attentionMenu.value = null;
  if (refocus) window.dispatchEvent(new CustomEvent('deck:focus-composer'));
}

/** O que a conversa está pedindo, em uma linha. */
function pendingLabel(c: ChatTab): string {
  const t = c.model.pendingPermissions.values().next().value as ToolItem | undefined;
  if (!t) return 'Esperando sua resposta';
  if (t.name === 'AskUserQuestion') return 'Pergunta para você';
  if (t.name === 'ExitPlanMode') return 'Plano para você aprovar';
  const more = c.model.pendingCount - 1;
  return `Pede permissão: ${t.permission?.displayName ?? t.name}${more > 0 ? ` (+${more})` : ''}`;
}

function rowInfo(c: ChatTab, kind: AttentionKind): { icon: string; cls: string; sub: string } {
  const st = c.state.value;
  if (kind === 'waiting') return { icon: 'bell-dot', cls: 'perm pulse', sub: pendingLabel(c) };
  if (kind === 'pending') return { icon: 'bookmark', cls: 'manual-pending', sub: 'Marcada para ver depois' };
  if (st.unseen === 'error') {
    const why = st.error ? `: ${truncate(firstLine(st.error), 90)}` : '';
    return { icon: 'error', cls: 'error', sub: `Terminou com erro${why}` };
  }
  return { icon: 'circle-filled', cls: 'done', sub: `Terminou ${st.lastActivityAt ? timeAgo(st.lastActivityAt) : ''}`.trim() };
}

function AttentionPopup({ kind, left: anchorLeft }: { kind: AttentionKind; left: number }) {
  const lists = attentionLists();
  const items = kind === 'waiting' ? lists.waiting : kind === 'pending' ? lists.pending : lists.finished;
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    // Mesmo padrão do menu de contexto. Clicar nos itens da barra de status não fecha aqui: eles
    // decidem sozinhos (abrir, fechar ou trocar de menu).
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('.attn-menu, .sb-attn')) closeAttentionMenu();
    };
    const onClose = () => closeAttentionMenu();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    // O foco vai para o menu: Esc fecha só o menu (na caixa de mensagem, Esc interromperia o Claude).
    ref.current?.focus();
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, []);

  // Última conversa da lista foi vista (ou fechada) com o menu aberto: não sobra o que mostrar.
  useEffect(() => {
    if (!items.length) closeAttentionMenu();
  }, [items.length]);

  // Mantém o menu dentro da janela (o item pode estar perto da borda direita).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setLeft(Math.max(8, Math.min(anchorLeft, window.innerWidth - el.getBoundingClientRect().width - 8)));
  }, [anchorLeft, kind, items.length]);

  if (!items.length) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAttentionMenu(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('.attn-row') ?? [])];
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    rows[e.key === 'ArrowDown' ? (i + 1) % rows.length : i <= 0 ? rows.length - 1 : i - 1].focus();
  };

  return (
    <div ref={ref} class="attn-menu" role="menu" tabIndex={-1} style={{ left: left ?? anchorLeft }} onKeyDown={onKeyDown}>
      <div class="attn-head">{kind === 'waiting' ? `Esperando você (${items.length})` : kind === 'pending' ? `Pendentes de visualização (${items.length})` : `Concluídas, ainda não vistas (${items.length})`}</div>
      {items.map((c) => {
        const info = rowInfo(c, kind);
        const title = chatTitle(c);
        return (
          <button
            key={c.sid}
            type="button"
            role="menuitem"
            class="attn-row"
            title={`${title}\n${info.sub}`}
            onClick={() => {
              // O foco sai do menu que fecha: a conversa aberta já recebe o cursor na caixa de mensagem.
              closeAttentionMenu(true);
              activateChat(c.sid);
            }}
          >
            <Icon name={info.icon} class={info.cls} />
            <span class="attn-text">
              <span class="attn-title">{title}</span>
              <span class="attn-sub">{info.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AttentionMenu() {
  const m = attentionMenu.value;
  return m ? <AttentionPopup kind={m.kind} left={m.left} /> : null;
}
