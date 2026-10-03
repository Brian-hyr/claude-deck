// Explorador de arquivos (estilo VS Code): árvore da pasta do workspace, local ou remota.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { rpc, RpcError } from '../lib/rpc';
import {
  activeChat,
  activeFile,
  addExtraRoot,
  collapsedRoots,
  choiceDialog,
  confirmDialog,
  errorText,
  expandedDirs,
  explorerRefresh,
  extraRoots,
  folderBrowser,
  homeOf,
  hostLabel,
  hostStatus,
  newChat,
  openFile,
  openWorkspace,
  platformOf,
  removeExtraRoot,
  toast,
  windowHostId,
  workspace,
  closeFile,
  files,
  uploadProgress,
  sidebarView,
  sidebarVisible,
} from '../lib/state';
import type { FileEntry } from '../../shared/types';
import { basename, dirname, join, moveBlocked, normalize, relativeTo, tildify } from '../../shared/paths';
import { FileIcon, Icon } from './icons';
import { openMenu } from './ContextMenu';
import { formatBytes, formatDateTime, fuzzyScore } from '../lib/format';
import { planFromDrop, planFromFileList, type UploadPlan } from '../lib/dropTree';
import { downloadEntry, downloadUrlData, prefetchTicket } from '../lib/download';
import { flattenTree, isDirEntry as isDir, makeJoin, ROW_H, type TreeRow } from '../lib/treeRows';
import { useRowWindow } from '../lib/useRowWindow';
import { copyExplorerItem, pasteExplorerItem } from '../lib/fileCopy';

interface DirState {
  items?: FileEntry[];
  loading: boolean;
  error?: string;
}

const dirCache = signal<Record<string, DirState>>({});
const selected = signal<string | null>(null);
const editing = signal<{ parent: string; kind: 'file' | 'folder' | 'rename'; path?: string } | null>(null);
const showHidden = signal(true);
/** Arrasto do Windows sobre o espaço livre do explorador (destaca o painel inteiro). */
const dropAll = signal(false);

/** Tipo do arrasto de uma linha do explorador (também usado pelo compositor para `@menção`). */
const DECK_DRAG = 'application/x-deck-path';
/**
 * Linha do explorador sendo arrastada nesta janela. O navegador só deixa ler o conteúdo do arrasto ao
 * SOLTAR; isto permite saber, enquanto passa por cima, se a pasta de baixo aceita (cursor e destaque).
 */
let dragging: { hostId: string; path: string; dir: boolean } | null = null;

/** Filtro ao vivo da árvore (compartilhado entre a raiz do workspace e as pastas fixadas). */
const explorerFilter = signal('');
/** Lista plana de arquivos (caminhos relativos à raiz, sempre com '/') por raiz — só buscada quando filtrando. */
const flatFileCache = signal<Record<string, string[]>>({});

interface FilterSets {
  /** Caminhos relativos (à raiz) de arquivos que batem com o filtro. */
  files: Set<string>;
  /** Caminhos relativos de pastas que contêm algum arquivo que bate (para manter visíveis/abertas). */
  dirs: Set<string>;
}

function computeFilterSets(flat: string[], query: string): FilterSets {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const f of flat) {
    if (fuzzyScore(query, f) < 0) continue;
    files.add(f);
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return { files, dirs };
}

function key(hostId: string, p: string) {
  return `${hostId}::${p}`;
}

/** Mesma listagem? (nome, tipo, tamanho, data): então nada na tela precisa ser refeito. */
function sameEntries(a: FileEntry[], b: FileEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.name !== y.name || x.type !== y.type || x.size !== y.size || x.mtime !== y.mtime || x.targetType !== y.targetType) return false;
  }
  return true;
}

/**
 * `quiet`: recarga em segundo plano de uma pasta já mostrada (fim de cada resposta do Claude) — sem piscar
 * a barra de carregamento. Em qualquer recarga, se a listagem veio igual, o objeto antigo é mantido e a
 * árvore não é redesenhada (antes cada fim de resposta refazia as milhares de linhas, em todas as janelas).
 */
async function loadDir(hostId: string, p: string, force = false, quiet = false) {
  const k = key(hostId, p);
  const cur = dirCache.value[k];
  if (cur && !force && (cur.items || cur.loading)) return;
  if (!(quiet && cur?.items)) dirCache.value = { ...dirCache.value, [k]: { ...cur, loading: true } };
  try {
    const items: FileEntry[] = await rpc.call('fs.list', { h: hostId, p }, 60_000);
    const prev = dirCache.value[k];
    if (prev?.items && !prev.error && sameEntries(prev.items, items)) {
      if (prev.loading) dirCache.value = { ...dirCache.value, [k]: { items: prev.items, loading: false } };
      return;
    }
    dirCache.value = { ...dirCache.value, [k]: { items, loading: false } };
  } catch (e) {
    dirCache.value = { ...dirCache.value, [k]: { loading: false, error: errorText(e) } };
  }
}

export function refreshDir(hostId: string, p: string) {
  return loadDir(hostId, p, true);
}

function setExpanded(hostId: string, p: string, open: boolean) {
  const list = new Set(expandedDirs.value[hostId] ?? []);
  if (open) list.add(p);
  else list.delete(p);
  expandedDirs.value = { ...expandedDirs.value, [hostId]: [...list].slice(-300) };
}

/** Envia um arquivo com progresso (XHR: o fetch não informa o andamento do envio). */
function postFile(url: string, f: File, onBytes: (loaded: number) => void): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('x-deck-upload', '1');
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => resolve({ status: 0, text: 'falha de rede' });
    xhr.send(f);
  });
}

/** Acima disso o envio pede confirmação (pasta acidental: node_modules, disco inteiro...). */
const UPLOAD_ASK_FILES = 2000;
const UPLOAD_PARALLEL = 3;

async function runPool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const isNoMethod = (e: unknown) => e instanceof RpcError && e.code === 'nomethod';
/** O programa em segundo plano pode ser de uma versão anterior (só reinicia quando não há conversa trabalhando). */
let noExistsMany = false;
let noMkdirp = false;

/** Quais destes caminhos já existem. Servidor anterior (sem `fs.existsMany`): confere um a um. */
async function existingOf(hostId: string, targets: string[]): Promise<string[]> {
  if (!noExistsMany) {
    try {
      let found: string[] = [];
      for (let i = 0; i < targets.length; i += 4000) found = found.concat(await rpc.call<string[]>('fs.existsMany', { h: hostId, paths: targets.slice(i, i + 4000) }, 120_000));
      return found;
    } catch (e) {
      if (!isNoMethod(e)) throw e;
      noExistsMany = true;
    }
  }
  const found: string[] = [];
  await runPool(targets, 8, async (p) => {
    if (await rpc.call<boolean>('fs.exists', { h: hostId, p }, 60_000)) found.push(p);
  });
  return found;
}

/** Cria a pasta e os níveis acima que faltam. Servidor anterior (sem `fs.mkdirp`): nível por nível, com `fs.mkdir`. */
async function makeDirs(hostId: string, rel: string, abs: (rel: string) => string): Promise<void> {
  if (!noMkdirp) {
    try {
      await rpc.call('fs.mkdirp', { h: hostId, p: abs(rel) }, 60_000);
      return;
    } catch (e) {
      if (!isNoMethod(e)) throw e;
      noMkdirp = true;
    }
  }
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const p = abs(parts.slice(0, i).join('/'));
    if (await rpc.call<boolean>('fs.exists', { h: hostId, p }, 60_000)) continue;
    try {
      await rpc.call('fs.mkdir', { h: hostId, p }, 60_000);
    } catch (e) {
      // Outro envio em paralelo pode ter criado a mesma pasta agora há pouco.
      if (!(await rpc.call<boolean>('fs.exists', { h: hostId, p }, 60_000))) throw e;
    }
  }
}

