// Markdown renderizado com links e caminhos de arquivo clicáveis.
import { memo } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';
import { copyToClipboard, renderMarkdown, wireCodeCopy } from '../lib/markdown';
import { extractHintDirs, looksLikeFolderPath } from '../lib/pathHints';
import { toast } from '../lib/state';

const PATH_RE = /^(?:~|\.{1,2}|[A-Za-z]:)?[\\/]?(?:[\w.@-]+[\\/])*[\w.@-]+\.[A-Za-z0-9]{1,10}(?::(\d+)(?::\d+)?)?$/;

/**
 * `hints`: pastas citadas no mesmo texto, para achar o arquivo quando só o nome vem escrito.
 * `folderLinks` (padrão: ligado): caminho de pasta também vira link. Quem recebe `onOpenPath` precisa saber
 * abrir pasta; a visualização de um .md no editor não sabe, então desliga.
 */
export const Markdown = memo(function Markdown(props: {
  text: string;
  onOpenPath?: (path: string, line?: number, hints?: string[]) => void;
  class?: string;
  imgResolver?: (src: string) => string | null;
  folderLinks?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(props.text, props.imgResolver);
  const folders = props.folderLinks !== false;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    wireCodeCopy(el);
    el.querySelectorAll('code').forEach((c) => {
      if (c.closest('pre')) return;
      const t = c.textContent?.trim() ?? '';
      const isPath = t.length < 200 && ((PATH_RE.test(t) && !/^\d+\.\d+/.test(t)) || (folders && looksLikeFolderPath(t)));
      if (props.onOpenPath && isPath) {
        c.classList.add('path-link');
        c.setAttribute('title', 'Clique para abrir o arquivo · Duplo clique para copiar');
      } else if (!c.getAttribute('title')) {
        c.setAttribute('title', 'Duplo clique para copiar');
      }
    });
    el.querySelectorAll('a').forEach((a) => {
      if (!a.getAttribute('title')) {
        a.setAttribute('title', 'Clique para abrir · Duplo clique para copiar');
      }
    });
  }, [html, folders]);
  return (
    <div
      ref={ref}
      class={`md ${props.class ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const a = target.closest('a') as HTMLAnchorElement | null;
        if (a) {
          const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
          if (/^(https?:|mailto:)/i.test(href)) return; // abre em nova aba (target=_blank)
          e.preventDefault();
          if (props.onOpenPath && href && !href.startsWith('#')) {
            const m = href.match(/^(.*?)(?:#L(\d+)|:(\d+))?$/);
            props.onOpenPath(decodeURIComponent(m?.[1] ?? href), Number(m?.[2] ?? m?.[3]) || undefined, extractHintDirs(props.text));
          }
          return;
        }
        if (target.tagName === 'CODE' && target.classList.contains('path-link') && props.onOpenPath) {
          const t = target.textContent!.trim();
          const m = t.match(/^(.*?)(?::(\d+))?(?::\d+)?$/);
          props.onOpenPath(m?.[1] ?? t, Number(m?.[2]) || undefined, extractHintDirs(props.text));
        }
      }}
      onDblClick={(e) => {
        const target = e.target as HTMLElement;
        const code = target.closest('code, kbd, mark') as HTMLElement | null;
        const a = target.closest('a') as HTMLAnchorElement | null;

        let textToCopy = '';
        let targetEl: HTMLElement | null = null;

        if (code && !code.closest('pre')) {
          textToCopy = code.textContent?.trim() ?? '';
          targetEl = code;
        } else if (a) {
          textToCopy = a.getAttribute('data-href') || a.getAttribute('href') || a.textContent?.trim() || '';
          targetEl = a;
        }

        if (textToCopy && targetEl) {
          e.preventDefault();
          e.stopPropagation();
          window.getSelection()?.removeAllRanges();

          copyToClipboard(textToCopy).then((ok) => {
            if (!ok) return;
            targetEl!.classList.add('code-copied');
            setTimeout(() => targetEl?.classList.remove('code-copied'), 1200);
            const preview = textToCopy.length > 40 ? textToCopy.slice(0, 37) + '…' : textToCopy;
            toast(`Copiado: ${preview}`, 'success', 2000);
          });
        }
      }}
    />
  );
});
