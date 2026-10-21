// Lista das mensagens fixadas da conversa. Clicar numa leva até ela no chat (só rola e destaca: não escreve
// na caixa de mensagem nem manda nada ao Claude). Mesmo molde do menu de atenção da barra de status.
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { chats, jumpToMessage, pinsFor, setMessagePinned } from '../lib/state';
import { formatSentAt } from '../lib/chatModel';
import { Icon, ClaudeLogo } from './icons';

/** Conversa cujo menu está aberto e onde ele nasce (canto inferior direito do botão do cabeçalho). */
export const pinsMenu = signal<{ sid: string; right: number; top: number } | null>(null);

/** Clicar no botão abre a lista; clicar de novo fecha. */
export function togglePinsMenu(sid: string, anchor: HTMLElement) {
  if (pinsMenu.value?.sid === sid) {
    pinsMenu.value = null;
    return;
  }
  const r = anchor.getBoundingClientRect();
  pinsMenu.value = { sid, right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 2 };
}

/** `refocus`: depois de fechar pelo teclado o cursor volta para a caixa de mensagem. */
function closePinsMenu(refocus = false) {
  pinsMenu.value = null;
  if (refocus) window.dispatchEvent(new CustomEvent('deck:focus-composer'));
}

function PinsPopup({ sid, right, top }: { sid: string; right: number; top: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const c = chats.value.find((x) => x.sid === sid);
  const st = c?.state.value;
  // Mais recente primeiro: é o que acabou de ser fixado que se quer rever.
  const pins = st ? [...pinsFor(st.hostId, st.sessionId)].sort((a, b) => b.pinnedAt - a.pinnedAt) : [];

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('.pins-menu, .pins-toggle')) closePinsMenu();
    };
    const onClose = () => closePinsMenu();
    // Esc na janela toda (fase de captura): depois de clicar no ✕ a linha some e leva o foco junto, e mesmo assim
    // Esc tem que fechar só o menu — na caixa de mensagem ele interromperia o Claude.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closePinsMenu(true);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    window.addEventListener('keydown', onEsc, true);
    ref.current?.focus();
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, []);

  // A conversa foi fechada com o menu aberto.
  useEffect(() => {
    if (!c) closePinsMenu();
  }, [!c]);

  if (!c || !st) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('.pin-main') ?? [])];
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    rows[e.key === 'ArrowDown' ? (i + 1) % rows.length : i <= 0 ? rows.length - 1 : i - 1].focus();
  };

  return (
    <div ref={ref} class="pins-menu" role="menu" tabIndex={-1} style={{ right, top }} onKeyDown={onKeyDown}>
      <div class="pins-head">Mensagens fixadas{pins.length ? ` (${pins.length})` : ''}</div>
      {!pins.length && (
        <div class="pins-empty">Nenhuma mensagem fixada. Passe o mouse sobre uma mensagem e clique no alfinete para guardá-la aqui.</div>
      )}
      {pins.map((p) => (
        <div key={p.anchor} class="pin-row">
          <button
            type="button"
            role="menuitem"
            class="pin-main"
            title={`${p.snippet || 'Mensagem'}\n\nClique para ir até ela na conversa`}
            onClick={() => {
              closePinsMenu();
              jumpToMessage(sid, p.anchor);
            }}
          >
            {p.role === 'user' ? <Icon name="account" /> : <ClaudeLogo size={13} />}
            <span class="attn-text">
              <span class="attn-title">{p.snippet || (p.role === 'user' ? 'Sua mensagem' : 'Resposta do Claude')}</span>
              <span class="attn-sub">
                {p.role === 'user' ? 'Você' : 'Claude'}
                {p.at !== undefined ? ` · ${formatSentAt(p.at)}` : ''}
              </span>
            </span>
          </button>
          <button
            type="button"
            class="pin-remove"
            title="Desafixar"
            aria-label="Desafixar"
            onClick={() => {
              void setMessagePinned(st.hostId, st.sessionId, { anchor: p.anchor, role: p.role, snippet: p.snippet, at: p.at }, false);
              // A linha some e levaria o foco junto: fica no menu, para as setas continuarem funcionando.
              ref.current?.focus();
            }}
          >
            <Icon name="close" style={{ fontSize: 12 }} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function PinsMenu() {
  const m = pinsMenu.value;
  return m ? <PinsPopup sid={m.sid} right={m.right} top={m.top} /> : null;
}