/**
 * Envia arquivos e pastas (com subpastas e pastas vazias) para `dir`. Devolve true se algo foi enviado.
 * Pergunta uma vez só sobre o que já existe; pastas existentes são mescladas, nunca apagadas.
 */
async function uploadPlan(hostId: string, dir: string, plan: UploadPlan): Promise<boolean> {
  const plat = platformOf(hostId);
  const abs = (rel: string) => join(plat, dir, ...rel.split('/'));
  if (plan.unreadable.length) {
    toast(`${plan.unreadable.length} item(ns) o navegador não deixou ler e ficaram de fora: ${plan.unreadable.slice(0, 3).join('; ')}`, 'error', 8000);
  }
  if (!plan.files.length && !plan.dirs.length) {
    if (!plan.unreadable.length) toast('Nada para enviar.', 'info', 2500);
    return false;
  }
  const single = plan.files.length === 1 && !plan.dirs.length;
  const tops = new Set([...plan.dirs, ...plan.files.map((f) => f.rel)].map((r) => r.split('/')[0]));
  const label = tops.size === 1 ? [...tops][0] : `${tops.size} itens`;
  let files = plan.files;
  let replace = new Set<string>();
  const failed: string[] = [];
  try {
    if (files.length > UPLOAD_ASK_FILES) {
      const total = files.reduce((a, f) => a + f.file.size, 0);
      const ok = await confirmDialog(`Enviar ${files.length} arquivos?`, `${label} tem ${files.length} arquivos (${formatBytes(total)}). Vai para ${dir} em ${hostLabel(hostId)}.`, 'Enviar');
      if (!ok) return false;
    }

    // Conflitos: uma pergunta só, antes de mandar qualquer byte.
    const targets = files.map((f) => abs(f.rel));
    let found: string[] = [];
    try {
      found = await existingOf(hostId, targets);
    } catch (e) {
      toast(`Falha ao verificar o destino: ${errorText(e)}`, 'error');
      return false;
    }
    if (found.length) {
      const dup = new Set(found);
      const dupFiles = files.filter((f) => dup.has(abs(f.rel)));
      if (single) {
        const name = dupFiles[0].rel;
        if (!(await confirmDialog(`Substituir ${name}?`, `Já existe ${name} em ${dir}.`, 'Substituir', true))) return false;
        replace = dup;
      } else {
        const n = dupFiles.length;
        const sample = dupFiles.slice(0, 4).map((f) => f.rel).join('\n');
        const r = await choiceDialog(
          `${n} arquivo${n > 1 ? 's' : ''} já existe${n > 1 ? 'm' : ''} em ${basename(dir) || dir}`,
          `${sample}${n > 4 ? `\n… e mais ${n - 4}` : ''}\n\nSubstituir troca pelo conteúdo enviado. "Pular existentes" envia só o que ainda não está lá.`,
          'Substituir',
          'Pular existentes',
          true,
        );
        if (r === 'cancel') return false;
        if (r === 'ok') replace = dup;
        else files = files.filter((f) => !dup.has(abs(f.rel)));
      }
    }

    // Pastas (só as "folhas": criar a mais funda já cria os níveis acima).
    const leaves = plan.dirs.filter((d) => !plan.dirs.some((o) => o.startsWith(d + '/')));
    const badDirs: string[] = [];
    await runPool(leaves, 4, async (d) => {
      try {
        await makeDirs(hostId, d, abs);
      } catch (e) {
        badDirs.push(d);
        failed.push(`${d}: ${errorText(e)}`);
      }
    });
    if (badDirs.length) files = files.filter((f) => !badDirs.some((d) => f.rel.startsWith(d + '/')));

    // Arquivos, poucos por vez, com andamento somado.
    const sizeAll = files.reduce((a, f) => a + f.file.size, 0) || 1;
    const loaded = new Map<string, number>();
    let doneBytes = 0;
    let doneFiles = 0;
    let okBytes = 0;
    let failedFiles = 0;
    let lastError = '';
    const show = () => {
      let cur = doneBytes;
      for (const v of loaded.values()) cur += v;
      uploadProgress.value = { name: single ? files[0].file.name : `${label} (${doneFiles}/${files.length})`, pct: Math.min(100, Math.round((cur / sizeAll) * 100)) };
    };
    show();
    await runPool(files, UPLOAD_PARALLEL, async (f) => {
      const target = abs(f.rel);
      const url = `/api/upload?h=${encodeURIComponent(hostId)}&p=${encodeURIComponent(target)}${replace.has(target) ? '&overwrite=1' : ''}`;
      const res = await postFile(url, f.file, (n) => {
        loaded.set(target, n);
        show();
      });
      loaded.delete(target);
      doneBytes += f.file.size;
      doneFiles++;
      if (res.status < 200 || res.status >= 300) {
        failedFiles++;
        lastError = String(res.text || res.status);
        failed.push(`${f.rel}: ${lastError}`);
      } else okBytes += f.file.size;
      show();
    });

    const okFiles = files.length - failedFiles;
    if (single && !failedFiles) toast(`Enviado: ${files[0].file.name} (${formatBytes(files[0].file.size)})`, 'success', 2000);
    else if (single) toast(`Falha ao enviar ${files[0].file.name}: ${lastError}`, 'error');
    else if (okFiles > 0 || plan.dirs.length) {
      const partes = [okFiles ? `${okFiles} arquivo${okFiles > 1 ? 's' : ''} (${formatBytes(okBytes)})` : '', plan.dirs.length ? `${plan.dirs.length} pasta${plan.dirs.length > 1 ? 's' : ''}` : ''].filter(Boolean);
      toast(`Enviado: ${label} — ${partes.join(' e ')}`, 'success', 3500);
    }
    if (failed.length && !single) toast(`${failed.length} falha${failed.length > 1 ? 's' : ''} no envio: ${failed.slice(0, 3).join('; ')}`, 'error', 9000);
    return okFiles > 0 || plan.dirs.length > badDirs.length;
  } finally {
    uploadProgress.value = null;
    // Atualiza a pasta de destino e qualquer subpasta que já esteja carregada na árvore.
    const parents = new Set<string>([dir]);
    for (const r of [...plan.dirs, ...plan.files.map((f) => f.rel)]) {
      const i = r.lastIndexOf('/');
      if (i > 0) parents.add(abs(r.slice(0, i)));
    }
    await Promise.all([...parents].filter((p) => p === dir || dirCache.value[key(hostId, p)]).map((p) => refreshDir(hostId, p)));
  }
}

/** Arquivos escolhidos por caminho tradicional (seletor) ou soltos sem pastas. */
function uploadFiles(hostId: string, dir: string, list: FileList | File[]) {
  return uploadPlan(hostId, dir, planFromFileList(list));
}

/** Solta do Windows (arquivos e/ou pastas). A leitura das entradas tem que começar já, dentro do evento. */
function dropUpload(hostId: string, dir: string, dt: DataTransfer): Promise<boolean> {
  return planFromDrop(dt)
    .then((plan) => uploadPlan(hostId, dir, plan))
    .catch((e) => {
      toast(`Falha ao enviar: ${errorText(e)}`, 'error');
      return false;
    });
}

/**
 * Rede de segurança da janela inteira: arquivo do Windows solto fora de qualquer área que o aceite
 * (conversa, editor, painel de Servidores...). Sem isto o navegador abre ou BAIXA o arquivo — um .zip
 * solto ali abria o "Salvar como", parecendo download em vez de envio. Com uma pasta aberta no
 * explorador, pergunta se é para enviar para ela; sem pasta, só avisa.
 */
