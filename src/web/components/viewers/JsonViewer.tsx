// JSON em árvore (estilo extensões "JSON viewer"): recolher/expandir, busca, copiar valor/caminho.
// Aceita também JSONL/NDJSON (uma linha = um item).
import { useMemo, useState } from 'preact/hooks';
import { Icon } from '../icons';
import { toast } from '../../lib/state';

type Path = (string | number)[];

export function parseJsonLoose(text: string, jsonl: boolean): { value?: unknown; error?: string; lines?: boolean } {
  const t = text.replace(/^\uFEFF/, '');
  if (!jsonl) {
    try {
      return { value: JSON.parse(t) };
    } catch (e) {
      // JSON com comentários (jsonc) ou vírgulas sobrando.
      try {
        const stripped = t
          .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s ?? '')
          .replace(/,(\s*[}\]])/g, '$1');
        return { value: JSON.parse(stripped) };
      } catch {
        // Talvez seja JSONL mesmo com extensão .json
        const lines = t.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length > 1) {
          try {
            return { value: lines.map((l) => JSON.parse(l)), lines: true };
          } catch {
            /* segue para o erro original */
          }
        }
        return { error: (e as Error).message };
      }
    }
  }
  const out: unknown[] = [];
  const lines = t.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch (e) {
      return { error: `Linha ${i + 1}: ${(e as Error).message}` };
    }
  }
  return { value: out, lines: true };
}

function pathString(p: Path): string {
  let s = '$';
  for (const k of p) s += typeof k === 'number' ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
  return s;
}

const pkey = (p: Path) => JSON.stringify(p);

function typeLabel(v: unknown): string {
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'item' : 'itens'}`;
  if (v && typeof v === 'object') {
    const n = Object.keys(v).length;
    return `${n} ${n === 1 ? 'chave' : 'chaves'}`;
  }
  return '';
}

/** Caminhos que batem com a busca (chave ou valor), limitado para arquivos enormes. */
function searchPaths(root: unknown, needle: string, limit = 2000): { hits: Set<string>; open: Set<string> } {
  const hits = new Set<string>();
  const open = new Set<string>();
  const n = needle.toLowerCase();
  let visited = 0;
  const walk = (v: unknown, p: Path) => {
    if (hits.size >= limit || visited++ > 400_000) return;
    if (v && typeof v === 'object') {
      const entries = Array.isArray(v) ? v.map((x, i) => [i, x] as const) : Object.entries(v as Record<string, unknown>);
      for (const [k, child] of entries) {
        const cp = [...p, k];
        const keyHit = typeof k === 'string' && k.toLowerCase().includes(n);
        const valHit = child !== null && typeof child !== 'object' && String(child).toLowerCase().includes(n);
        if (keyHit || valHit) {
          hits.add(pkey(cp));
          for (let i = 0; i <= p.length; i++) open.add(pkey(cp.slice(0, i)));
        }
        walk(child, cp);
      }
    }
  };
  walk(root, []);
  return { hits, open };
}

export function JsonTree({ value, lines }: { value: unknown; lines?: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>([pkey([])]);
    // Primeiro nível aberto (e o segundo, se for pequeno).
    if (value && typeof value === 'object') {
      const entries = Array.isArray(value) ? value.map((x, i) => [i, x] as const) : Object.entries(value as object);
      if (entries.length <= 30) for (const [k, v] of entries) if (v && typeof v === 'object') s.add(pkey([k]));
    }
    return s;
  });
  const [q, setQ] = useState('');
  const [suppressed, setSuppressed] = useState<Set<string>>(new Set());
  const search = useMemo(() => (q.trim().length >= 2 ? searchPaths(value, q.trim()) : null), [q, value]);

  const isOpen = (p: Path) => !suppressed.has(pkey(p)) && (expanded.has(pkey(p)) || (!!search && search.open.has(pkey(p))));
  const toggle = (p: Path) => {
    const s = new Set(expanded);
    const hidden = new Set(suppressed);
    const k = pkey(p);
    if (isOpen(p)) {
      s.delete(k);
      hidden.add(k); // força fechar mesmo quando a busca quer deixar aberto
    } else {
      s.add(k);
      hidden.delete(k);
    }
    setExpanded(s);
    setSuppressed(hidden);
  };

  const expandAll = () => {
    const s = new Set<string>();
    let count = 0;
    const walk = (v: unknown, p: Path) => {
      if (!v || typeof v !== 'object' || count++ > 5000) return;
      s.add(pkey(p));
      const entries = Array.isArray(v) ? v.map((x, i) => [i, x] as const) : Object.entries(v as object);
      for (const [k, c] of entries.slice(0, 500)) walk(c, [...p, k]);
    };
    walk(value, []);
    setSuppressed(new Set());
    setExpanded(s);
  };

  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copiado`, 'success', 1500));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div class="json-tools">
        <div class="search-box">
          <Icon name="search" />
          <input placeholder="Buscar chave ou valor" value={q} onInput={(e) => { setQ((e.target as HTMLInputElement).value); setSuppressed(new Set()); }} />
        </div>
        {search && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{search.hits.size >= 2000 ? '2000+' : search.hits.size} resultado(s)</span>}
        <span style={{ flex: 1 }} />
        <button class="btn secondary" style={{ height: 22 }} onClick={expandAll}>
          <Icon name="expand-all" /> Expandir
        </button>
        <button class="btn secondary" style={{ height: 22 }} onClick={() => { setQ(''); setSuppressed(new Set()); setExpanded(new Set([pkey([])])); }}>
          <Icon name="collapse-all" /> Recolher
        </button>
      </div>
      <div class="json-view" style={{ flex: 1, overflow: 'auto' }}>
        <JsonNode k={lines ? 'linhas' : null} v={value} path={[]} depth={0} isOpen={isOpen} toggle={toggle} hits={search?.hits} copy={copy} lines={lines} />
      </div>
    </div>
  );
}

