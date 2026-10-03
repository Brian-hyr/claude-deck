// Janelas do app: cada janela tem um id (guardado na própria janela) e o seu estado de tela
// (abas, pasta, arquivos abertos). Lógica pura, sem I/O — a persistência fica no Store.
import crypto from 'node:crypto';
import path from 'node:path';
import type { OpenTarget } from '../shared/openwin';
import { LOCAL_HOST_ID, type SessionState, type UiState } from '../shared/types';

export interface WindowRecord {
  state: UiState;
  updatedAt: number;
  hostId?: string;
  contextCwd?: string;
  shouldRestore?: boolean;
}

export type WindowMap = Record<string, WindowRecord>;

/** Id de janela aceito (vem do navegador: não confiar em nada além disso). */
export const WID_RE = /^[a-zA-Z0-9-]{8,64}$/;

export interface AttachResult {
  wid: string;
  state: UiState;
  /** Início a frio (nenhuma outra janela aberta): as conversas sem dono passam para esta janela. */
  cold: boolean;
  /** Indica que o contexto solicitado já está aberto e em uso em outra janela live. */
  duplicate?: boolean;
}

export function emptyState(): UiState {
  return { chatTabs: [], fileTabs: [] };
}

export function isEmptyState(st: UiState): boolean {
  return !st.chatTabs?.length && !st.fileTabs?.length && !st.workspace;
}

/**
 * Normaliza o caminho de contexto de acordo com a plataforma do host.
 * - Windows local (`LOCAL_HOST_ID`): normaliza separadores ('/' -> '\'), remove barra final
 *   redundante (preservando raízes como C:\) e ignora caixa (toLowerCase).
 * - Remoto POSIX: normaliza separadores POSIX (resolve .. e //), remove barra final redundante
 *   (preservando '/') e é sensível a maiúsculas/minúsculas.
 */
export function normalizeContextPath(hostId: string, folder: string): string {
  if (!folder) return '';
  if (hostId === LOCAL_HOST_ID) {
    let norm = path.win32.normalize(folder);
    if (!/^[a-zA-Z]:\\?$/.test(norm) && norm !== '\\') {
      norm = norm.replace(/[\\/]+$/, '');
    }
    return norm.toLowerCase();
  }
  let norm = path.posix.normalize(folder.replace(/\\/g, '/'));
  if (norm !== '/' && norm.endsWith('/')) {
    norm = norm.replace(/\/+$/, '');
  }
  return norm;
}

/** Chave canônica única para o par (hostId, pasta de contexto). */
export function contextKey(hostId: string, folder: string): string {
  return `${hostId}\0${normalizeContextPath(hostId, folder)}`;
}

export function windowContextKey(hostId: string, folder: string): string {
  return contextKey(hostId, folder);
}

/** Compara se duas pastas no mesmo host representam o mesmo caminho. */
export function sameFolder(hostId: string, a: string, b: string): boolean {
  return normalizeContextPath(hostId, a) === normalizeContextPath(hostId, b);
}

/** Compara se dois pares (host, pasta) representam o mesmo contexto. */
export function sameContext(hostA: string, folderA: string, hostB: string, folderB: string): boolean {
  if (hostA !== hostB) return false;
  return sameFolder(hostA, folderA, folderB);
}

export function compareContext(hostA: string, folderA: string, hostB: string, folderB: string): boolean {
  return sameContext(hostA, folderA, hostB, folderB);
}

export function compareContextKey(keyA: string, keyB: string): boolean {
  return keyA === keyB;
}

/**
 * Obtém o contexto de conversas (hostId e pasta) de uma janela.
 * Regra: se há chatTabs, eles SEMPRE definem o contexto (arquivos/workspace nunca definem contexto
 * se há chats). Sem chats, usa workspace como fallback. Arquivos nunca definem contexto.
 */