export function installWindowDropGuard(): () => void {
  const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  const over = (e: DragEvent) => {
    if (e.defaultPrevented || !isFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = workspace.value ? 'copy' : 'none';
  };
  const drop = (e: DragEvent) => {
    if (e.defaultPrevented || !isFiles(e)) return;
    e.preventDefault();
    const ws = workspace.value;
    if (!ws) {
      toast('Abra uma pasta no explorador para enviar arquivos para o servidor.', 'info', 5000);
      return;
    }
    // A leitura das entradas começa aqui, ainda dentro do evento (depois o navegador esvazia a lista).
    planFromDrop(e.dataTransfer!)
      .then(async (plan) => {
        if (!plan.files.length && !plan.dirs.length) return uploadPlan(ws.hostId, ws.root, plan);
        const tops = new Set([...plan.dirs, ...plan.files.map((f) => f.rel)].map((r) => r.split('/')[0]));
        const label = tops.size === 1 ? [...tops][0] : `${tops.size} itens`;
        const ok = await confirmDialog(
          `Enviar ${label} para ${hostLabel(ws.hostId)}?`,
          `Vai para ${tildify(ws.root, homeOf(ws.hostId))}.\nPara mandar para outra pasta, solte sobre ela no explorador.`,
          'Enviar',
        );
        if (ok) await uploadPlan(ws.hostId, ws.root, plan);
      })
      .catch((err) => toast(`Falha ao enviar: ${errorText(err)}`, 'error'));
  };
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', drop);
  };
}

/** Abre o seletor do sistema para escolher arquivos ou uma pasta inteira. */
function pickAndUpload(hostId: string, dir: string, folder: boolean) {
  const inp = document.createElement('input');
  inp.type = 'file';
  if (folder) inp.webkitdirectory = true;
  else inp.multiple = true;
  inp.onchange = () => {
    const list = inp.files;
    if (!list?.length) {
      if (folder) toast('A pasta escolhida não tem arquivos. Para enviar uma pasta vazia, arraste-a para o explorador.', 'info', 5000);
      return;
    }
    uploadFiles(hostId, dir, list);
  };
  inp.click();
}

