// Gancho da lista virtual do explorador: diz quais linhas montar, conforme a rolagem.
// A lista fica dentro de um contêiner que rola (`.tree-scroller`) junto com outras (pastas fixadas),
// por isso a posição é medida na tela em vez de assumir que a lista começa no topo.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { signal } from '@preact/signals';
import { visibleRange } from './treeRows';

/** Sobe quando o tamanho de uma lista muda: as outras listas (acima/abaixo dela) mudam de posição e recalculam. */
const layoutTick = signal(0);

const INITIAL_ROWS = 40;

export function useRowWindow(body: RefObject<HTMLElement>, count: number): [number, number] {
  void layoutTick.value; // assina: re-renderiza quando outra lista muda de tamanho
  const [range, setRange] = useState<[number, number]>(() => [0, Math.min(count, INITIAL_ROWS)]);
  const countRef = useRef(count);
  countRef.current = count;
  const scrollerRef = useRef<HTMLElement | null>(null);

  const measure = useRef(() => {});
  measure.current = () => {
    const el = body.current;
    const sc = scrollerRef.current;
    // Ainda não achou o contêiner rolável (1ª montagem): fica com as primeiras linhas, nunca monta tudo.
    if (!el || !sc) return;
    const r = visibleRange(sc.getBoundingClientRect().top - el.getBoundingClientRect().top, sc.clientHeight, countRef.current);
    setRange((p) => (p[0] === r[0] && p[1] === r[1] ? p : r));
  };

  // A cada renderização: dois getBoundingClientRect. Pega o que muda a posição sem rolar (pasta acima abriu/fechou).
  useLayoutEffect(() => {
    measure.current();
  });

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const sc = el.closest('.tree-scroller') as HTMLElement | null;
    scrollerRef.current = sc;
    measure.current();
    if (!sc) return;
    let raf = 0;
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), measure.current()));
    };
    sc.addEventListener('scroll', schedule, { passive: true });
    const roScroller = new ResizeObserver(schedule);
    roScroller.observe(sc);
    const roBody = new ResizeObserver(() => {
      layoutTick.value++;
    });
    roBody.observe(el);
    return () => {
      sc.removeEventListener('scroll', schedule);
      roScroller.disconnect();
      roBody.disconnect();
      if (raf) cancelAnimationFrame(raf);
      scrollerRef.current = null;
    };
  }, []);

  return range;
}
