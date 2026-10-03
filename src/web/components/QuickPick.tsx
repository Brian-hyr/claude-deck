// Lista com busca no estilo da paleta do VS Code (Ctrl+P, Ctrl+Shift+P, nova conversa).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { fuzzyScore } from '../lib/format';
import { Icon } from './icons';

export interface QPItem {
  id: string;
  label: string;
  desc?: string;
  icon?: string | ComponentChildren;
  kb?: string;
  group?: string;
  /** Texto usado na busca (padrão: label + desc). */
  search?: string;
  alwaysShow?: boolean;
}

export function QuickPick(props: {
  title?: ComponentChildren;
  placeholder?: string;
  items: QPItem[];
  onPick: (item: QPItem, query: string) => void;
  onClose: () => void;
  onQuery?: (q: string) => void;
  initialQuery?: string;
  emptyText?: string;
  limit?: number;
  loading?: boolean;
  /** Se definido, Enter com a busca sem itens chama isso (ex.: digitar um caminho). */
  onSubmitRaw?: (q: string) => void;
}) {
  const [q, setQ] = useState(props.initialQuery ?? '');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const limit = props.limit ?? 200;

  const filtered = useMemo(() => {
    if (!q.trim()) return props.items.slice(0, limit);
    const scored: { it: QPItem; s: number }[] = [];
    for (const it of props.items) {
      if (it.alwaysShow) {
        scored.push({ it, s: -1e9 });
        continue;
      }
      const s = fuzzyScore(q.trim(), it.search ?? `${it.label} ${it.desc ?? ''}`);
      if (s >= 0) scored.push({ it, s });
    }
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.it);
  }, [q, props.items, limit]);

  // Foco imediato (antes da pintura): o que for digitado logo após abrir não se perde.
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.qp-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 10, filtered.length - 1));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 10, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Caminho digitado (/..., ~..., C:\...) vai direto, sem precisar existir na lista.
      if (props.onSubmitRaw && /^([A-Za-z]:[\\/]|\/|~)/.test(q.trim())) {
        props.onSubmitRaw(q.trim());
        return;
      }
      const it = filtered[active];
      if (it) props.onPick(it, q);
      else props.onSubmitRaw?.(q);
    }
  };

  let lastGroup: string | undefined;
  return (
    <div class="overlay top" onMouseDown={props.onClose}>
      <div class="quickpick" onMouseDown={(e) => e.stopPropagation()} role="dialog">
        {props.title && <div class="qp-title">{props.title}</div>}
        <input
          ref={inputRef}
          value={q}
          placeholder={props.placeholder}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setQ(v);
            props.onQuery?.(v);
          }}
          onKeyDown={onKey}
          spellcheck={false}
          autocomplete="off"
        />
        <div class="qp-list" ref={listRef}>
          {props.loading && <div class="tree-loading" />}
          {!filtered.length && !props.loading && <div class="qp-empty">{props.emptyText ?? 'Nada encontrado.'}</div>}
          {filtered.map((it, i) => {
            const showGroup = it.group && it.group !== lastGroup;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {showGroup && <div class="qp-sep">{it.group}</div>}
                <div class={`qp-item${i === active ? ' active' : ''}`} onMouseMove={() => i !== active && setActive(i)} onClick={() => props.onPick(it, q)}>
                  {typeof it.icon === 'string' ? <Icon name={it.icon} /> : it.icon}
                  <span class="label">{it.label}</span>
                  {it.desc && <span class="desc">{it.desc}</span>}
                  {it.kb && <span class="kb">{it.kb}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