export function getWindowContext(win: WindowRecord | UiState, legacy = false): { hostId: string; cwd: string } | undefined {
  const state: UiState = 'state' in win ? win.state : win;
  if (state.chatTabs && state.chatTabs.length > 0) {
    const active = state.chatTabs.find((t) => t.sid === state.activeChat);
    const tab = active ?? state.chatTabs[0];
    return { hostId: tab.hostId, cwd: tab.cwd };
  }
  if ('hostId' in win && win.hostId && win.contextCwd) {
    return { hostId: win.hostId, cwd: win.contextCwd };
  }
  // Pasta só aberta no explorador não define o contexto; só vale para migrar o formato antigo.
  if (legacy && state.workspace && state.workspace.root) {
    return { hostId: state.workspace.hostId, cwd: state.workspace.root };
  }
  return undefined;
}

export function getWindowContextKey(win: WindowRecord | UiState): string | undefined {
  const ctx = getWindowContext(win);
  return ctx ? contextKey(ctx.hostId, ctx.cwd) : undefined;
}

/**
 * Seleciona ou cria a janela correspondente ao contexto.
 * - UMA janela por par (hostId, pasta de contexto das conversas), nunca duas janelas no mesmo par.
 * - Se o mesmo contexto já estiver live e um novo browser pedir attach, prefere a janela existente e retorna duplicate: true.
 * - Se a janela exata estiver fechada, anexa a ela normalmente.
 * - Preserva fallback a frio (restaura a mais recente) e fallback genérico (cria nova vazia).
 */
export function attachWindow(
  wins: WindowMap,
  wid: string | undefined,
  liveOthers: Set<string>,
  now = Date.now(),
  target?: OpenTarget
): AttachResult {
  const known = wid && WID_RE.test(wid) ? wid : undefined;

  // 1. Destino com pasta exata especificada (target.h e target.f)
  if (target && target.f !== undefined) {
    const targetHost = target.h;
    const targetFolder = target.f;

    // Procura janela existente com o mesmo par (hostId, contextCwd)
    let exactId: string | undefined;
    let exactTime = -Infinity;
    for (const [id, rec] of Object.entries(wins)) {
      if (!WID_RE.test(id)) continue;
      const ctx = getWindowContext(rec);
      if (ctx && ctx.hostId === targetHost && sameFolder(targetHost, ctx.cwd, targetFolder)) {
        if (rec.updatedAt > exactTime) {
          exactTime = rec.updatedAt;
          exactId = id;
        }
      }
    }

    if (exactId) {
      if (liveOthers.has(exactId)) {
        return {
          wid: exactId,
          state: wins[exactId].state,
          cold: false,
          duplicate: true,
        };
      }
      wins[exactId].updatedAt = now;
      return {
        wid: exactId,
        state: wins[exactId].state,
        cold: liveOthers.size === 0,
      };
    }

    // Nenhuma janela para este par: cria nova janela para esta pasta
    const nid = known && !wins[known] ? known : crypto.randomUUID();
    wins[nid] = {
      state: emptyState(),
      updatedAt: now,
      hostId: targetHost,
      contextCwd: targetFolder,
      shouldRestore: true,
    };
    return { wid: nid, state: wins[nid].state, cold: liveOthers.size === 0 };
  }

  // 2. Destino apenas com servidor (target.h sem target.f) -> reabre a última janela fechada desse servidor
  if (target && target.f === undefined) {
    const targetHost = target.h;
    let closedHostId: string | undefined;
    let closedHostTime = -Infinity;

    for (const [id, rec] of Object.entries(wins)) {
      if (!WID_RE.test(id) || liveOthers.has(id)) continue;
      const ctx = getWindowContext(rec);
      if (ctx && ctx.hostId === targetHost) {
        if (rec.updatedAt > closedHostTime) {
          closedHostTime = rec.updatedAt;
          closedHostId = id;
        }
      }
    }

    if (closedHostId) {
      wins[closedHostId].updatedAt = now;
      return {
        wid: closedHostId,
        state: wins[closedHostId].state,
        cold: liveOthers.size === 0,
      };
    }

    // Nenhuma janela fechada para este host: cria nova janela para o host
    const nid = known && !wins[known] ? known : crypto.randomUUID();
    wins[nid] = {
      state: emptyState(),
      updatedAt: now,
      hostId: targetHost,
      shouldRestore: true,
    };
    return { wid: nid, state: wins[nid].state, cold: liveOthers.size === 0 };
  }

  // 3. Sem target (target === undefined)
  // 3A. wid conhecido existente: é a mesma janela recarregando (F5) ou reconectando. A conexão
  //     antiga pode ainda não ter caído, por isso não conta como duplicada.
  if (known && wins[known]) {
    wins[known].updatedAt = now;
    return {
      wid: known,
      state: wins[known].state,
      cold: liveOthers.size === 0,
    };
  }

  // 3B. wid não conhecido ou ausente: cold fallback ou generic fallback
  const closed = Object.keys(wins).filter((id) => WID_RE.test(id) && !liveOthers.has(id));
  if (liveOthers.size === 0 && closed.length > 0) {
    const restorable = closed.filter((id) => wins[id].shouldRestore !== false);
    const candidates = restorable.length > 0 ? restorable : closed;
    const selected = candidates.sort((a, b) => wins[b].updatedAt - wins[a].updatedAt)[0];
    if (selected) {
      wins[selected].updatedAt = now;
      return {
        wid: selected,
        state: wins[selected].state,
        cold: true,
      };
    }
  }

  // Generic fallback: nova janela vazia
  const nid = known && !wins[known] ? known : crypto.randomUUID();
  wins[nid] = {
    state: emptyState(),
    updatedAt: now,
  };
  return {
    wid: nid,
    state: wins[nid].state,
    cold: liveOthers.size === 0,
  };
}