export function Explorer() {
  const ws = workspace.value;
  useEffect(() => {
    const dirty = new Map<string, { hostId: string; path: string }>();
    let timer = 0;
    const changed = (event: Event) => {
      const { hostIds, path } = (event as CustomEvent).detail;
      for (const hostId of hostIds) {
        const parent = dirname(platformOf(hostId), path);
        if (dirCache.peek()[key(hostId, parent)]?.items) dirty.set(key(hostId, parent), { hostId, path: parent });
        const flat = { ...flatFileCache.peek() };
        for (const k of Object.keys(flat)) if (k.startsWith(`${hostId}::`) && relativeTo(platformOf(hostId), k.slice(hostId.length + 2), path) !== null) delete flat[k];
        flatFileCache.value = flat;
      }
      if (!timer) timer = window.setTimeout(() => {
        timer = 0;
        for (const d of dirty.values()) void loadDir(d.hostId, d.path, true, true);
        dirty.clear();
      }, 250);
    };
    window.addEventListener('deck:files-changed', changed);
    return () => { window.removeEventListener('deck:files-changed', changed); clearTimeout(timer); };
  }, []);

  if (!ws) {
    return (
      <div class="welcome">
        <p>Nenhuma pasta aberta.</p>
        <p>Abra uma conversa ou escolha uma pasta de um servidor para ver os arquivos aqui.</p>
        <button class="btn" onClick={() => (folderBrowser.value = { hostId: windowHostId(), purpose: 'workspace' })}>
          <Icon name="folder-opened" /> {windowHostId() === 'local' ? 'Abrir pasta local' : `Abrir pasta em ${hostLabel(windowHostId())}`}
        </button>
      </div>
    );
  }

  const pinned = extraRoots.value[ws.hostId] ?? [];
  const filterQ = explorerFilter.value;

  return (
    <div
      class={`side-body explorer-body${dropAll.value ? ' drop-zone' : ''}`}
      style={{ display: 'flex', flexDirection: 'column' }}
      tabIndex={0}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('input, textarea, [contenteditable="true"]') || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
        if (e.key.toLowerCase() === 'v' && (target === e.currentTarget || target.classList.contains('explorer-fill'))) {
          e.preventDefault(); e.stopPropagation(); void pasteExplorerItem(ws.hostId, ws.root);
        }
      }}
      // O painel inteiro aceita o que vem do Windows (inclusive o espaço vazio abaixo da árvore): vai para a
      // pasta principal. Pastas da árvore e pastas fixadas pegam o arrasto antes e param a propagação.
      onDragOver={(e) => {
        if (isDeckDrag(e)) {
          // Espaço vazio abaixo da árvore: move para a pasta principal.
          dropAll.value = overMove(e, ws.hostId, ws.root);
          return;
        }
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        dropAll.value = true;
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) dropAll.value = false;
      }}
      onDrop={(e) => {
        dropAll.value = false;
        if (dropMove(e, ws.hostId, ws.root)) return;
        const dt = e.dataTransfer;
        if (!dt || !dt.types.includes('Files')) return;
        e.preventDefault();
        dropUpload(ws.hostId, ws.root, dt);
      }}
    >
      <div class="search-box">
        <Icon name="filter" />
        <input
          placeholder="Filtrar arquivos"
          value={filterQ}
          onInput={(e) => (explorerFilter.value = (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (explorerFilter.value) explorerFilter.value = '';
            else (e.target as HTMLInputElement).blur();
          }}
          spellcheck={false}
        />
        {filterQ && (
          <button class="icon-btn" title="Limpar filtro" onClick={() => (explorerFilter.value = '')}>
            <Icon name="close" />
          </button>
        )}
      </div>
      <div class="tree-scroller" style={{ flex: 1, overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ExplorerRoot hostId={ws.hostId} root={ws.root} isWorkspace />
        {pinned.map((r) => (
          <ExplorerRoot key={r} hostId={ws.hostId} root={r} onUnpin={() => removeExtraRoot(ws.hostId, r)} />
        ))}
        {/* Espaço vazio abaixo da árvore: também é "soltar aqui" (para a pasta principal). */}
        <div class="explorer-fill" style={{ flex: 1, minHeight: 48 }} tabIndex={0}
          onContextMenu={(e) => openMenu(e as any, [{ label: 'Colar aqui', icon: 'clippy', kb: 'Ctrl+V', action: () => pasteExplorerItem(ws.hostId, ws.root) }])} />
      </div>
    </div>
  );
}

/**
 * Uma raiz do explorador: a do workspace (com os botões de novo/colapsar/ocultos e "abrir outra
 * pasta") ou uma pasta extra fixada (com botão de remover) — para espiar `/tmp` ou `/home` sem
 * trocar a pasta principal da conversa.
 */
function ExplorerRoot({ hostId, root, isWorkspace, onUnpin }: { hostId: string; root: string; isWorkspace?: boolean; onUnpin?: () => void }) {
  const [dropRoot, setDropRoot] = useState(false);

  useEffect(() => {
    loadDir(hostId, root);
  }, [hostId, root]);

  // Depois de cada turno do Claude, recarrega as pastas abertas desta raiz (sem piscar).
  useEffect(() => {
    if (explorerRefresh.value === 0) return;
    const open = [root, ...(expandedDirs.value[hostId] ?? []).filter((p) => p.startsWith(root))];
    for (const p of open) if (dirCache.value[key(hostId, p)]?.items) loadDir(hostId, p, true, true);
  }, [explorerRefresh.value]);

  const st = hostStatus.value[hostId];
  const rootName = basename(root) || root;
  const k = key(hostId, root);
  const dir = dirCache.value[k];

  // Filtro ao vivo: busca a lista plana de arquivos só quando o usuário começa a filtrar,
  // e reaproveita (por raiz) enquanto ele digita.
  const filterQ = explorerFilter.value.trim();
  const filtering = !!filterQ;

  const collapsed = !!collapsedRoots.value[k];
  const isCollapsed = collapsed && !filtering;
  const toggleCollapse = () => {
    collapsedRoots.value = { ...collapsedRoots.value, [k]: !collapsed };
  };
  useEffect(() => {
    if (!filtering || flatFileCache.value[k]) return;
    rpc
      .call('fs.findFiles', { h: hostId, root, limit: 30000 }, 60_000)
      .then((list: string[]) => (flatFileCache.value = { ...flatFileCache.value, [k]: list }))
      .catch(() => {
        /* sem lista plana, a árvore só não filtra — não quebra a navegação normal */
      });
  }, [filtering, hostId, root]);
  const flat = flatFileCache.value[k];
  const filterSets = useMemo(() => (filtering && flat ? computeFilterSets(flat, filterQ) : null), [filtering, flat, filterQ]);

  const newItem = (kind: 'file' | 'folder', parent = root) => {
    if (collapsed) toggleCollapse();
    if (parent !== root) setExpanded(hostId, parent, true);
    loadDir(hostId, parent);
    editing.value = { parent, kind };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 'none' }}>
      <div
        class="section-head"
        data-k={k}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!e.altKey && !e.shiftKey && (e.ctrlKey || e.metaKey) && ['c', 'v'].includes(e.key.toLowerCase()) && e.target === e.currentTarget) {
            e.preventDefault(); e.stopPropagation();
            void (e.key.toLowerCase() === 'c' ? copyExplorerItem(hostId, root) : pasteExplorerItem(hostId, root));
          }
        }}
        onClick={toggleCollapse}
        onContextMenu={(e) =>
          openMenu(e as any, [
            { label: 'Novo arquivo…', icon: 'new-file', action: () => newItem('file') },
            { label: 'Nova pasta…', icon: 'new-folder', action: () => newItem('folder') },
            { separator: true },
            { label: 'Nova conversa nesta pasta', icon: 'comment-discussion', action: () => newChat(hostId, root) },
            { label: 'Copiar', icon: 'copy', kb: 'Ctrl+C', action: () => copyExplorerItem(hostId, root) },
            { label: 'Colar aqui', icon: 'clippy', kb: 'Ctrl+V', action: () => pasteExplorerItem(hostId, root) },
            { label: 'Copiar caminho', icon: 'copy', action: () => navigator.clipboard.writeText(root) },
            ...(isWorkspace
              ? [
                  { label: 'Abrir outra pasta…', icon: 'folder-opened', action: () => (folderBrowser.value = { hostId, start: root, purpose: 'workspace' as const }) },
                  { label: 'Adicionar pasta ao explorador…', icon: 'root-folder', action: () => (folderBrowser.value = { hostId, start: root, purpose: 'add-root' as const }) },
                ]
              : [{ label: 'Remover do explorador', icon: 'close', action: () => onUnpin?.() }]),
          ])
        }
      >
        <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
        <span class="grow" title={`${hostLabel(hostId)}: ${root}`}>
          {rootName}
          {isWorkspace && hostId !== 'local' && <span style={{ fontWeight: 400, opacity: 0.7 }}> [{hostId}]</span>}
          {!isWorkspace && <span style={{ fontWeight: 400, opacity: 0.7 }}> — {tildify(root, homeOf(hostId))}</span>}
        </span>
        <button class="icon-btn keep" title="Novo arquivo" onClick={(e) => (e.stopPropagation(), newItem('file'))}>
          <Icon name="new-file" />
        </button>
        <button class="icon-btn keep" title="Nova pasta" onClick={(e) => (e.stopPropagation(), newItem('folder'))}>
          <Icon name="new-folder" />
        </button>
        {isWorkspace && (
          <button
            class="icon-btn keep"
            title="Abrir outra pasta…"
            onClick={(e) => (e.stopPropagation(), (folderBrowser.value = { hostId, start: root, purpose: 'workspace' as const }))}
          >
            <Icon name="folder-opened" />
          </button>
        )}
        {isWorkspace && (
          <button
            class="icon-btn keep"
            title="Adicionar pasta ao explorador…"
            onClick={(e) => (e.stopPropagation(), (folderBrowser.value = { hostId, start: root, purpose: 'add-root' as const }))}
          >
            <Icon name="root-folder" />
          </button>
        )}
        <button class="icon-btn keep" title="Atualizar" onClick={(e) => (e.stopPropagation(), refreshAll(hostId, root))}>
          <Icon name="refresh" />
        </button>
        {isWorkspace && (
          <button class="icon-btn keep" title="Recolher tudo" onClick={(e) => (e.stopPropagation(), (expandedDirs.value = { ...expandedDirs.value, [hostId]: [] }))}>
            <Icon name="collapse-all" />
          </button>
        )}
        {isWorkspace && (
          <button
            class={`icon-btn keep${showHidden.value ? '' : ' on'}`}
            title={showHidden.value ? 'Ocultar arquivos ocultos (.*)' : 'Mostrar arquivos ocultos'}
            onClick={(e) => (e.stopPropagation(), (showHidden.value = !showHidden.value))}
          >
            <Icon name={showHidden.value ? 'eye' : 'eye-closed'} />
          </button>
        )}
        {!isWorkspace && (
          <button class="icon-btn keep" title="Remover do explorador" onClick={(e) => (e.stopPropagation(), onUnpin?.())}>
            <Icon name="close" />
          </button>
        )}
      </div>
      {!isCollapsed && (
        <>
          {(dir?.loading || (filtering && !flat)) && <div class="tree-loading" />}
          <div
            class={dropRoot ? 'drop-target' : ''}
            onDragOver={(e) => {
              if (isDeckDrag(e)) {
                // Espaço da raiz (fora de qualquer pasta): move para a raiz desta seção.
                const ok = overMove(e, hostId, root);
                dropAll.value = false;
                setDropRoot(ok);
                return;
              }
              if (e.dataTransfer?.types.includes('Files')) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
                dropAll.value = false;
                setDropRoot(true);
              }
            }}
            onDragLeave={() => setDropRoot(false)}
            onDrop={(e) => {
              setDropRoot(false);
              if (dropMove(e, hostId, root)) return;
              const dt = e.dataTransfer;
              if (!dt || !dt.types.includes('Files')) return;
              e.preventDefault();
              e.stopPropagation();
              dropUpload(hostId, root, dt);
            }}
            onContextMenu={(e) => {
              if (e.target === e.currentTarget)
                openMenu(e as any, [
                  { label: 'Novo arquivo…', icon: 'new-file', action: () => newItem('file') },
                  { label: 'Nova pasta…', icon: 'new-folder', action: () => newItem('folder') },
                  { separator: true },
                  { label: 'Enviar arquivos para cá…', icon: 'cloud-upload', action: () => pickAndUpload(hostId, root, false) },
                  { label: 'Enviar pasta para cá…', icon: 'cloud-upload', action: () => pickAndUpload(hostId, root, true) },
                  { label: 'Baixar esta pasta (.zip)', icon: 'cloud-download', action: () => downloadEntry(hostId, root, true) },
                  { label: 'Colar aqui', icon: 'clippy', kb: 'Ctrl+V', action: () => pasteExplorerItem(hostId, root) },
                ]);
            }}
          >
            {dir?.error && (
              <div class="tree-empty" style={{ color: 'var(--err)' }}>
                {dir.error}
                {st?.state === 'error' && <div style={{ marginTop: 6 }}>Servidor: {st.error}</div>}
                <div>
                  <button class="btn secondary" style={{ marginTop: 8 }} onClick={() => loadDir(hostId, root, true)}>
                    Tentar de novo
                  </button>
                </div>
              </div>
            )}
            {dir?.items && <VirtualTree hostId={hostId} root={root} items={dir.items} filter={filterSets} onNew={newItem} />}
            {dir?.items && !dir.items.length && !editing.value && <div class="tree-empty">Pasta vazia.</div>}
            {filtering && flat && filterSets && !filterSets.files.size && <div class="tree-empty">Nada encontrado para "{filterQ}".</div>}
          </div>
        </>
      )}
    </div>
  );
}

