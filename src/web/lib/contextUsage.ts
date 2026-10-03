// Uso do contexto, como a "pizza" da extensão do Claude Code ao lado do seletor de modelo: quanto da
// janela de contexto já foi usado até a compactação automática. Aqui fica sempre visível (a extensão só
// mostra com menos da metade livre), para conferir e compactar a qualquer momento.
// Puro (sem DOM), testado à parte.
import { formatTokens } from './format';

/**
 * Compactação automática como o próprio Claude da conversa informa (`get_context_usage`). O valor é do usuário
 * (variável `CLAUDE_CODE_AUTO_COMPACT_WINDOW` ou `autoCompactWindow` nas configurações) e pode ser bem menor que a
 * janela do modelo; por isso não dá para deduzir: quem sabe é o Claude daquele computador/servidor.
 */
export interface AutoCompactInfo {
  enabled: boolean;
  /** Janela de compactação em vigor: o valor definido pelo usuário, limitado à janela do modelo. */
  window?: number;
  /** Contexto em que o Claude compacta sozinho: a janela menos a reserva para a resposta e a folga do compactador. */
  threshold?: number;
  /** De onde vem o valor: `env`, `settings` ou um padrão do Claude Code. */
  source?: string;
}

/** O que a tela sabe do contexto da conversa. `contextWindow` 0 = ainda não sei (só vem no resultado de um turno). */
export interface ContextUsageState {
  /** Entrada + saída da última chamada do agente principal: o que já está no contexto. */
  usedTokens: number;
  /** Janela do modelo principal (do `modelUsage` do resultado). */
  contextWindow: number;
  maxOutputTokens: number;
  /** Compactação automática informada pelo Claude; ausente = ainda não informou (ou é um Claude Code antigo). */
  autoCompact?: AutoCompactInfo;
}

export const EMPTY_CONTEXT: ContextUsageState = { usedTokens: 0, contextWindow: 0, maxOutputTokens: 0 };

/** Reserva que o Claude Code deixa para a resposta: no máximo isto, mesmo que o modelo permita mais saída. */
export const OUTPUT_RESERVE_MAX_TOKENS = 20_000;
/** Folga do compactador automático: ele dispara antes de a janela encher. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

export interface ContextMeter {
  usedTokens: number;
  /** Janela do modelo (0 = ainda desconhecida). */
  contextWindow: number;
  /** Base da porcentagem: o limite em que o Claude compacta sozinho, ou (sem essa informação) a janela útil do modelo. */
  effectiveWindow: number;
  /** De onde vem `effectiveWindow`. */
  basis: 'autocompact' | 'model';
  /** 0–100, limitado a 100. */
  percentUsed: number;
  percentRemaining: number;
  autoCompact?: AutoCompactInfo;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Soma de tudo que a chamada leu e escreveu (entrada nova, cache lido, cache gravado e saída). */
export function usedTokensOf(usage: any): number {
  if (!usage || typeof usage !== 'object') return 0;
  return n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens) + n(usage.output_tokens);
}

/** Janela útil até a compactação automática (pode dar ≤ 0 em janelas minúsculas ou desconhecidas). */
export function effectiveContextWindow(contextWindow: number, maxOutputTokens: number): number {
  return n(contextWindow) - Math.min(n(maxOutputTokens), OUTPUT_RESERVE_MAX_TOKENS) - AUTOCOMPACT_BUFFER_TOKENS;
}

/**
 * Medidor do contexto. A base da porcentagem é o limite em que o Claude compacta sozinho quando ele informou (é o
 * que o usuário definiu: 250k, 500k...); sem essa informação, a janela útil do modelo. `undefined` quando nenhuma
 * das duas é conhecida (ou a janela é pequena demais para valer a conta).
 */
export function contextMeter(s: ContextUsageState): ContextMeter | undefined {
  const ac = s.autoCompact;
  const modelWindow = effectiveContextWindow(s.contextWindow, s.maxOutputTokens);
  let effectiveWindow: number;
  let basis: ContextMeter['basis'];
  if (ac?.enabled && ac.threshold && ac.threshold > 0) {
    effectiveWindow = ac.threshold;
    basis = 'autocompact';
  } else if (modelWindow > 0) {
    effectiveWindow = modelWindow;
    basis = 'model';
  } else return undefined;
  const used = n(s.usedTokens);
  const percentUsed = Math.min((used / effectiveWindow) * 100, 100);
  return { usedTokens: used, contextWindow: n(s.contextWindow), effectiveWindow, basis, percentUsed, percentRemaining: 100 - percentUsed, autoCompact: ac };
}