/** Grava o estado de uma janela preservando metadados (hostId, contextCwd, shouldRestore). */
export function saveWindowState(wins: WindowMap, wid: string, state: UiState, now = Date.now()): boolean {
  if (!wins[wid]) return false;
  const prev = wins[wid];
  const chatTabs = Array.isArray(state.chatTabs) ? state.chatTabs : [];
  // A identidade vem das conversas (ou de quem criou a janela); arquivos e explorador nunca a mudam.
  const first = chatTabs[0];
  wins[wid] = {
    ...prev,
    state: {
      ...state,
      chatTabs,
      fileTabs: Array.isArray(state.fileTabs) ? state.fileTabs : [],
    },
    updatedAt: now,
    hostId: prev.hostId ?? first?.hostId,
    contextCwd: prev.contextCwd ?? first?.cwd,
    shouldRestore: prev.shouldRestore,
  };
  return true;
}

/** Nunca descarta uma janela com estado salvo só porque há outras janelas. */
export function pruneWindows(wins: WindowMap, live: Set<string>, sessionWids: Set<string> = new Set()): void {
  for (const id of Object.keys(wins)) if (!live.has(id) && !sessionWids.has(id) && isEmptyState(wins[id].state)) delete wins[id];
}

/**
 * Recupera e agrupa sessões por chave de contexto (hostId, cwd),
 * garantindo que hosts/cwds nunca sejam misturados e sem alterar janelas live.
 */