function refreshAll(hostId: string, rootPath: string) {
  const open = [rootPath, ...(expandedDirs.value[hostId] ?? []).filter((p) => p.startsWith(rootPath))];
  for (const p of open) loadDir(hostId, p, true);
}

/** Árvores virtuais montadas agora: cada uma sabe a lista completa de linhas (a maioria nem existe no DOM). */
const liveTrees = new Set<{ hostId: string; el: () => HTMLElement | null; rows: () => TreeRow[] }>();

/** Rola o explorador até a linha de `full`, mesmo fora da faixa montada. true = achou a linha numa árvore. */
function scrollToVirtualRow(hostId: string, full: string): boolean {
  for (const t of liveTrees) {
    const body = t.el();
    if (t.hostId !== hostId || !body) continue;
    const idx = t.rows().findIndex((r) => r.t === 'entry' && r.full === full);
    const sc = body.closest('.tree-scroller') as HTMLElement | null;
    if (idx < 0 || !sc) continue;
    const y = body.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + idx * ROW_H;
    sc.scrollTop = Math.max(0, y - sc.clientHeight / 2 + ROW_H / 2);
    return true;
  }
  return false;
}

/** Linha (ou cabeçalho de raiz) do explorador que mostra este caminho; null se ainda não está na tela. */
function rowElement(k: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('.sidebar [data-k]')) if (el.dataset.k === k) return el;
  return null;
}

/**
 * Mostra uma pasta no explorador: traz a barra lateral para o explorador, abre todos os níveis até a pasta,
 * lista o conteúdo dela, seleciona e rola até lá. É o que o clique num caminho de pasta da resposta do Claude faz.
 *
 * Não muda a pasta da conversa nem a raiz principal do explorador (ver "Janelas" no CLAUDE.md): uma pasta de
 * dentro da raiz só é aberta na árvore; uma de fora vira pasta fixada (a mesma de "Adicionar pasta ao explorador"),
 * que o usuário remove no X. As listas das pastas do caminho são lidas de novo, porque a pasta costuma ter sido
 * criada pelo Claude agora e o que está no cache não a conhece.
 *
 * Devolve false (já avisando o motivo) quando não deu para mostrar. Só usa fs.list, que todo servidor tem.
 */
export async function revealInExplorer(hostId: string, target: string): Promise<boolean> {
  const ws = workspace.peek();
  if (!ws || ws.hostId !== hostId) {
    toast(`O explorador desta janela não está em ${hostLabel(hostId)}.`, 'info', 5000);
    return false;
  }
  const plat = platformOf(hostId);
  const win = plat === 'win32';
  const sep = win ? '\\' : '/';
  const dest = normalize(plat, target);

  // A raiz mais funda que contém a pasta. Nenhuma: a própria pasta passa a ser uma raiz fixada.
  let container: string | null = null;
  for (const r of [ws.root, ...(extraRoots.peek()[hostId] ?? [])]) {
    if (relativeTo(plat, r, dest) !== null && (!container || r.length > container.length)) container = r;
  }
  if (!container) {
    addExtraRoot(hostId, dest);
    container = dest;
  }

  // Um filtro ativo esconderia a pasta; uma raiz minimizada também.
  sidebarView.value = 'explorer';
  sidebarVisible.value = true;
  explorerFilter.value = '';
  const ck = key(hostId, container);
  if (collapsedRoots.peek()[ck]) collapsedRoots.value = { ...collapsedRoots.peek(), [ck]: false };

  // Desce nível por nível pela listagem de verdade: confirma que existe e pega o nome com as maiúsculas do disco
  // (no Windows o texto da resposta pode vir com outra caixa, e a árvore compara o caminho exato).
  const chain: string[] = [];
  let cur = container;
  for (const seg of (relativeTo(plat, container, dest) ?? '').split(sep).filter(Boolean)) {
    await loadDir(hostId, cur, true);
    const dir = dirCache.peek()[key(hostId, cur)];
    if (!dir?.items) {
      toast(`Não consegui abrir ${tildify(cur, homeOf(hostId))}: ${dir?.error ?? 'a pasta não pôde ser listada'}`, 'error', 7000);
      return false;
    }
    const want = win ? seg.toLowerCase() : seg;
    const hit = dir.items.find((e) => isDir(e) && (win ? e.name.toLowerCase() : e.name) === want);
    if (!hit) {
      toast(`Não achei a pasta "${seg}" em ${tildify(cur, homeOf(hostId))}.`, 'error', 7000);
      return false;
    }
    if (hit.name.startsWith('.')) showHidden.value = true; // senão a árvore esconde justo o que foi pedido
    cur = join(plat, cur, hit.name);
    chain.push(cur);
  }
  await loadDir(hostId, cur, true); // o conteúdo da pasta pedida

  if (chain.length) {
    const open = new Set(expandedDirs.peek()[hostId] ?? []);
    for (const p of chain) open.add(p);
    expandedDirs.value = { ...expandedDirs.peek(), [hostId]: [...open].slice(-300) };
  }
  const k = key(hostId, cur);
  selected.value = k;

  // A árvore desenha depois deste tick (e depois de a barra lateral montar, se estava em outra visão).
  for (let i = 0; i < 40; i++) {
    let el = rowElement(k);
    // Árvore virtual: a linha pode existir só na lista, fora da faixa montada. Rola até a posição dela; o próximo
    // passo do laço já a encontra montada.
    if (!el && scrollToVirtualRow(hostId, cur)) el = rowElement(k);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      // Piscada para o olho achar a pasta (animação do navegador: não mexe nas classes que o Preact controla).
      el.animate?.([{ boxShadow: 'inset 0 0 0 2px var(--focus)' }, { boxShadow: 'inset 0 0 0 2px transparent' }], { duration: 1500, easing: 'ease-out' });
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * A árvore de uma raiz, com só as linhas à vista montadas (altura fixa, posição absoluta). Uma pasta com
 * milhares de arquivos custa o mesmo que uma de dezenas: antes cada arquivo era um componente com ~7 nós
 * de DOM, e uma pasta de 5000 arquivos travava o navegador e o PC inteiro a cada repintura da árvore.
 */
function VirtualTree(props: { hostId: string; root: string; items: FileEntry[]; filter: FilterSets | null; onNew: (k: 'file' | 'folder', parent: string) => void }) {
  const { hostId, root, items, filter } = props;
  const plat = platformOf(hostId);
  const ed = editing.value;
  const hidden = showHidden.value;
  const dirs = dirCache.value;
  const expandedList = expandedDirs.value[hostId];
  const expanded = useMemo(() => new Set(expandedList ?? []), [expandedList]);
  const rows = useMemo(
    () =>
      flattenTree(root, items, {
        showHidden: hidden,
        filter,
        editing: ed,
        expanded,
        joinPath: makeJoin(plat),
        getDir: (full) => dirs[key(hostId, full)],
      }),
    [root, items, hidden, filter, ed, expanded, dirs, hostId, plat],
  );
  const body = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Registro para `revealInExplorer`: rolar até uma linha que ainda não existe no DOM.
  useEffect(() => {
    const t = { hostId, el: () => body.current, rows: () => rowsRef.current };
    liveTrees.add(t);
    return () => void liveTrees.delete(t);
  }, [hostId]);
  const [rawFirst, rawLast] = useRowWindow(body, rows.length);
  // A faixa vem da medição anterior: se a lista encolheu agora (filtro, pasta recolhida), ela ainda aponta além do fim.
  const last = Math.min(rawLast, rows.length);
  const first = Math.min(rawFirst, last);

  // Linhas que ficam montadas mesmo fora da janela: o campo de nome (perderia o foco e o texto digitado)
  // e a linha que está sendo arrastada (o navegador só avisa o fim do arrasto à linha que ainda existe).
  const shown: number[] = [];
  for (let i = first; i < last; i++) shown.push(i);
  let pinned = false;
  for (let i = 0; i < rows.length; i++) {
    if ((i >= first && i < last) || (rows[i].t !== 'input' && !(dragging && rows[i].t === 'entry' && (rows[i] as { full: string }).full === dragging.path))) continue;
    shown.push(i);
    pinned = true;
  }
  if (pinned) shown.sort((a, b) => a - b); // sempre em ordem: o Preact não precisa mover (e tirar o foco de) nenhuma linha

  return (
    <div ref={body} class="tree-virtual" style={{ height: rows.length * ROW_H }}>
      {shown.map((i) => {
        const r = rows[i];
        const top = i * ROW_H;
        if (r.t === 'input') return <NameInput key={r.key} hostId={hostId} depth={r.depth} initial={r.initial} top={top} />;
        if (r.t === 'error')
          return (
            <div key={r.key} class="tree-empty tree-error" style={{ top, paddingLeft: 36 + r.depth * 12 }} title={r.message}>
              {r.message}
            </div>
          );
        return <TreeRowView key={r.key} hostId={hostId} row={r} top={top} onNew={props.onNew} />;
      })}
    </div>
  );
}

function NameInput({ hostId, depth, initial, top }: { hostId: string; depth: number; initial?: string; top?: number }) {
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);
  const ed = editing.value!;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (initial) {
      const dot = initial.lastIndexOf('.');
      el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }
  }, []);
  const commit = async () => {
    if (committed.current) return;
    committed.current = true;
    const name = ref.current?.value.trim() ?? '';
    editing.value = null;
    if (!name || name === initial) return;
    if (/[\\/]/.test(name) && ed.kind === 'rename') {
      toast('Use só o nome, sem barras.', 'error');
      return;
    }
    const plat = platformOf(hostId);
    try {
      if (ed.kind === 'rename' && ed.path) {
        const to = join(plat, dirname(plat, ed.path), name);
        await rpc.call('fs.rename', { h: hostId, from: ed.path, to });
        // Atualiza abas de arquivos abertos.
        for (const f of files.value) if (f.hostId === hostId && (f.path === ed.path || f.path.startsWith(ed.path + (plat === 'win32' ? '\\' : '/')))) closeFile(f.id);
        await refreshDir(hostId, dirname(plat, ed.path));
      } else {
        const target = join(plat, ed.parent, name);
        if (ed.kind === 'folder') await rpc.call('fs.mkdir', { h: hostId, p: target });
        else {
          await rpc.call('fs.write', { h: hostId, p: target, content: '', createOnly: true });
          openFile(hostId, target, { mode: 'edit' });
        }
        await refreshDir(hostId, ed.parent);
      }
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div class="tree-row" style={{ paddingLeft: 8 + depth * 12, top }}>
      <span class="twistie" />
      <FileIcon name={ed.kind === 'folder' ? 'pasta' : (initial ?? 'novo')} dir={ed.kind === 'folder'} />
      <input
        ref={ref}
        class="rename"
        defaultValue={initial ?? ''}
        placeholder={ed.kind === 'folder' ? 'nome da pasta' : ed.kind === 'file' ? 'nome do arquivo' : ''}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') editing.value = null;
          e.stopPropagation();
        }}
        onBlur={() => {
          // O editor à direita pode roubar o foco no mesmo tick em que o campo aparece.
          // Sem nome, não cancela a operação; Enter/Esc continuam disponíveis.
          if (ref.current?.value.trim()) commit();
        }}
        spellcheck={false}
      />
    </div>
  );
}

