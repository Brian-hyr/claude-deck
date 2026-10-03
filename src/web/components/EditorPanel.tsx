// Painel de arquivos (à direita): abas de arquivos, editor de código e visualizadores.
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { EditorState } from '@codemirror/state';
import {
  activeChat,
  activeFile,
  activeFileId,
  closeFile,
  editorVisible,
  files,
  homeOf,
  hostColor,
  hostLabel,
  loadFile,
  openFile,
  rawUrl,
  saveFile,
  settings,
  type FileTab,
  isStreamedKind,
} from '../lib/state';
import { CodeEditor } from '../lib/codemirror';
import { isFilePublishing } from '../lib/fileCopy';
import { Icon, FileIcon } from './icons';
import { openMenu } from './ContextMenu';
import { Markdown } from './Markdown';
import { JsonTree, parseJsonLoose } from './viewers/JsonViewer';
import { AudioViewer, BinaryViewer, CsvViewer, HtmlViewer, ImageViewer, PdfViewer, VideoViewer } from './viewers/MediaViewers';
import { formatBytes } from '../lib/format';
import { dirname, join, tildify } from '../../shared/paths';

export function EditorPanel() {
  const list = files.value;
  const f = activeFile.value;
  return (
    <div class="editor-panel" style={{ width: '100%', height: '100%' }}>
      <div class="tabs">
        <div class="tabs-scroll" onWheel={(e) => ((e.currentTarget as HTMLElement).scrollLeft += e.deltaY)}>
          {list.map((t) => (
            <FileTabEl key={t.id} t={t} active={t.id === f?.id} />
          ))}
        </div>
        <div class="tabs-actions">
          <button class="icon-btn" title="Fechar painel de arquivos (Ctrl+Shift+E)" onClick={() => (editorVisible.value = false)}>
            <Icon name="layout-sidebar-right-off" />
          </button>
        </div>
      </div>
      {f ? <FileView key={f.id} f={f} /> : <div class="viewer-center">Nenhum arquivo aberto.</div>}
    </div>
  );
}

function FileTabEl({ t, active }: { t: FileTab; active: boolean }) {
  const dirty = t.dirty.value;
  return (
    <div
      class={`tab${active ? ' active' : ''}${dirty ? ' dirty' : ''}`}
      title={`${hostLabel(t.hostId)}: ${t.path}`}
      onClick={() => (activeFileId.value = t.id)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeFile(t.id);
        }
      }}
      onContextMenu={(e) =>
        openMenu(e as any, [
          { label: 'Fechar', icon: 'close', kb: 'Ctrl+W', action: () => closeFile(t.id) },
          { label: 'Fechar as outras', action: () => files.value.filter((x) => x.id !== t.id).forEach((x) => closeFile(x.id)) },
          { label: 'Fechar todas', action: () => files.value.forEach((x) => closeFile(x.id)) },
          { separator: true },
          { label: 'Copiar caminho', icon: 'copy', action: () => navigator.clipboard.writeText(t.path) },
          { label: 'Recarregar do disco', icon: 'refresh', action: () => loadFile(t) },
        ])
      }
    >
      <FileIcon name={t.name} />
      <span class="tab-label">{t.name}</span>
      {t.hostId !== 'local' && (
        <span class="tab-host" style={{ color: hostColor(t.hostId) }}>
          {t.hostId}
        </span>
      )}
      <button
        class={`close${dirty ? ' has-dirty' : ''}`}
        title={dirty ? 'Não salvo' : 'Fechar'}
        onClick={(e) => {
          e.stopPropagation();
          closeFile(t.id);
        }}
      >
        {dirty && <span class="dirty-dot" />}
        <i class="codicon codicon-close" />
      </button>
    </div>
  );
}

const VIEW_KINDS = new Set(['markdown', 'html', 'json', 'svg', 'csv']);