/**
 * O que o clique na pizza faz agora: `compact` manda `/compact` já; `enqueue` (Claude trabalhando) deixa o `/compact` na
 * fila do próprio Claude Code, que o roda quando o turno termina (igual à extensão do VS Code); `queued` é um `/compact`
 * que já está na fila; `compacting` é um que o Claude já está executando.
 */
export type CompactAction = 'compact' | 'enqueue' | 'queued' | 'compacting';

/**
 * `running`: há um turno em andamento. `sent`: situação do último `/compact` enviado por aqui (`ChatModel.compactState`).
 * Sem turno em andamento nunca vale "na fila"/"compactando": é resto velho (comando que o Claude não chegou a rodar,
 * por exemplo depois de uma interrupção), e o clique tem que continuar funcionando.
 */
export function compactAction(running: boolean, sent: 'queued' | 'started' | null | undefined): CompactAction {
  if (!running) return 'compact';
  if (sent === 'queued') return 'queued';
  if (sent === 'started') return 'compacting';
  return 'enqueue';
}

/** O texto é o comando `/compact` (com ou sem instruções depois). */
export function isCompactCommand(text: string): boolean {
  return /^\/compact(\s|$)/i.test(text.trim());
}

const COMPACT_HINTS: Record<CompactAction, string> = {
  compact: 'Clique para compactar agora (/compact).',
  enqueue: 'O Claude está trabalhando. Clique para deixar o /compact na fila: ele roda quando o Claude terminar.',
  queued: '/compact na fila: roda quando o Claude terminar o que está fazendo.',
  compacting: 'Compactando agora.',
};
const COMPACT_ARIA: Record<CompactAction, string> = {
  compact: 'clique para compactar',
  enqueue: 'clique para deixar a compactação na fila',
  queued: 'compactação na fila',
  compacting: 'compactando',
};
const RESERVE_NOTE = 'a reserva para a resposta e para o compactador';

function sourceLabel(source: string | undefined): string | undefined {
  if (source === 'env') return 'variável de ambiente';
  if (source === 'settings') return 'configurações do Claude Code';
  return undefined; // padrões internos (modelo, experimento...) não são escolha do usuário
}

/** Linha da dica sobre a compactação automática: o valor que o usuário definiu e onde ela dispara. */
function autoCompactLine(ac: AutoCompactInfo | undefined): string {
  if (!ac) return 'Compactação automática: o Claude ainda não informou o valor configurado.';
  if (!ac.enabled) return 'Compactação automática: desligada.';
  const label = sourceLabel(ac.source);
  const head = ac.window ? (label ? `definida em ${formatTokens(ac.window)} (${label})` : `janela de ${formatTokens(ac.window)} (padrão do Claude Code)`) : 'ligada';
  const tail = ac.threshold ? ` Compacta em ${formatTokens(ac.threshold)}, já descontada ${RESERVE_NOTE}.` : '';
  return `Compactação automática: ${head}.${tail}`;
}

function modelWindowLine(contextWindow: number, withReserve: boolean): string {
  if (!(contextWindow > 0)) return 'Janela do modelo: ainda desconhecida (aparece quando o próximo turno terminar).';
  return `Janela do modelo: ${formatTokens(contextWindow)} tokens${withReserve ? ` (menos ${RESERVE_NOTE})` : ''}.`;
}

/** Dica ao passar o mouse: uso, o que resta, a janela do modelo e a compactação automática definida pelo usuário. */
export function contextTooltip(m: ContextMeter, action: CompactAction = 'compact'): string {
  const left = Math.round(m.percentRemaining);
  const auto = m.basis === 'autocompact';
  return [
    `Contexto: ${formatTokens(m.usedTokens)} de ${formatTokens(m.effectiveWindow)} tokens usados (${Math.round(m.percentUsed)}%).`,
    auto ? `${left}% restante até a compactação automática.` : `${left}% restante da janela útil do modelo.`,
    modelWindowLine(m.contextWindow, !auto),
    autoCompactLine(m.autoCompact),
    COMPACT_HINTS[action],
  ].join('\n');
}

