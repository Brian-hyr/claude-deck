// Ordem automática das abas de conversa: o que precisa de você sobe, o que está parado desce.
// Lógica pura (sem DOM nem signals) para poder ser testada sozinha; quem aplica é o `state.ts`.
import { chatActivity, type ChatActivityInput } from './activity';

/** De quanto em quanto tempo as abas se reorganizam sozinhas. Não precisa ser em tempo real. */
export const TAB_SORT_INTERVAL_MS = 30 * 60_000;

/**
 * 1 = terminou e você ainda não abriu (inclui o que parou de vez por erro)
 * 2 = esperando uma resposta sua (permissão, pergunta, plano)
 * 3 = trabalhando
 * 4 = terminou, já foi vista e está sem atividade
 */
export type TabGroup = 1 | 2 | 3 | 4;

export function tabGroup(i: ChatActivityInput): TabGroup {
  // Erro que derrubou a conversa (não subiu, caiu): travou de vez, então vale como "terminou".
  // Fica antes de "trabalhando" porque o modelo pode ter ficado marcado como rodando quando a
  // partida falhou.
  if (i.phase === 'error') return 1;
  const a = chatActivity(i);
  if (a === 'waiting') return 2;
  if (a === 'running') return 3;
  // Ainda iniciando ou reconectando: o trabalho não parou.
  if (i.phase === 'starting' || i.phase === 'reconnecting') return 3;
  // `unseen: 'error'` só nasce de um turno que ACABOU com erro. Uma ferramenta que falhou no meio
  // do turno (comando errado, arquivo que não existe) não passa por aqui: o Claude segue
  // trabalhando e a aba continua no grupo 3.
  if (a === 'done' || a === 'error' || a === 'pending') return 1;
  return 4;
}

export interface TabSortInput extends ChatActivityInput {
  /** Último começo/fim de turno, em ms. Quanto maior, mais recente. */
  lastActivityAt: number;
}

/**
 * Ordena por grupo (1 → 4) e, dentro de cada grupo, da atividade mais recente para a mais antiga.
 * Empate mantém a ordem em que as abas já estavam. Não altera a lista recebida.
 */
export function sortTabs<T>(tabs: readonly T[], input: (tab: T) => TabSortInput): T[] {
  const keyed = tabs.map((tab, index) => {
    const i = input(tab);
    return { tab, index, group: tabGroup(i), at: Number.isFinite(i.lastActivityAt) ? i.lastActivityAt : 0 };
  });
  keyed.sort((a, b) => a.group - b.group || b.at - a.at || a.index - b.index);
  return keyed.map((k) => k.tab);
}

// ------------------------------------------------------------------ abas fixadas e grupos

/** Onde a aba fica na faixa: fixada (sempre no começo) e/ou grupo (as conversas de uma orquestração). */
export interface TabLayout {
  pinned: boolean;
  /** Id do grupo (o da orquestração). Aba fixada sai do grupo. */
  group?: string;
  /** Âncora do grupo (o orquestrador): o grupo fica onde ela está e ela vem primeiro dentro dele. */
  anchor?: boolean;
}

/**
 * Arruma a faixa: 1) as fixadas no começo, na ordem relativa em que já estavam; 2) depois as outras, com
 * os membros de cada grupo juntos, no lugar da âncora (ou do primeiro membro, sem âncora), a âncora
 * primeiro e os demais na ordem relativa que tinham. Arrastar a âncora leva o grupo inteiro; um membro
 * arrastado para fora do grupo volta para ele. Sem nada a mudar, devolve a MESMA lista (mesma referência).
 */
export function arrangeTabs<T>(tabs: readonly T[], layout: (tab: T) => TabLayout): readonly T[] {
  const meta = tabs.map((tab) => ({ tab, ...layout(tab) }));
  const pinned = meta.filter((m) => m.pinned);
  const rest = meta.filter((m) => !m.pinned);
  const members = new Map<string, typeof rest>();
  for (const m of rest) if (m.group) members.set(m.group, [...(members.get(m.group) ?? []), m]);
  const anchorOf = new Map<string, (typeof rest)[number]>();
  for (const [g, list] of members) anchorOf.set(g, list.find((m) => m.anchor) ?? list[0]);
  const out: T[] = pinned.map((m) => m.tab);
  for (const m of rest) {
    if (!m.group) out.push(m.tab);
    else if (anchorOf.get(m.group) === m) {
      const list = members.get(m.group)!;
      for (const x of [...list.filter((y) => y.anchor), ...list.filter((y) => !y.anchor)]) out.push(x.tab);
    }
  }
  return out.every((t, i) => t === tabs[i]) ? tabs : out;
}

/**
 * Organização automática (`sortTabs`) respeitando fixadas e grupos: as fixadas não saem do lugar; cada
 * grupo se move como um bloco, pela conversa mais urgente dele (e, no empate de urgência, pela mais
 * recente). Dentro do grupo a ordem não muda.
 */