function FileView({ f }: { f: FileTab }) {
  void f.reloadKey.value;
  const mode = f.mode.value;
  const canToggle = VIEW_KINDS.has(f.kind);
  const showCode = f.kind === 'text' || (canToggle && mode === 'edit');
  const st = f;
  const platform = f.path.includes('\\') ? 'win32' : 'posix';
  const chat = activeChat.value;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div class="editor-toolbar">
        <span class="crumbs" title={f.path}>
          <span style={{ color: hostColor(f.hostId) }}>{hostLabel(f.hostId)}</span> · {tildify(f.path, homeOf(f.hostId))}
        </span>
        {canToggle && (
          <div class="seg">
            <button class={mode === 'view' ? 'on' : ''} onClick={() => (f.mode.value = 'view')}>
              <Icon name="preview" style={{ fontSize: 12 }} /> Visualizar
            </button>
            <button class={mode === 'edit' ? 'on' : ''} onClick={() => (f.mode.value = 'edit')}>
              <Icon name="code" style={{ fontSize: 12 }} /> Código
            </button>
          </div>
        )}
        {f.dirty.value && (
          <button class="btn" style={{ height: 20, padding: '0 8px', fontSize: 11 }} onClick={() => saveFile(f)} title="Salvar (Ctrl+S)">
            Salvar
          </button>
        )}
        <button
          class="icon-btn"
          title="Mais"
          onClick={(e) =>
            openMenu(e as any, [
              { label: 'Recarregar do disco', icon: 'refresh', action: () => loadFile(f) },
              { label: 'Baixar', icon: 'cloud-download', action: () => window.open(rawUrl(f.hostId, f.path, true), '_blank') },
              { label: 'Copiar caminho', icon: 'copy', action: () => navigator.clipboard.writeText(f.path) },
              ...(chat && chat.state.value.hostId === f.hostId
                ? [{ label: 'Mencionar na conversa (@)', icon: 'mention', action: () => window.dispatchEvent(new CustomEvent('deck:mention', { detail: { path: f.path } })) }]
                : []),
              ...(isStreamedKind(f.kind) || f.kind === 'html'
                ? [{ label: 'Abrir em nova janela', icon: 'link-external', action: () => window.open(rawUrl(f.hostId, f.path), '_blank') }]
                : []),
              { separator: true },
              { label: `${formatBytes(st.size)}${st.truncated ? ' (aberto em parte)' : ''}`, icon: 'info', disabled: true },
            ])
          }
        >
          <Icon name="ellipsis" />
        </button>
      </div>
      {f.changedOnDisk.value && (
        <div class="banner">
          <Icon name="warning" />
          <span class="grow">O arquivo mudou no disco (talvez pelo Claude) e você tem alterações não salvas.</span>
          <button class="btn secondary" style={{ height: 22 }} onClick={() => loadFile(f)}>
            Recarregar (descarta as suas)
          </button>
          <button class="btn secondary" style={{ height: 22 }} onClick={() => (f.changedOnDisk.value = false)}>
            Manter as minhas
          </button>
        </div>
      )}
      {f.truncated && (
        <div class="banner">
          <Icon name="info" />
          <span class="grow">Arquivo grande ({formatBytes(f.size)}): mostrando só o começo, em modo leitura.</span>
        </div>
      )}
      {f.error.value && (
        <div class="banner error">
          <Icon name="error" />
          <span class="grow">{f.error.value}</span>
          <button class="btn secondary" style={{ height: 22 }} onClick={() => loadFile(f)}>
            Tentar de novo
          </button>
        </div>
      )}
      <div class="editor-body">
        {f.loading.value && <div class="tree-loading" style={{ position: 'absolute', left: 0, right: 0, top: 0, zIndex: 2 }} />}
        {!f.loading.value && !f.error.value && (showCode ? <CodeView f={f} /> : <Viewer f={f} platform={platform} rk={f.reloadKey.value} />)}
      </div>
    </div>
  );
}

/**
 * `rk` (reloadKey) vai como prop para cada visualizador: o objeto `f` é sempre o mesmo e o
 * @preact/signals pularia a nova renderização depois que o arquivo é recarregado do disco.
 */