export function reconcileWindowSessions(
  wins: WindowMap,
  sessions: SessionState[],
  live: Set<string> = new Set()
): { owners: Map<string, string>; changed: boolean } {
  const owners = new Map<string, string>();
  let changed = false;

  const keyToWid = new Map<string, string>();
  const savedBySid = new Map<string, string>();

  // Ordena janelas por data de atualização mais recente
  const sortedWids = Object.keys(wins)
    .filter((id) => WID_RE.test(id))
    .sort((a, b) => wins[b].updatedAt - wins[a].updatedAt);

  for (const id of sortedWids) {
    const rec = wins[id];
    for (const tab of rec.state.chatTabs) {
      if (!savedBySid.has(tab.sid)) savedBySid.set(tab.sid, id);
    }
    const ctx = getWindowContext(rec);
    if (ctx && ctx.hostId && ctx.cwd) {
      const key = contextKey(ctx.hostId, ctx.cwd);
      if (!keyToWid.has(key)) {
        keyToWid.set(key, id);
      } else {
        const existing = keyToWid.get(key)!;
        if (live.has(id) && !live.has(existing)) {
          keyToWid.set(key, id);
        }
      }
    }
  }

  for (const s of sessions) {
    const sKey = contextKey(s.hostId, s.cwd);
    let owner: string | undefined;

    // Se s.wid é válido e aponta para uma janela compatível
    if (s.wid && WID_RE.test(s.wid) && wins[s.wid]) {
      const winCtx = getWindowContext(wins[s.wid]);
      if (!winCtx || (sameFolder(winCtx.hostId, winCtx.cwd, s.cwd) && winCtx.hostId === s.hostId)) {
        owner = s.wid;
      }
    }

    if (!owner) {
      const savedWid = savedBySid.get(s.sid);
      if (savedWid && wins[savedWid]) {
        const winCtx = getWindowContext(wins[savedWid]);
        if (!winCtx || (sameFolder(winCtx.hostId, winCtx.cwd, s.cwd) && winCtx.hostId === s.hostId)) {
          owner = savedWid;
        }
      }
    }

    if (!owner && keyToWid.has(sKey)) {
      owner = keyToWid.get(sKey);
    }

    if (!owner) {
      owner = s.wid && WID_RE.test(s.wid) ? s.wid : crypto.randomUUID();
      // Janela de recuperação: fica salva para abrir pelo servidor/pasta, mas não abre sozinha.
      wins[owner] = {
        state: { ...emptyState(), workspace: { hostId: s.hostId, root: s.cwd } },
        updatedAt: s.createdAt,
        hostId: s.hostId,
        contextCwd: s.cwd,
        shouldRestore: false,
      };
      changed = true;
    }
    if (!keyToWid.has(sKey)) keyToWid.set(sKey, owner);

    const targetWin = wins[owner];
    if (!targetWin.hostId) targetWin.hostId = s.hostId;
    if (!targetWin.contextCwd) targetWin.contextCwd = s.cwd;

    // Nunca altera janelas live
    if (!live.has(owner) && !targetWin.state.chatTabs.some((t) => t.sid === s.sid)) {
      targetWin.state.chatTabs.push({
        sid: s.sid,
        hostId: s.hostId,
        cwd: s.cwd,
        sessionId: s.sessionId,
        title: s.title,
      });
      changed = true;
    }

    if (s.wid !== owner) {
      owners.set(s.sid, owner);
    }
  }

  return { owners, changed };
}

/** Id determinístico para a janela de um contexto que ainda não tinha janela própria. */
export function widForContext(hostId: string, folder: string): string {
  return `ctx-${crypto.createHash('sha1').update(contextKey(hostId, folder)).digest('hex').slice(0, 32)}`;
}

/**
 * Migra o formato antigo (janelas por pasta, que podiam se repetir e até misturar servidores)
 * para uma janela por par (servidor, pasta da conversa).
 * - Janelas do mesmo par viram uma só (a mais recente fica com o id); as outras viram apelidos.
 * - Cada aba de conversa vai para a janela do SEU par; aba de outro servidor/pasta não fica misturada.
 * - SIDs repetidos entram uma vez, na ordem das janelas (mais recente primeiro).
 * - Abas de arquivo e pastas extras (só visualização) ficam com a janela onde estavam.
 * - Janela sem conversa usa a pasta do explorador como contexto (só aqui, no formato antigo);
 *   sem nada disso, fica salva sem contexto e não reabre sozinha.
 * - Idempotente: rodar de novo sobre o resultado não muda ids, abas nem ordem.
 */