export function sortTabsGrouped<T>(tabs: readonly T[], input: (tab: T) => TabSortInput, layout: (tab: T) => TabLayout): T[] {
  const arranged = arrangeTabs(tabs, layout);
  const head: T[] = [];
  const units: { tabs: T[]; group: TabGroup; at: number; index: number }[] = [];
  let open: { id: string; unit: (typeof units)[number] } | undefined;
  for (const tab of arranged) {
    const l = layout(tab);
    if (l.pinned) {
      head.push(tab);
      continue;
    }
    const i = input(tab);
    const group = tabGroup(i);
    const at = Number.isFinite(i.lastActivityAt) ? i.lastActivityAt : 0;
    if (l.group && open?.id === l.group) {
      const u = open.unit;
      u.tabs.push(tab);
      if (group < u.group) {
        u.group = group;
        u.at = at;
      } else if (group === u.group) u.at = Math.max(u.at, at);
      continue;
    }
    const unit = { tabs: [tab], group, at, index: units.length };
    units.push(unit);
    open = l.group ? { id: l.group, unit } : undefined;
  }
  units.sort((a, b) => a.group - b.group || b.at - a.at || a.index - b.index);
  return [...head, ...units.flatMap((u) => u.tabs)];
}

export type TabSegment<T> =
  | { kind: 'tab'; tab: T }
  /** `tabs`: todos os membros; `shown`: os que aparecem (recolhido, só os que não podem sumir). */
  | { kind: 'group'; id: string; key: string; tabs: T[]; shown: T[]; collapsed: boolean };

/**
 * Pedaços da faixa, na ordem: abas soltas e grupos. Só vira grupo o que tem duas ou mais abas não
 * fixadas (um grupo de uma aba só não tem o que recolher). Grupo recolhido mostra só as abas que não
 * podem ficar escondidas (`keepVisible`: a ativa e as que esperam você).
 */
export function tabSegments<T>(
  tabs: readonly T[],
  layout: (tab: T) => TabLayout,
  opts: { collapsed?: ReadonlySet<string>; keepVisible?: (tab: T) => boolean } = {},
): TabSegment<T>[] {
  const layouts = tabs.map(layout);
  const size = new Map<string, number>();
  for (const l of layouts) if (!l.pinned && l.group) size.set(l.group, (size.get(l.group) ?? 0) + 1);
  const out: TabSegment<T>[] = [];
  tabs.forEach((tab, i) => {
    const l = layouts[i];
    const g = !l.pinned && l.group && (size.get(l.group) ?? 0) >= 2 ? l.group : undefined;
    const last = out[out.length - 1];
    if (!g) out.push({ kind: 'tab', tab });
    else if (last?.kind === 'group' && last.id === g) last.tabs.push(tab);
    else out.push({ kind: 'group', id: g, key: `${g}:${i}`, tabs: [tab], shown: [], collapsed: !!opts.collapsed?.has(g) });
  });
  for (const s of out) if (s.kind === 'group') s.shown = s.collapsed ? s.tabs.filter((t) => opts.keepVisible?.(t) ?? false) : s.tabs;
  return out;
}

/** As abas que aparecem na faixa, na ordem (Alt+número e Ctrl+Tab andam por elas). */
export function visibleTabs<T>(segments: readonly TabSegment<T>[]): T[] {
  return segments.flatMap((s) => (s.kind === 'tab' ? [s.tab] : s.shown));
}

/** Cores dos grupos (as do navegador), escolhidas pelo id: a mesma orquestração tem sempre a mesma cor. */
export const GROUP_COLORS = ['#a371f7', '#4c9aff', '#3fb950', '#d29922', '#f778ba', '#39c5cf', '#f0883e', '#ff7b72'] as const;
export function groupColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

/**
 * Última atividade de uma conversa. O servidor novo informa `lastActivityAt`; contra um servidor
 * antigo a interface usa o que ela mesma viu mudar (`observedAt`) e, sem nada, a criação da conversa.
 */
export function lastActivityOf(st: { lastActivityAt?: number; createdAt?: number }, observedAt?: number): number {
  return Math.max(st.lastActivityAt ?? 0, observedAt ?? 0, st.createdAt ?? 0);
}

export interface TabSortSchedule {
  /** Padrão: 30 minutos. */
  intervalMs?: number;
  /** Se não puder ordenar agora (arrastando ou renomeando uma aba), tenta de novo depois deste tempo. */
  retryMs?: number;
  canRun: () => boolean;
  run: () => void;
}

/** Roda `run` a cada intervalo; se `canRun` disser que não, espera `retryMs` e tenta de novo. Devolve quem para. */
export function scheduleTabSort(o: TabSortSchedule): () => void {
  const retryMs = o.retryMs ?? 10_000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const attempt = () => {
    if (retry) clearTimeout(retry);
    retry = undefined;
    if (!o.canRun()) {
      retry = setTimeout(attempt, retryMs);
      return;
    }
    o.run();
  };
  const timer = setInterval(attempt, o.intervalMs ?? TAB_SORT_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    if (retry) clearTimeout(retry);
    retry = undefined;
  };
}
