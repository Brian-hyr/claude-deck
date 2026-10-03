// Indicador de atividade da janela: vai no começo do título, então aparece na barra de título e
// também na dica que o Windows mostra ao passar o mouse sobre a janela na barra de tarefas.

/** O que uma conversa está pedindo de você, da mais urgente para a menos. */
export type ActivityKind = 'waiting' | 'running' | 'error' | 'done' | 'pending';

export interface ChatActivityInput {
  /** Pedido de permissão que a interface já sabe que está esperando. */
  attention: 'permission' | null;
  /** Pedidos (permissão, pergunta, plano) esperando resposta. */
  pendingCount: number;
  phase: string;
  /** O modelo da conversa está no meio de um turno. */
  modelRunning: boolean;
  /** Terminou e ninguém viu (guardado pelo servidor: sobrevive a recarregar/reiniciar). */
  unseen?: 'done' | 'error';
  manualPending?: boolean;
}

/**
 * Estado de uma conversa, na mesma ordem de prioridade do ícone da aba: esperando você > trabalhando >
 * terminou com erro (não visto) > terminou (não visto). Sem nada disso, `null`.
 * Uma conversa esperando resposta conta só como "esperando", não também como "trabalhando".
 */
export function chatActivity(c: ChatActivityInput): ActivityKind | null {
  if (c.attention === 'permission' || c.pendingCount > 0) return 'waiting';
  if (c.phase === 'running' || c.modelRunning) return 'running';
  if (c.unseen === 'error') return 'error';
  if (c.manualPending) return 'pending';
  if (c.unseen === 'done') return 'done';
  return null;
}

const ICON: Record<ActivityKind, string> = {
  waiting: '🔔',
  error: '❌',
  done: '✅',
  pending: '🔖',
  running: '⏳',
};
const ORDER: ActivityKind[] = ['waiting', 'error', 'pending', 'done', 'running'];

/**
 * Começo do título da janela: um ícone para cada estado presente nas conversas dela (mais urgente
 * primeiro) e, se houver, quantas estão esperando você — ex. `⏳ `, `✅⏳ `, `🔔 (2) `.
 * Sem atividade nenhuma, string vazia (o título fica como sempre foi).
 */
export function activityPrefix(kinds: (ActivityKind | null)[]): string {
  const present = new Set(kinds);
  const icons = ORDER.filter((k) => present.has(k))
    .map((k) => ICON[k])
    .join('');
  if (!icons) return '';
  const waiting = kinds.filter((k) => k === 'waiting').length;
  return `${icons} ${waiting ? `(${waiting}) ` : ''}`;
}
