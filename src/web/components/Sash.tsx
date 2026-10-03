// Divisória arrastável entre painéis (como no VS Code).
import { useRef, useState } from 'preact/hooks';

export function Sash(props: {
  onDrag: (delta: number, start: number) => void;
  getStart: () => number;
  onDoubleClick?: () => void;
  orientation?: 'vertical' | 'horizontal';
}) {
  const [drag, setDrag] = useState(false);
  const startPos = useRef(0);
  const startVal = useRef(0);
  const horizontal = props.orientation === 'horizontal';
  return (
    <div
      class={`sash${horizontal ? ' sash-horiz' : ''}${drag ? ' dragging' : ''}`}
      onDblClick={props.onDoubleClick}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        startPos.current = horizontal ? e.clientY : e.clientX;
        startVal.current = props.getStart();
        setDrag(true);
        document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize';
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const current = horizontal ? e.clientY : e.clientX;
        props.onDrag(current - startPos.current, startVal.current);
      }}
      onPointerUp={(e) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        setDrag(false);
        document.body.style.cursor = '';
      }}
    />
  );
}