/** Uma linha montada da árvore (arquivo ou pasta). Aberta/fechada, filtro e renomear já vêm resolvidos em `row`. */
function TreeRowView(props: { hostId: string; row: Extract<TreeRow, { t: 'entry' }>; top: number; onNew: (k: 'file' | 'folder', parent: string) => void }) {
  const { hostId, row, top } = props;
  const { dir, full, entry, depth, folder, open, loading } = row;
  const k = key(hostId, full);
  const [dropping, setDropping] = useState(false);
  const hoverT = useRef<number>(0);
  const isActive = activeFile.value?.hostId === hostId && activeFile.value?.path === full;

  // Pasta aberta cuja listagem ainda não veio (estava fora da tela): carrega ao entrar à vista.
  useEffect(() => {
    if (open) loadDir(hostId, full);
  }, [open]);

  const toggle = () => {
    if (folder) setExpanded(hostId, full, !open);
  };

  const onClick = (e: MouseEvent) => {
    selected.value = k;
    if (folder) toggle();
    else openFile(hostId, full, { activate: true });
    e.stopPropagation();
  };

  const menu = (e: MouseEvent) => {
    selected.value = k;
    const chat = activeChat.value;
    const items = [
      ...(folder
        ? [
            { label: 'Novo arquivo…', icon: 'new-file', action: () => props.onNew('file', full) },
            { label: 'Nova pasta…', icon: 'new-folder', action: () => props.onNew('folder', full) },
            { label: 'Nova conversa nesta pasta', icon: 'comment-discussion', action: () => newChat(hostId, full) },
            { label: 'Abrir como pasta do explorador', icon: 'folder-opened', action: () => (workspace.value = { hostId, root: full }) },
            { label: 'Enviar arquivos para cá…', icon: 'cloud-upload', action: () => pickAndUpload(hostId, full, false) },
            { label: 'Enviar pasta para cá…', icon: 'cloud-upload', action: () => pickAndUpload(hostId, full, true) },
            { label: 'Baixar pasta (.zip)', icon: 'cloud-download', action: () => downloadEntry(hostId, full, true) },
            { separator: true },
          ]
        : [
            { label: 'Abrir', icon: 'go-to-file', action: () => openFile(hostId, full) },
            { label: 'Abrir como texto', icon: 'file-code', action: () => openFile(hostId, full, { mode: 'edit' }) },
            { label: 'Baixar', icon: 'cloud-download', action: () => downloadEntry(hostId, full, false) },
            { separator: true },
          ]),
      ...(chat && chat.state.value.hostId === hostId
        ? [
            {
              label: 'Mencionar na conversa (@)',
              icon: 'mention',
              action: () => window.dispatchEvent(new CustomEvent('deck:mention', { detail: { path: full } })),
            },
          ]
        : []),
      { label: 'Copiar', icon: 'copy', kb: 'Ctrl+C', action: () => copyExplorerItem(hostId, full) },
      { label: 'Colar aqui', icon: 'clippy', kb: 'Ctrl+V', action: () => pasteExplorerItem(hostId, folder ? full : dir) },
      { label: 'Copiar caminho', icon: 'copy', kb: 'Shift+Alt+C', action: () => navigator.clipboard.writeText(full) },
      {
        label: 'Copiar caminho relativo',
        icon: 'copy',
        action: () => {
          const ws = workspace.value;
          const rel = ws ? full.slice(ws.root.replace(/[\\/]+$/, '').length + 1) : full;
          navigator.clipboard.writeText(rel);
        },
      },
      { separator: true },
      { label: 'Renomear…', icon: 'edit', kb: 'F2', action: () => (editing.value = { parent: dir, kind: 'rename', path: full }) },
      { label: 'Mover para…', icon: 'move', action: () => (folderBrowser.value = { hostId, start: dir, purpose: 'move', move: { path: full, dir: folder } }) },
      {
        label: 'Apagar',
        icon: 'trash',
        danger: true,
        kb: 'Del',
        action: () => deleteEntry(hostId, dir, full, folder),
      },
      { separator: true },
      {
        label: `${formatBytes(entry.size)} · ${entry.mtime ? formatDateTime(entry.mtime) : ''}`,
        icon: 'info',
        disabled: true,
      },
    ];
    openMenu(e, items);
  };

  const status = loading && open;
  return (
      <div
        class={`tree-row${selected.value === k || isActive ? ' selected' : ''}${dropping ? ' drop-target' : ''}${entry.name.startsWith('.') ? ' dim' : ''}`}
        data-k={k}
        style={{ paddingLeft: 8 + depth * 12, top }}
        onClick={onClick}
        onContextMenu={menu as any}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!e.altKey && !e.shiftKey && (e.ctrlKey || e.metaKey) && ['c', 'v'].includes(e.key.toLowerCase())) {
            e.preventDefault(); e.stopPropagation();
            void (e.key.toLowerCase() === 'c' ? copyExplorerItem(hostId, full) : pasteExplorerItem(hostId, folder ? full : dir));
          } else if (e.key === 'F2') editing.value = { parent: dir, kind: 'rename', path: full };
          else if (e.key === 'Delete') deleteEntry(hostId, dir, full, folder);
          else if (e.key === 'Enter') onClick(e as any);
        }}
        draggable
        onMouseEnter={(e) => {
          // Tooltip montado só ao passar o mouse: montá-lo para as milhares de linhas a cada repintura pesava mais que tudo.
          (e.currentTarget as HTMLElement).title = `${full}\n${folder ? '' : formatBytes(entry.size) + ' · '}${entry.mtime ? formatDateTime(entry.mtime) : ''}${entry.type === 'symlink' ? ' · link simbólico' : ''}${navigator.userAgent.includes('Firefox') ? '\nPara salvar no Windows, use Baixar no botão direito (arrastar para fora não é suportado no Firefox).' : ''}`;
          // Já pede o link de download: o arrasto para fora do app precisa dele em mãos ao começar.
          window.clearTimeout(hoverT.current);
          if (!navigator.userAgent.includes('Firefox')) hoverT.current = window.setTimeout(() => prefetchTicket(hostId, full, folder), 150);
        }}
        onMouseLeave={() => window.clearTimeout(hoverT.current)}
        onMouseDown={() => { if (!navigator.userAgent.includes('Firefox')) prefetchTicket(hostId, full, folder); }}
        onDragStart={(e) => {
          const dt = e.dataTransfer;
          if (!dt) return;
          dragging = { hostId, path: full, dir: folder };
          dt.setData('text/plain', full);
          dt.setData(DECK_DRAG, JSON.stringify({ hostId, path: full, dir: folder }));
          // Soltar fora do app (Explorer do Windows, área de trabalho): o navegador baixa o arquivo/.zip da pasta.
          if (!navigator.userAgent.includes('Firefox')) {
            const dl = downloadUrlData(hostId, full, folder, entry.name);
            if (dl) dt.setData('DownloadURL', dl);
            else prefetchTicket(hostId, full, folder);
          }
          // Copiar = levar para fora do app (download) ou mencionar na conversa; mover = soltar noutra pasta do explorador.
          dt.effectAllowed = 'copyMove';
        }}
        onDragEnd={() => {
          dragging = null;
          setDropping(false);
        }}
        onDragOver={(e) => {
          if (isDeckDrag(e)) {
            // Sobre uma pasta: vai para dentro dela. Sobre um arquivo: vai para a pasta onde o arquivo está.
            const ok = overMove(e, hostId, folder ? full : dir);
            dropAll.value = false;
            setDropping(folder && ok);
            return;
          }
          if (folder && e.dataTransfer?.types.includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            dropAll.value = false;
            setDropping(true);
          }
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          if (dropMove(e, hostId, folder ? full : dir)) {
            if (folder) setExpanded(hostId, full, true);
            return;
          }
          const dt = e.dataTransfer;
          if (!folder || !dt || !dt.types.includes('Files')) return;
          e.preventDefault();
          e.stopPropagation();
          dropUpload(hostId, full, dt).then(() => setExpanded(hostId, full, true));
        }}
      >
        <span class="twistie">{folder ? <Icon name={status ? 'loading' : open ? 'chevron-down' : 'chevron-right'} class={status ? 'spin' : ''} /> : null}</span>
        <FileIcon name={entry.name} dir={folder} open={open} />
        <span class="label">{entry.name}</span>
        {entry.type === 'symlink' && <Icon name="link" style={{ fontSize: 12, opacity: 0.6 }} />}
      </div>
  );
}

const isDeckDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes(DECK_DRAG);

/** O item arrastado pode ser movido para `destDir` deste servidor? (Vindo de outra janela, só se sabe ao soltar.) */
function canDropMove(hostId: string, destDir: string): boolean {
  const d = dragging;
  if (!d) return true;
  return d.hostId === hostId && moveBlocked(platformOf(hostId), d.path, d.dir, destDir) === null;
}

/** Passando com uma linha do explorador por cima de `destDir`. Devolve se aceita; só mexe no evento se for deste tipo de arrasto. */
function overMove(e: DragEvent, hostId: string, destDir: string): boolean {
  e.preventDefault();
  e.stopPropagation();
  const ok = canDropMove(hostId, destDir);
  e.dataTransfer!.dropEffect = ok ? 'move' : 'none';
  return ok;
}

/** Soltou uma linha do explorador em `destDir`. Devolve true se era esse tipo de arrasto (e já tratou). */
function dropMove(e: DragEvent, hostId: string, destDir: string): boolean {
  if (!isDeckDrag(e)) return false;
  e.preventDefault();
  e.stopPropagation();
  dragging = null;
  let item: { hostId?: string; path?: string; dir?: boolean } = {};
  try {
    item = JSON.parse(e.dataTransfer!.getData(DECK_DRAG));
  } catch {
    return true;
  }
  if (!item.path) return true;
  if (item.hostId !== hostId) {
    toast('Mover entre servidores diferentes ainda não é possível.', 'info', 4000);
    return true;
  }
  void moveEntry(hostId, item.path, !!item.dir, destDir);
  return true;
}

/**
 * Move um arquivo ou pasta para `destDir` (mesmo servidor), mantendo o nome. Nunca sobrescreve: se já
 * existe algo com o mesmo nome lá, nada é movido. Abas de arquivo abertas seguem o item para o novo caminho.
 */
