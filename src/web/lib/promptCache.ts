// Contador do cache de prompt, como o indicador da extensão do Claude Code: quanto falta para o
// cache da conversa expirar (5 min, ou 1 h quando o CLI grava com validade longa). Cada chamada ao
// modelo que lê ou grava o cache renova a contagem; passou o prazo, a próxima mensagem paga a
// conversa inteira de novo. Puro (sem DOM), testado à parte.
import { formatTokens } from './format';

export type CacheTtl = '5m' | '1h';

export const CACHE_TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 };

/** O que a última chamada ao modelo (do agente principal) diz sobre o cache. */
export interface PromptCacheRecord {
  messageId?: string;
  /** Início da contagem (ms): quando o pedido que leu/gravou o cache foi feito. */
  anchorAt?: number;
  ttl?: CacheTtl;
  /** Entrada total da chamada (novo + lido + gravado): o que seria regravado se o cache expirasse. */
  recacheTokens?: number;
  /** Compactação em andamento/feita: o cache antigo não cobre mais a conversa. */
  compactedAt?: number;
}

/** Uma chamada ao modelo vista pela tela (ao vivo, transcript ou replay). */
export interface CacheFrame {
  messageId?: string;
  /** Quando a tela recebeu o quadro ao vivo. Vale mais que `timestamp`. */
  receivedAt?: number;
  /** `timestamp` do transcript, em ms. */
  timestamp?: number;
  /** Quando o pedido que gerou o quadro foi enviado. Só vale se não for depois do quadro. */
  requestAt?: number;
  usage?: any;
}

export type CacheWindow =
  | { kind: 'unknown' }
  | { kind: 'warm'; ttl: CacheTtl; msLeft: number; minutesLeft: number }
  | { kind: 'cold'; reason: 'expired' | 'compacted'; idleMs: number; recacheTokens?: number };

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Validade com que o CLI gravou o cache nesta chamada (1 h tem prioridade). Sem gravação nova → undefined. */
export function ttlFromUsage(u: any): CacheTtl | undefined {
  const c = u?.cache_creation;
  if (!c || typeof c !== 'object') return undefined;
  if (n(c.ephemeral_1h_input_tokens) > 0) return '1h';
  if (n(c.ephemeral_5m_input_tokens) > 0) return '5m';
  return undefined;
}

/** Entrada total da chamada. Sem nenhum token informado → undefined. */
export function inputTokensOf(u: any): number | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const t = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  return t > 0 ? t : undefined;
}

/** Quando a contagem deste quadro começa: o pedido, se ele for anterior ao quadro; senão o próprio quadro. */
function frameAnchor(f: CacheFrame): number | undefined {
  const at = f.receivedAt ?? f.timestamp;
  if (f.requestAt !== undefined && (at === undefined || f.requestAt <= at)) return f.requestAt;
  return at;
}

/** O quadro é posterior à compactação? Ao vivo sempre; do transcript, só se o horário for depois dela. */
function isAfterCompaction(f: CacheFrame, compactedAt: number): boolean {
  if (f.receivedAt !== undefined) return true;
  return f.timestamp !== undefined && f.timestamp > compactedAt;
}

/**
 * Atualiza o registro com uma chamada ao modelo. Várias linhas da mesma mensagem (um bloco de raciocínio,
 * um de texto, um de ferramenta) mantêm a âncora da primeira. Chamada sem nenhum token informado não
 * muda nada. Chamada que não leu nem gravou cache deixa a validade desconhecida (o cache não está sendo usado).
 */
export function recordCacheFrame(prev: PromptCacheRecord | undefined, f: CacheFrame): PromptCacheRecord | undefined {
  const recacheTokens = inputTokensOf(f.usage);
  if (recacheTokens === undefined) return prev;
  const same = prev !== undefined && f.messageId !== undefined && prev.messageId === f.messageId;
  const anchorAt = same && prev.anchorAt !== undefined ? prev.anchorAt : frameAnchor(f);
  const touchesCache = n(f.usage.cache_read_input_tokens) + n(f.usage.cache_creation_input_tokens) > 0;
  const compactedAt = prev?.compactedAt;
  const keepCompacted = compactedAt !== undefined && (same || !isAfterCompaction(f, compactedAt));
  return {
    messageId: f.messageId,
    anchorAt,
    ttl: touchesCache ? (ttlFromUsage(f.usage) ?? prev?.ttl) : undefined,
    recacheTokens,
    ...(keepCompacted ? { compactedAt } : {}),
  };
}

/** A conversa foi compactada em `at`: até a próxima chamada, o cache antigo não vale para ela. */
export function markCacheCompacted(prev: PromptCacheRecord | undefined, at: number): PromptCacheRecord {
  return { ...prev, compactedAt: at };
}

/** Estado do cache em `now`. Sem âncora ou validade conhecidas → `unknown` (o contador não aparece). */
export function cacheWindowAt(r: PromptCacheRecord | undefined, now: number): CacheWindow {
  if (r?.compactedAt !== undefined) return { kind: 'cold', reason: 'compacted', idleMs: Math.max(0, now - r.compactedAt) };
  if (!r || r.anchorAt === undefined || r.ttl === undefined) return { kind: 'unknown' };
  const ttlMs = CACHE_TTL_MS[r.ttl];
  const msLeft = Math.min(ttlMs, r.anchorAt + ttlMs - now);
  if (msLeft > 0) return { kind: 'warm', ttl: r.ttl, msLeft, minutesLeft: Math.ceil(msLeft / 60_000) };
  return { kind: 'cold', reason: 'expired', idleMs: Math.max(0, now - r.anchorAt), recacheTokens: r.recacheTokens };
}

/** Tempo parado, compacto: 47m, 2h 5m, 1d 3h. */
export function formatIdle(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Texto ao lado do ícone: minutos restantes. Cache vencido mostra só o ícone (em vermelho). */
export function cachePillLabel(w: CacheWindow): string | undefined {
  return w.kind === 'warm' ? `${w.minutesLeft}m` : undefined;
}

/** Dica do contador (primeira linha = resumo, também usada como rótulo de acessibilidade). */
export function cacheTooltip(w: CacheWindow): string {
  switch (w.kind) {
    case 'unknown':
      return '';
    case 'warm': {
      const left = w.minutesLeft === 1 ? 'cerca de 1 min restante' : `cerca de ${w.minutesLeft} min restantes`;
      return `Cache do prompt ativo: ${left} (validade de ${w.ttl === '1h' ? '1 h' : '5 min'}).\nCada chamada ao modelo que usa o cache renova a contagem.`;
    }
    case 'cold':
      if (w.reason === 'compacted') return 'O cache do prompt não cobre a conversa compactada.\nA próxima mensagem vai recriar o cache.';
      return `Cache do prompt provavelmente expirou (ocioso há ${formatIdle(w.idleMs)}).\n${
        w.recacheTokens === undefined ? 'A próxima mensagem vai recriar o cache.' : `A próxima mensagem vai recriar o cache de cerca de ${formatTokens(w.recacheTokens)} tokens.`
      }`;
  }
}