function Viewer({ f, platform, rk }: { f: FileTab; platform: 'win32' | 'posix'; rk: number }) {
  switch (f.kind) {
    case 'markdown': {
      const dir = dirname(platform, f.path);
      const v = f.mtime;
      return (
        <div class="fill">
          <div class="md-view">
            <Markdown
              text={f.content}
              imgResolver={(src) => (/^(https?:|data:)/i.test(src) ? null : `${rawUrl(f.hostId, join(platform, dir, decodeURIComponent(src)))}&v=${v}`)}
              onOpenPath={(p, line) => openFile(f.hostId, join(platform, dir, p), { line })}
              folderLinks={false}
            />
          </div>
        </div>
      );
    }
    case 'html':
      return <HtmlViewer f={f} rk={rk} />;
    case 'image':
    case 'svg':
      return <ImageViewer f={f} rk={rk} />;
    case 'video':
      return <VideoViewer f={f} rk={rk} />;
    case 'audio':
      return <AudioViewer f={f} rk={rk} />;
    case 'pdf':
      return <PdfViewer f={f} rk={rk} />;
    case 'json':
      return <JsonView f={f} rk={rk} />;
    case 'csv':
      return <CsvViewer f={f} rk={rk} />;
    case 'binary':
      return <BinaryViewer f={f} rk={rk} />;
    default:
      return <CodeView f={f} />;
  }
}

function JsonView({ f }: { f: FileTab; rk: number }) {
  const jsonl = /\.(jsonl|ndjson)$/i.test(f.path);
  const parsed = useMemo(() => parseJsonLoose(f.content, jsonl), [f.content, jsonl]);
  if (parsed.error)
    return (
      <div class="fill">
        <div class="json-error">JSON inválido: {parsed.error}</div>
        <div style={{ padding: '0 14px' }}>
          <button class="btn secondary" onClick={() => (f.mode.value = 'edit')}>
            <Icon name="code" /> Abrir como texto
          </button>
        </div>
      </div>
    );
  return <JsonTree value={parsed.value} lines={parsed.lines} />;
}

function CodeView({ f }: { f: FileTab }) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<CodeEditor | null>(null);
  const s = settings.value;
  const dark = s.theme === 'dark';
  const publishing = isFilePublishing(f.hostId, f.path);

  useEffect(() => {
    if (!host.current) return;
    const editor = new CodeEditor(
      host.current,
      {
        doc: f.content,
        filename: f.name,
        dark,
        wrap: s.editorWordWrap || f.kind === 'markdown',
        tabSize: s.editorTabSize,
        readOnly: f.truncated || f.binary || isFilePublishing(f.hostId, f.path),
        onChange: (doc) => {
          f.content = doc;
          const dirty = doc !== f.savedContent;
          if (f.dirty.peek() !== dirty) f.dirty.value = dirty;
        },
        onSave: () => saveFile(f),
        onSelection: (sel) => window.dispatchEvent(new CustomEvent('deck:selection', { detail: sel })),
      },
      f.editorState as EditorState | undefined,
    );
    ed.current = editor;
    if (f.editorState && editor.doc !== f.content) editor.setDoc(f.content);
    if (f.pendingLine) {
      const line = f.pendingLine;
      f.pendingLine = undefined;
      requestAnimationFrame(() => editor.goToLine(line));
    } else editor.view.focus();
    return () => {
      f.editorState = editor.view.state;
      window.dispatchEvent(new CustomEvent('deck:selection', { detail: null }));
      editor.destroy();
      ed.current = null;
    };
  }, [f.id]);

  // Recarregado do disco (ex.: o Claude editou): troca o texto mantendo a posição.
  useEffect(() => {
    const e = ed.current;
    if (!e) return;
    if (e.doc !== f.content) e.setDoc(f.content);
    if (f.pendingLine) {
      e.goToLine(f.pendingLine);
      f.pendingLine = undefined;
    }
  }, [f.reloadKey.value]);

  useEffect(() => {
    const update = () => ed.current?.setReadOnly(f.truncated || f.binary || isFilePublishing(f.hostId, f.path));
    update();
    window.addEventListener('deck:file-locks', update);
    return () => window.removeEventListener('deck:file-locks', update);
  }, [f.id, publishing]);
  useEffect(() => ed.current?.setTheme(dark), [dark]);
  useEffect(() => ed.current?.setWrap(s.editorWordWrap || f.kind === 'markdown'), [s.editorWordWrap]);

  return <div class="cm-host" ref={host} />;
}
