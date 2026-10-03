// Busca por conteúdo dentro dos arquivos da pasta aberta (Ctrl+Shift+F), tipo grep com destaque.
import { useEffect, useRef, useState } from 'preact/hooks';
import { rpc } from '../lib/rpc';
import { errorText, homeOf, openFile, platformOf, toast, workspace } from '../lib/state';
import type { SearchMatch, SearchResult } from '../../shared/types';
import { Icon, FileIcon } from './icons';
import { join, tildify } from '../../shared/paths';

interface FileGroup {
  file: string;
  matches: SearchMatch[];
}

function groupByFile(matches: SearchMatch[]): FileGroup[] {
  const byFile = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file)!.push(m);
  }
  return [...byFile.entries()].map(([file, ms]) => ({ file, matches: ms }));
}

export function SearchView() {
  const ws = workspace.value;
  const [q, setQ] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    // Fechar a árvore de resultados anteriores ao trocar de pasta.
    setResult(null);
    setErr(null);
    setCollapsed(new Set());
  }, [ws?.hostId, ws?.root]);

  useEffect(() => {
    if (!ws) return;
    const query = q.trim();
    if (!query) {
      setResult(null);
      setErr(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const mySeq = ++seq.current;
    const t = setTimeout(() => {
      rpc
        .call('fs.search', { h: ws.hostId, root: ws.root, query, caseSensitive, regex: useRegex, limit: 500 }, 60_000)
        .then((r: SearchResult) => {
          if (seq.current !== mySeq) return;
          setResult(r);
          setErr(null);
          setLoading(false);
        })
        .catch((e) => {
          if (seq.current !== mySeq) return;
          setErr(errorText(e));
          setResult(null);
          setLoading(false);
        });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, caseSensitive, useRegex, ws?.hostId, ws?.root]);

  if (!ws) {
    return (
      <div class="welcome">
        <p>Nenhuma pasta aberta.</p>
        <p>Abra uma pasta para buscar dentro dos arquivos.</p>
      </div>
    );
  }

  const groups = result ? groupByFile(result.matches) : [];
  const toggle = (file: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(file)) n.delete(file);
      else n.add(file);
      return n;
    });

  const open = (m: SearchMatch) => {
    const plat = platformOf(ws.hostId);
    const full = join(plat, ws.root, plat === 'win32' ? m.file.replace(/\//g, '\\') : m.file);
    openFile(ws.hostId, full, { activate: true, line: m.line }).catch((e) => toast(errorText(e), 'error'));
  };

  return (
    <div class="side-body" style={{ display: 'flex', flexDirection: 'column' }}>
      <div class="search-box">
        <Icon name="search" />
        <input
          ref={inputRef}
          placeholder="Buscar em arquivos"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setQ('');
            }
          }}
          spellcheck={false}
        />
        {loading && <Icon name="loading" class="spin" />}
        <button class={`icon-btn${caseSensitive ? ' on' : ''}`} title="Diferenciar maiúsculas/minúsculas" onClick={() => setCaseSensitive((v) => !v)}>
          <Icon name="case-sensitive" />
        </button>
        <button class={`icon-btn${useRegex ? ' on' : ''}`} title="Usar expressão regular" onClick={() => setUseRegex((v) => !v)}>
          <Icon name="regex" />
        </button>
      </div>
      <div class="tree-empty" style={{ padding: '0 12px 4px 12px' }} title={ws.root}>
        <Icon name="folder" style={{ fontSize: 13 }} /> {tildify(ws.root, homeOf(ws.hostId))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {err && (
          <div class="tree-empty" style={{ color: 'var(--err)' }}>
            {err}
          </div>
        )}
        {!err && !q.trim() && <div class="tree-empty">Digite para buscar dentro do conteúdo dos arquivos.</div>}
        {!err && q.trim() && !loading && result && !result.matches.length && <div class="tree-empty">Nada encontrado.</div>}
        {result && result.matches.length > 0 && (
          <div class="tree-empty" style={{ padding: '2px 12px 6px 14px' }}>
            {result.matches.length} ocorrência{result.matches.length === 1 ? '' : 's'} em {result.filesWithMatches} arquivo{result.filesWithMatches === 1 ? '' : 's'}
            {result.truncated ? ' — resultado parcial, refine a busca' : ''}
          </div>
        )}
        {groups.map((g) => (
          <SearchFileGroup key={g.file} group={g} collapsed={collapsed.has(g.file)} onToggle={() => toggle(g.file)} onOpen={open} />
        ))}
      </div>
    </div>
  );
}

function SearchFileGroup({ group, collapsed, onToggle, onOpen }: { group: FileGroup; collapsed: boolean; onToggle: () => void; onOpen: (m: SearchMatch) => void }) {
  const slash = group.file.lastIndexOf('/');
  const name = slash >= 0 ? group.file.slice(slash + 1) : group.file;
  const dir = slash >= 0 ? group.file.slice(0, slash) : '';
  return (
    <div>
      <div class="tree-row" style={{ paddingLeft: 8 }} title={group.file} onClick={onToggle}>
        <span class="twistie">
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
        </span>
        <FileIcon name={name} />
        <span class="label">{name}</span>
        {dir && <span class="desc">{dir}</span>}
        <span class="desc" style={{ maxWidth: 'none' }}>
          {group.matches.length}
        </span>
      </div>
      {!collapsed &&
        group.matches.map((m, i) => (
          <div
            key={i}
            class="tree-row"
            style={{ paddingLeft: 30, height: 'auto', minHeight: 20, padding: '2px 8px 2px 30px' }}
            title={`${group.file}:${m.line}`}
            onClick={() => onOpen(m)}
          >
            <span class="desc" style={{ minWidth: 30, textAlign: 'right', flex: 'none', maxWidth: 'none' }}>
              {m.line}
            </span>
            <span class="label" style={{ whiteSpace: 'pre' }}>
              {m.text.slice(0, m.hlStart)}
              <mark class="search-hl">{m.text.slice(m.hlStart, m.hlStart + m.hlLen)}</mark>
              {m.text.slice(m.hlStart + m.hlLen)}
            </span>
          </div>
        ))}
    </div>
  );
}
