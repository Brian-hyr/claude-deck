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