async function moveEntry(hostId: string, from: string, isFolder: boolean, destDir: string): Promise<void> {
  const plat = platformOf(hostId);
  const name = basename(from);
  const destName = basename(destDir) || destDir;
  const blocked = moveBlocked(plat, from, isFolder, destDir);
  if (blocked === 'here') {
    toast(`${name} já está em ${destName}.`, 'info', 2500);
    return;
  }
  if (blocked === 'inside') {
    toast('Não dá para mover uma pasta para dentro dela mesma.', 'error', 5000);
    return;
  }
  // Abas abertas desse item (ou de dentro da pasta). Com alterações não salvas, o caminho antigo voltaria a ser criado ao salvar.
  const affected = files.value.filter((f) => f.hostId === hostId && relativeTo(plat, from, f.path) !== null);
  const unsaved = affected.find((f) => f.dirty.value);
  if (unsaved) {
    toast(`Salve ou feche ${unsaved.name} antes de mover: ele tem alterações não salvas.`, 'error', 6000);
    return;
  }
  const to = join(plat, destDir, name);
  try {
    await rpc.call('fs.rename', { h: hostId, from, to }, 600_000);
  } catch (e) {
    if (e instanceof RpcError && e.code === 'exists') toast(`Já existe "${name}" em ${destName}. Nada foi movido.`, 'error', 6000);
    else toast(`Não consegui mover ${name}: ${errorText(e)}`, 'error', 7000);
    return;
  }
  const activeId = activeFile.value?.id;
  for (const f of affected) {
    const rel = relativeTo(plat, from, f.path) ?? '';
    const mode = f.mode.value;
    const wasActive = f.id === activeId;
    await closeFile(f.id);
    openFile(hostId, rel ? join(plat, to, rel) : to, { activate: wasActive, mode }).catch(() => {});
  }
  flatFileCache.value = {};
  const isRoot = [workspace.value?.root, ...(extraRoots.value[hostId] ?? [])].includes(destDir);
  if (!isRoot) setExpanded(hostId, destDir, true);
  await Promise.all([refreshDir(hostId, dirname(plat, from)), refreshDir(hostId, destDir)]);
  toast(`Movido: ${name} → ${destName}`, 'success', 2500);
}

async function deleteEntry(hostId: string, parent: string, full: string, folder: boolean) {
  const ok = await confirmDialog(
    `Apagar ${basename(full)}?`,
    `${folder ? 'A pasta e TODO o conteúdo dela serão apagados' : 'O arquivo será apagado'} de ${hostLabel(hostId)}. Não há lixeira: não dá para desfazer.`,
    'Apagar',
    true,
  );
  if (!ok) return;
  try {
    await rpc.call('fs.remove', { h: hostId, p: full });
    for (const f of files.value) if (f.hostId === hostId && f.path.startsWith(full)) closeFile(f.id);
    await refreshDir(hostId, parent);
    toast(`Apagado: ${basename(full)}`, 'success', 2000);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

/** Navegador de pastas para escolher onde abrir (workspace ou conversa nova). */
export function FolderBrowser() {
  const fb = folderBrowser.value;
  const [cur, setCur] = useState<string>('');
  const [items, setItems] = useState<FileEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [roots, setRoots] = useState<string[]>([]);

  useEffect(() => {
    if (!fb) return;
    (async () => {
      try {
        if (fb.hostId !== 'local') await rpc.call('hosts.connect', { id: fb.hostId }, 180_000);
        const home: string = fb.start || homeOf(fb.hostId) || (await rpc.call<string>('fs.home', { h: fb.hostId }));
        setCur(home);
        setTyped(home);
        setRoots(await rpc.call('fs.roots', { h: fb.hostId }));
      } catch (e) {
        setErr(errorText(e));
      }
    })();
  }, [fb?.hostId, fb?.start]);

  useEffect(() => {
    if (!fb || !cur) return;
    setItems(null);
    setErr(null);
    rpc
      .call('fs.list', { h: fb.hostId, p: cur })
      .then((list: FileEntry[]) => setItems(list.filter(isDir)))
      .catch((e) => setErr(errorText(e)));
    setTyped(cur);
  }, [cur]);

  if (!fb) return null;
  const plat = platformOf(fb.hostId);
  const close = () => (folderBrowser.value = null);
  const moving = fb.purpose === 'move' ? fb.move : undefined;
  const moveProblem = moving ? moveBlocked(plat, moving.path, moving.dir, cur) : null;
  const choose = (p: string) => {
    if (fb.purpose === 'move') {
      if (!moving || moveBlocked(plat, moving.path, moving.dir, p)) return;
      close();
      void moveEntry(fb.hostId, moving.path, moving.dir, p);
      return;
    }
    close();
    if (fb.purpose === 'chat') newChat(fb.hostId, p);
    else if (fb.purpose === 'add-root') addExtraRoot(fb.hostId, p);
    else openWorkspace(fb.hostId, p);
  };
  const up = dirname(plat, cur);
  return (
    <div class="overlay" onMouseDown={close}>
      <div class="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div class="dialog-head">
          <Icon name={fb.purpose === 'chat' ? 'comment-discussion' : fb.purpose === 'move' ? 'move' : 'folder-opened'} />
          <span class="grow">
            {fb.purpose === 'chat'
              ? 'Nova conversa em…'
              : fb.purpose === 'add-root'
                ? 'Adicionar pasta ao explorador'
                : fb.purpose === 'move'
                  ? `Mover ${moving ? basename(moving.path) : ''} para…`
                  : 'Abrir pasta'}{' '}
            — {hostLabel(fb.hostId)}
          </span>
          <button class="icon-btn" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div class="dialog-body" style={{ paddingTop: 0 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button class="icon-btn" title="Pasta acima" disabled={up === cur} onClick={() => setCur(up)}>
              <Icon name="arrow-up" />
            </button>
            <button class="icon-btn" title="Pasta pessoal" onClick={() => setCur(homeOf(fb.hostId) ?? cur)}>
              <Icon name="home" />
            </button>
            {roots.length > 1 &&
              roots.map((r) => (
                <button key={r} class="btn secondary" style={{ height: 22, padding: '0 6px' }} onClick={() => setCur(r)}>
                  {r}
                </button>
              ))}
            <input
              class="input"
              style={{ flex: 1 }}
              value={typed}
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setCur(typed.trim());
              }}
              spellcheck={false}
            />
          </div>
          <div style={{ height: 320, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
            {!items && !err && <div class="tree-loading" />}
            {err && <div class="tree-empty" style={{ color: 'var(--err)' }}>{err}</div>}
            {items?.map((e) => (
              <div key={e.name} class="tree-row" style={{ paddingLeft: 8 }} onClick={() => setCur(join(plat, cur, e.name))} onDblClick={() => choose(join(plat, cur, e.name))}
                title={moving && moveBlocked(plat, moving.path, moving.dir, join(plat, cur, e.name)) ? 'Não dá para mover para aqui' : undefined}>
                <FileIcon name={e.name} dir />
                <span class="label">{e.name}</span>
              </div>
            ))}
            {items && !items.length && <div class="tree-empty">Sem subpastas.</div>}
          </div>
          <div class="hint" style={{ marginTop: 6, color: 'var(--fg-muted)', fontSize: 12 }}>
            {tildify(cur, homeOf(fb.hostId))} — clique para entrar, duplo clique para escolher.
            {moveProblem === 'here' && ' Já está nesta pasta: entre em outra.'}
            {moveProblem === 'inside' && ' Uma pasta não pode ir para dentro dela mesma.'}
          </div>
        </div>
        <div class="dialog-foot">
          <button class="btn secondary" onClick={close}>
            Cancelar
          </button>
          <button class="btn" disabled={!cur || !!err || !!moveProblem} onClick={() => choose(cur)}>
            {fb.purpose === 'chat' ? 'Iniciar conversa aqui' : fb.purpose === 'add-root' ? 'Adicionar esta pasta' : fb.purpose === 'move' ? 'Mover para esta pasta' : 'Abrir esta pasta'}
          </button>
        </div>
      </div>
    </div>
  );
}