function Primitive({ v }: { v: unknown }) {
  if (v === null) return <span class="jnull">null</span>;
  if (typeof v === 'string') {
    const s = v.length > 3000 ? v.slice(0, 3000) + '…' : v;
    return <span class="jstr">"{s}"</span>;
  }
  if (typeof v === 'number') return <span class="jnum">{String(v)}</span>;
  if (typeof v === 'boolean') return <span class="jbool">{String(v)}</span>;
  return <span>{String(v)}</span>;
}

function JsonNode(props: {
  k: string | number | null;
  v: unknown;
  path: Path;
  depth: number;
  isOpen: (p: Path) => boolean;
  toggle: (p: Path) => void;
  hits?: Set<string>;
  copy: (t: string, what: string) => void;
  lines?: boolean;
}) {
  const { k, v, path, depth } = props;
  const [limit, setLimit] = useState(200);
  const isObj = v !== null && typeof v === 'object';
  const open = isObj && props.isOpen(path);
  const hit = props.hits?.has(pkey(path));
  const keyEl =
    k === null ? null : typeof k === 'number' ? (
      <span class="jidx">{props.lines && depth === 1 ? `linha ${k + 1}` : k}: </span>
    ) : (
      <>
        <span class="jkey">{JSON.stringify(k)}</span>
        <span class="jpunct">: </span>
      </>
    );
  const actions = (
    <span class="jcopy">
      <button class="icon-btn" title="Copiar valor" onClick={() => props.copy(isObj ? JSON.stringify(v, null, 2) : typeof v === 'string' ? v : JSON.stringify(v), 'Valor')}>
        <Icon name="copy" style={{ fontSize: 12 }} />
      </button>
      <button class="icon-btn" title="Copiar caminho" onClick={() => props.copy(pathString(path), 'Caminho')}>
        <Icon name="symbol-field" style={{ fontSize: 12 }} />
      </button>
    </span>
  );
  const indent = { paddingLeft: 8 + depth * 16 };
  if (!isObj)
    return (
      <div class={`jrow${hit ? ' hit' : ''}`} style={indent}>
        <span class="jtw" />
        {keyEl}
        <Primitive v={v} />
        {actions}
      </div>
    );
  const arr = Array.isArray(v);
  const entries: [string | number, unknown][] = arr ? (v as unknown[]).map((x, i) => [i, x]) : Object.entries(v as Record<string, unknown>);
  return (
    <>
      <div class={`jrow${hit ? ' hit' : ''}`} style={indent} onClick={() => props.toggle(path)}>
        <span class="jtw">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </span>
        {keyEl}
        <span class="jpunct">{arr ? '[' : '{'}</span>
        {!open && <span class="jpunct">{entries.length ? ' … ' : ''}{arr ? ']' : '}'}</span>}
        <span class="jmeta">{typeLabel(v)}</span>
        {actions}
      </div>
      {open && (
        <>
          {entries.slice(0, limit).map(([ck, cv]) => (
            <JsonNode key={String(ck)} {...props} k={ck} v={cv} path={[...path, ck]} depth={depth + 1} />
          ))}
          {entries.length > limit && (
            <div class="jrow" style={{ paddingLeft: 24 + (depth + 1) * 16 }}>
              <button class="more-btn" onClick={() => setLimit(limit + 500)}>
                Mostrar mais {Math.min(500, entries.length - limit)} de {entries.length - limit} restantes
              </button>
            </div>
          )}
          <div class="jrow" style={indent}>
            <span class="jtw" />
            <span class="jpunct">{arr ? ']' : '}'}</span>
          </div>
        </>
      )}
    </>
  );
}
