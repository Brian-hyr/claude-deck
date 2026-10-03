// Markdown seguro (marked + DOMPurify) com destaque de código (highlight.js, linguagens comuns).
import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const LANG_ALIAS: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  yml: 'yaml',
  md: 'markdown',
  html: 'xml',
  htm: 'xml',
  vue: 'xml',
  svelte: 'xml',
  svg: 'xml',
  cs: 'csharp',
  'c++': 'cpp',
  h: 'c',
  hpp: 'cpp',
  rs: 'rust',
  kt: 'kotlin',
  dockerfile: 'dockerfile',
  conf: 'ini',
  toml: 'ini',
  env: 'bash',
  jsonc: 'json',
  jsonl: 'json',
  sql: 'sql',
  prisma: 'typescript',
};

export function normalizeLang(lang?: string): string | undefined {
  if (!lang) return undefined;
  const l = lang.toLowerCase().trim().split(/\s+/)[0];
  const a = LANG_ALIAS[l] ?? l;
  return hljs.getLanguage(a) ? a : undefined;
}

export function highlightCode(code: string, lang?: string): string {
  const l = normalizeLang(lang);
  if (code.length > 200_000) return escapeHtml(code);
  try {
    if (l) return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
  } catch {
    /* cai no texto puro */
  }
  return escapeHtml(code);
}

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const l = normalizeLang(lang);
      const label = (lang ?? '').split(/\s+/)[0] || 'texto';
      return (
        `<div class="md-code"><div class="md-code-head"><span>${escapeHtml(label)}</span>` +
        `<button class="md-copy" type="button" title="Copiar"><i class="codicon codicon-copy"></i></button></div>` +
        `<pre><code class="hljs${l ? ` language-${l}` : ''}">${highlightCode(text, lang)}</code></pre></div>`
      );
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${t} data-href="${escapeHtml(href)}">${text}</a>`;
    },
    // Listas de tarefas: <input> é removido pelo DOMPurify, então a caixinha vira um <span>.
    listitem(item: Tokens.ListItem) {
      const body = this.parser.parse(item.tokens);
      return item.task ? `<li class="md-task">${body}</li>\n` : `<li>${body}</li>\n`;
    },
    checkbox({ checked }: Tokens.Checkbox) {
      return `<span class="md-check${checked ? ' on' : ''}" aria-hidden="true"></span>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer');
    node.setAttribute('target', '_blank');
  }
});

const cache = new Map<string, string>();

/** Markdown -> HTML sanitizado. `imgResolver` reescreve src de imagens relativas. */
export function renderMarkdown(text: string, imgResolver?: (src: string) => string | null): string {
  const key = imgResolver ? '' : text;
  if (key && cache.has(key)) return cache.get(key)!;
  let html = md.parse(text, { async: false }) as string;
  html = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-href'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    ALLOW_DATA_ATTR: true,
    ADD_TAGS: [],
  });
  // O botão de copiar é nosso (o DOMPurify remove <button>): recoloca depois.
  html = html.replace(/<div class="md-code-head"><span>([^<]*)<\/span>(<i class="codicon codicon-copy"><\/i>)?<\/div>/g, (_m, label) =>
    `<div class="md-code-head"><span>${label}</span><button class="md-copy" type="button" title="Copiar"><i class="codicon codicon-copy"></i></button></div>`,
  );
  if (imgResolver) {
    html = html.replace(/<img([^>]*?)src="([^"]+)"/g, (m, pre, src) => {
      const r = imgResolver(src.replace(/&amp;/g, '&'));
      return r ? `<img${pre}src="${escapeHtml(r)}"` : m;
    });
  }
  if (key) {
    if (cache.size > 500) cache.clear();
    cache.set(key, html);
  }
  return html;
}

/** Liga os botões "copiar" dos blocos de código dentro de um elemento. */
export function wireCodeCopy(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('.md-copy').forEach((b) => {
    if (b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', () => {
      const code = b.closest('.md-code')?.querySelector('code')?.textContent ?? '';
      navigator.clipboard.writeText(code).then(() => {
        b.innerHTML = '<i class="codicon codicon-check"></i>';
        setTimeout(() => (b.innerHTML = '<i class="codicon codicon-copy"></i>'), 1200);
      });
    });
  });
}

export { hljs };
