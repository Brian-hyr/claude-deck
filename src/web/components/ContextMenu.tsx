// Menu de contexto (botão direito) e quick pick genérico.
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';

export interface MenuItem {
  label?: string;
  icon?: string;
  kb?: string;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  action?: () => void;
}

const menuState = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);

export function openMenu(e: MouseEvent | { clientX: number; clientY: number }, items: MenuItem[]) {
  if ('preventDefault' in e) {
    (e as MouseEvent).preventDefault();
    (e as MouseEvent).stopPropagation();
  }
  menuState.value = { x: e.clientX, y: e.clientY, items };
}

export function ContextMenuHost() {
  const m = menuState.value;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!m) return;
    const close = () => (menuState.value = null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [m]);
  useEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.min(m.x, window.innerWidth - r.width - 4), top: Math.min(m.y, window.innerHeight - r.height - 4) });
  }, [m]);
  if (!m) return null;
  return (
    <div
      ref={ref}
      class="ctxmenu"
      style={{ left: pos?.left ?? m.x, top: pos?.top ?? m.y, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {m.items.map((it, i) =>
        it.separator ? (
          <div key={i} class="sep" />
        ) : (
          <div
            key={i}
            class={`mi${it.danger ? ' danger' : ''}`}
            style={it.disabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}
            onClick={() => {
              menuState.value = null;
              it.action?.();
            }}
          >
            {it.icon ? <Icon name={it.icon} /> : <span style={{ width: 16 }} />}
            <span>{it.label}</span>
            {it.kb && <span class="kb">{it.kb}</span>}
          </div>
        ),
      )}
    </div>
  );
}
