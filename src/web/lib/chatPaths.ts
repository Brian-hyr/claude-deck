// Abrir um arquivo ou pasta citado numa resposta do Claude. O Claude nem sempre escreve o caminho
// inteiro (às vezes só "arquivo.png", com a pasta dita em outra frase), então o clique não pode assumir
// que o item está na pasta da conversa: confere, tenta as pastas citadas no texto e, se preciso,
// procura pelo nome na pasta da conversa. Nunca abre uma aba de erro à toa.
//
// Arquivo abre no editor; pasta é mostrada no explorador (abre os níveis até ela, lista e seleciona).
import { rpc } from './rpc';
import { errorText, homeOf, openFile, platformOf, resolveInCwd, toast, workspace } from './state';
import { cleanRel, dirsOf, matchSuffix, pickCandidate } from './pathHints';
import { extname, isAbsolute, join, normalize, tildify } from '../../shared/paths';
import { openMenu } from '../components/ContextMenu';
import { revealInExplorer } from '../components/Explorer';

/** Onde o usuário clicou por último (o menu de escolha aparece ali). */
let pointer = { x: 160, y: 160 };
if (typeof window !== 'undefined') {
  window.addEventListener(
    'mousedown',
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
    },
    true,
  );
}

type Kind = 'file' | 'dir';

/** O que existe neste caminho (seguindo link simbólico): pasta, arquivo ou nada. Só usa `fs.stat`, que todo servidor tem. */
async function kindOf(hostId: string, p: string): Promise<Kind | null> {
  try {
    const st = await rpc.call('fs.stat', { h: hostId, p }, 20_000);
    return st?.type === 'dir' ? 'dir' : 'file';
  } catch {
    return null;
  }
}

export async function openChatPath(hostId: string, cwd: string, rawPath: string, opts: { line?: number; hints?: string[] } = {}): Promise<void> {
  const plat = platformOf(hostId);
  const win = plat === 'win32';
  const home = homeOf(hostId);
  /** O que já se sabe de cada caminho achado: define se o clique abre o editor ou mostra a pasta no explorador. */
  const kinds = new Map<string, Kind>();
  const show = (full: string) => {
    if (kinds.get(full) === 'dir') void revealInExplorer(hostId, full);
    else void openFile(hostId, full, { line: opts.line });
  };
  let raw = rawPath.replace(/^@/, '').trim();
  if (/^~[\\/]/.test(raw)) {
    if (home) raw = join(plat, home, raw.slice(2));
  }
  const wantsFolder = /[\\/]$/.test(raw); // "criativos/x/": quem escreve a barra no fim está falando de pasta
  const direct = normalize(plat, resolveInCwd(hostId, cwd, raw));

  // Caminho completo, ou o item está mesmo na pasta da conversa: vai direto.
  const here = await kindOf(hostId, direct);
  if (here) {
    kinds.set(direct, here);
    return show(direct);
  }
  if (isAbsolute(plat, raw)) {
    // Arquivo que não existe (ainda): abre mesmo assim, como sempre foi (o editor mostra o erro). Pasta que não existe: avisa.
    if (!wantsFolder && extname(direct)) return show(direct);
    toast(`Não encontrei "${tildify(direct, home)}".`, 'error', 7000);
    return;
  }

  const rel = cleanRel(raw);
  const hints = opts.hints ?? [];
  const label = (full: string) => {
    const n = full.replace(/\\/g, '/');
    const c = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    return n.toLowerCase().startsWith(c.toLowerCase() + '/') ? n.slice(c.length + 1) : tildify(full, home);
  };
  const choose = (found: string[]): boolean => {
    const { chosen, options } = pickCandidate(found, hints);
    if (chosen) {
      show(chosen);
      return true;
    }
    if (!options.length) return false;
    const dirs = options.filter((o) => kinds.get(o) === 'dir').length;
    const what = dirs === options.length ? 'pastas' : dirs === 0 ? 'arquivos' : 'itens';
    openMenu(
      { clientX: pointer.x, clientY: pointer.y },
      [
        { label: `Há ${options.length} ${what} com esse nome. Qual abrir?`, icon: 'info', disabled: true },
        ...options.slice(0, 15).map((full) => ({ label: label(full), icon: kinds.get(full) === 'dir' ? 'folder' : 'file', action: () => show(full) })),
      ],
    );
    return true;
  };

  // 1. As pastas citadas no mesmo texto ("... em criativos/x/, o arquivo y.png").
  const tries = new Set<string>();
  for (const h of hints.slice(0, 16)) {
    const dir = h.startsWith('~/') ? (home ? join(plat, home, h.slice(2)) : '') : join(plat, cwd, win ? h.replace(/\//g, '\\') : h);
    if (!dir) continue;
    const full = join(plat, dir, win ? rel.replace(/\//g, '\\') : rel);
    if (full !== direct) tries.add(full);
  }
  if (tries.size) {
    const hits: string[] = [];
    await Promise.all(
      [...tries].map(async (p) => {
        const k = await kindOf(hostId, p);
        if (k) {
          kinds.set(p, k);
          hits.push(p);
        }
      }),
    );
    if (hits.length && choose(hits)) return;
  }

  // 2. Procura pelo nome na pasta da conversa (e na pasta aberta no explorador, se for outra). A lista só tem
  //    arquivos; as pastas saem dos caminhos deles (uma pasta vazia, portanto, só se acha pelos passos 0 e 1).
  const roots = [cwd];
  const ws = workspace.peek();
  if (ws && ws.hostId === hostId && ws.root !== cwd) roots.push(ws.root);
  const slow = setTimeout(() => toast(`Procurando "${rel}"…`, 'info', 2500), 700);
  try {
    for (const root of roots) {
      const list: string[] = await rpc.call('fs.findFiles', { h: hostId, root, limit: 50000 }, 60_000);
      const abs = (m: string) => join(plat, root, win ? m.replace(/\//g, '\\') : m);
      const files = wantsFolder ? [] : matchSuffix(list, rel, win).map(abs);
      const dirs = matchSuffix(dirsOf(list), rel, win).map(abs);
      for (const f of files) kinds.set(f, 'file');
      for (const d of dirs) kinds.set(d, 'dir');
      const found = [...files, ...dirs];
      if (found.length && choose(found)) return;
    }
  } catch (e) {
    toast(`Não consegui procurar "${rel}": ${errorText(e)}`, 'error', 7000);
    return;
  } finally {
    clearTimeout(slow);
  }
  toast(`Não encontrei "${rel}" na pasta desta conversa (${tildify(cwd, home)}).`, 'error', 7000);
}