export function migrateLegacyWindows(
  wins: WindowMap,
  sessions: SessionState[],
): {
  windows: WindowMap;
  owners: Map<string, string>;
  aliases: Record<string, string>;
} {
  const aliases: Record<string, string> = {};
  const owners = new Map<string, string>();
  const out: WindowMap = {};
  const byKey = new Map<string, string>();
  const ids = Object.keys(wins)
    .filter((id) => WID_RE.test(id))
    .sort((a, b) => wins[b].updatedAt - wins[a].updatedAt || a.localeCompare(b));

  // 1. Uma janela por contexto (a mais recente de cada par fica com o id).
  for (const id of ids) {
    const base = wins[id];
    const ctx = getWindowContext(base, true);
    if (!ctx) {
      out[id] = {
        ...base,
        state: { ...base.state, chatTabs: [], fileTabs: (base.state.fileTabs ?? []).map((f) => ({ ...f })) },
        shouldRestore: false,
      };
      continue;
    }
    const key = contextKey(ctx.hostId, ctx.cwd);
    const canon = byKey.get(key);
    if (!canon) {
      byKey.set(key, id);
      out[id] = {
        ...base,
        state: { ...base.state, chatTabs: [], fileTabs: (base.state.fileTabs ?? []).map((f) => ({ ...f })) },
        hostId: ctx.hostId,
        contextCwd: ctx.cwd,
        shouldRestore: base.shouldRestore ?? true,
      };
      continue;
    }
    aliases[id] = canon;
    const target = out[canon];
    const seenFiles = new Set(target.state.fileTabs.map((f) => f.id || `${f.hostId}\0${f.path}`));
    for (const f of base.state.fileTabs ?? []) {
      const k = f.id || `${f.hostId}\0${f.path}`;
      if (!seenFiles.has(k)) {
        target.state.fileTabs.push({ ...f });
        seenFiles.add(k);
      }
    }
    if (!target.state.activeFile && base.state.activeFile) target.state.activeFile = base.state.activeFile;
    if (base.state.extraRoots) {
      const roots = { ...(target.state.extraRoots ?? {}) };
      for (const [h, list] of Object.entries(base.state.extraRoots)) roots[h] = [...new Set([...(roots[h] ?? []), ...list])];
      target.state.extraRoots = roots;
    }
  }

  // 2. Cada aba de conversa vai para a janela do próprio contexto.
  const seen = new Set<string>();
  for (const id of ids) {
    for (const tab of wins[id].state.chatTabs ?? []) {
      if (seen.has(tab.sid)) continue;
      seen.add(tab.sid);
      const key = contextKey(tab.hostId, tab.cwd);
      let canon = byKey.get(key);
      if (!canon) {
        canon = widForContext(tab.hostId, tab.cwd);
        byKey.set(key, canon);
        out[canon] = {
          state: { ...emptyState(), workspace: { hostId: tab.hostId, root: tab.cwd } },
          updatedAt: wins[id].updatedAt,
          hostId: tab.hostId,
          contextCwd: tab.cwd,
          shouldRestore: false,
        };
      }
      out[canon].state.chatTabs.push({ ...tab });
    }
  }

  // 3. Aba ativa válida em cada janela (a dela, ou a de uma janela que foi juntada a ela).
  for (const [wid, rec] of Object.entries(out)) {
    const has = (sid?: string) => !!sid && rec.state.chatTabs.some((t) => t.sid === sid);
    if (has(rec.state.activeChat)) continue;
    const merged = ids.filter((id) => aliases[id] === wid).map((id) => wins[id].state.activeChat);
    rec.state.activeChat = merged.find((sid) => has(sid)) ?? rec.state.chatTabs[0]?.sid;
    if (rec.state.activeChat === undefined) delete rec.state.activeChat;
  }

  // 4. Dono de cada conversa = janela do contexto dela.
  for (const s of sessions) {
    const canon = byKey.get(contextKey(s.hostId, s.cwd));
    if (canon && s.wid !== canon) owners.set(s.sid, canon);
  }

  const windows: WindowMap = {};
  for (const [wid, rec] of Object.entries(out).sort((a, b) => b[1].updatedAt - a[1].updatedAt || a[0].localeCompare(b[0]))) windows[wid] = rec;
  return { windows, owners, aliases };
}
