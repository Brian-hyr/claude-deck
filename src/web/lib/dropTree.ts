// Lê o que o usuário soltou (ou escolheu) para enviar ao servidor: arquivos soltos E pastas inteiras.
// Uma pasta arrastada do Windows chega em `dataTransfer.files` como um "arquivo" que não dá para ler;
// o conteúdo dela só é acessível pela API de entradas (`webkitGetAsEntry`).

export interface UploadFile {
  /** Caminho relativo ao destino, com '/': "minha-pasta/sub/a.txt" ou "solto.txt". */
  rel: string;
  file: File;
}

export interface UploadPlan {
  files: UploadFile[];
  /** Pastas a criar (relativas ao destino), pais antes dos filhos — inclui as vazias. */
  dirs: string[];
  /** Coisas que o navegador não deixou ler (nome + motivo). */
  unreadable: string[];
}

/** Não confiar no nome vindo do navegador: nada de separador, `.` ou `..` que escape do destino. */
export function safeSegment(name: string): string | null {
  const n = name.replace(/[\\/]/g, '_').trim();
  return !n || n === '.' || n === '..' ? null : n;
}

function addDirChain(dirs: Set<string>, rel: string) {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
}

/** Monta o plano a partir de uma lista com `webkitRelativePath` (seletor de pasta `<input webkitdirectory>`). */
export function planFromFileList(list: FileList | File[]): UploadPlan {
  const files: UploadFile[] = [];
  const dirs = new Set<string>();
  const unreadable: string[] = [];
  for (const f of Array.from(list)) {
    const raw = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const segs = raw.split('/').map(safeSegment);
    if (segs.some((s) => s === null)) {
      unreadable.push(raw);
      continue;
    }
    const rel = (segs as string[]).join('/');
    files.push({ rel, file: f });
    if (segs.length > 1) addDirChain(dirs, (segs as string[]).slice(0, -1).join('/'));
  }
  return { files, dirs: [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1)), unreadable };
}

const readEntries = (r: FileSystemDirectoryReader) => new Promise<FileSystemEntry[]>((res, rej) => r.readEntries(res, rej));
const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));

/**
 * Colhe as entradas de um evento de soltar. As chamadas a `webkitGetAsEntry()`/`getAsFile()` TÊM que
 * acontecer de forma síncrona dentro do manipulador do evento (depois de um `await` a lista já foi
 * esvaziada pelo navegador) — por isso esta função é síncrona até o primeiro `await` interno.
 */
export function planFromDrop(dt: DataTransfer): Promise<UploadPlan> {
  const roots: { entry: FileSystemEntry | null; file: File | null; name: string }[] = [];
  const items = dt.items ? Array.from(dt.items).filter((i) => i.kind === 'file') : [];
  if (items.length) {
    for (const it of items) {
      const entry = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
      roots.push({ entry, file: entry ? null : it.getAsFile(), name: entry?.name ?? '' });
    }
  } else {
    for (const f of Array.from(dt.files)) roots.push({ entry: null, file: f, name: f.name });
  }
  return walkRoots(roots);
}

async function walkRoots(roots: { entry: FileSystemEntry | null; file: File | null; name: string }[]): Promise<UploadPlan> {
  const plan: UploadPlan = { files: [], dirs: [], unreadable: [] };
  const dirs = new Set<string>();

  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    const seg = safeSegment(entry.name);
    if (!seg) {
      plan.unreadable.push(entry.name || '(sem nome)');
      return;
    }
    const rel = prefix ? `${prefix}/${seg}` : seg;
    if (entry.isFile) {
      try {
        plan.files.push({ rel, file: await fileOf(entry as FileSystemFileEntry) });
      } catch (e: any) {
        plan.unreadable.push(`${rel}: ${e?.message ?? 'não foi possível ler'}`);
      }
      return;
    }
    if (!entry.isDirectory) return;
    dirs.add(rel);
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    try {
      // readEntries devolve no máximo ~100 por chamada: repetir até vir vazio.
      for (;;) {
        const batch = await readEntries(reader);
        if (!batch.length) break;
        for (const child of batch) await walk(child, rel);
      }
    } catch (e: any) {
      plan.unreadable.push(`${rel}: ${e?.message ?? 'não foi possível ler a pasta'}`);
    }
  }

  for (const r of roots) {
    if (r.entry) await walk(r.entry, '');
    else if (r.file && r.file.name) {
      // Navegador sem a API de entradas: só arquivos soltos. Pasta aparece como arquivo de tamanho 0/4096 sem tipo.
      const seg = safeSegment(r.file.name);
      if (seg) plan.files.push({ rel: seg, file: r.file });
    }
  }
  plan.dirs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  return plan;
}