/** Dica enquanto não há porcentagem (nem a janela do modelo, nem a compactação automática são conhecidas). */
export function contextUnknownTooltip(s: ContextUsageState, action: CompactAction = 'compact'): string {
  return [
    s.usedTokens > 0 ? `Contexto: ${formatTokens(s.usedTokens)} tokens em uso.` : 'Contexto: ainda sem dados desta conversa.',
    'A janela do modelo e a porcentagem aparecem quando o próximo turno terminar.',
    ...(s.autoCompact ? [autoCompactLine(s.autoCompact)] : []),
    COMPACT_HINTS[action],
  ].join('\n');
}

export function contextAriaLabel(m: ContextMeter | undefined, action: CompactAction = 'compact'): string {
  if (!m) return `Uso do contexto ainda desconhecido — ${COMPACT_ARIA[action]}`;
  const what = m.basis === 'autocompact' ? 'do limite de compactação automática' : 'do contexto';
  return `${Math.round(m.percentUsed)}% ${what} usado — ${COMPACT_ARIA[action]}`;
}

/** Traço do anel da pizza (círculo de raio 7 numa caixa 20×20): quanto do contorno fica preenchido. */
export function pieStroke(percentUsed: number): { radius: number; circumference: number; filled: number } {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const p = Math.min(Math.max(Number.isFinite(percentUsed) ? percentUsed : 0, 0), 100);
  return { radius, circumference, filled: (circumference * p) / 100 };
}

/** `[1m]` e similares: o mesmo modelo com a janela estendida. */
const stripVariant = (m: string) => m.replace(/\[[^\]]*\]$/, '');

/**
 * Entrada do `modelUsage` do resultado que vale para o agente principal. O resultado traz um item por modelo
 * usado na sessão (inclusive os auxiliares), então não dá para pegar "o primeiro". Procura, nesta ordem, por
 * cada nome dado (mais recente primeiro): igual, ou igual sem o sufixo `[1m]`; sem nome que case, só aceita
 * se houver um único item. Nunca chuta entre vários.
 */
export function pickModelUsage(modelUsage: any, models: (string | undefined)[]): any | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const keys = Object.keys(modelUsage);
  for (const m of models) {
    if (!m) continue;
    if (keys.includes(m)) return modelUsage[m];
    const base = stripVariant(m);
    const k = keys.find((x) => stripVariant(x) === base);
    if (k) return modelUsage[k];
  }
  return keys.length === 1 ? modelUsage[keys[0]] : undefined;
}

/** Janela e saída máxima do modelo principal segundo o resultado; `undefined` se não der para saber. */
export function windowFromModelUsage(modelUsage: any, models: (string | undefined)[]): { contextWindow: number; maxOutputTokens: number } | undefined {
  const e = pickModelUsage(modelUsage, models);
  const contextWindow = n(e?.contextWindow);
  if (!contextWindow) return undefined;
  return { contextWindow, maxOutputTokens: n(e?.maxOutputTokens) };
}

/**
 * Compactação automática a partir da resposta do Claude ao `get_context_usage`. Sem `isAutoCompactEnabled` (Claude
 * Code antigo) não há o que dizer: `undefined`. `maxTokens` só vale como "janela de compactação" quando o Claude
 * também informa a origem dela (`autocompactSource`): nas versões que não informam, não se sabe o que ele significa.
 */
export function autoCompactFromResponse(r: any): AutoCompactInfo | undefined {
  if (!r || typeof r !== 'object' || typeof r.isAutoCompactEnabled !== 'boolean') return undefined;
  if (!r.isAutoCompactEnabled) return { enabled: false };
  const threshold = n(r.autoCompactThreshold) || undefined;
  const source = typeof r.autocompactSource === 'string' && r.autocompactSource ? r.autocompactSource : undefined;
  const window = source ? n(r.maxTokens) || undefined : undefined;
  if (!threshold) return undefined; // ligada mas sem o limite: não há o que mostrar de confiável
  return { enabled: true, window, threshold, source };
}
