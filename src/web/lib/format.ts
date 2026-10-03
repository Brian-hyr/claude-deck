// Formatação de tamanhos, datas e textos curtos (pt-BR).

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function timeAgo(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return 'agora';
  if (d < 3600_000) return `há ${Math.floor(d / 60_000)} min`;
  if (d < 86400_000) return `há ${Math.floor(d / 3600_000)} h`;
  if (d < 7 * 86400_000) return `há ${Math.floor(d / 86400_000)} d`;
  return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// Criar um Intl.DateTimeFormat custa caro e `toLocaleString` cria um novo a cada chamada: numa pasta com
// milhares de arquivos isso (uma vez por linha, no tooltip) dominava o tempo de cada repintura da árvore.
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function formatDateTime(ms: number): string {
  return dateTimeFmt.format(new Date(ms));
}

// Mesma razão: o chat refaz a lista inteira de mensagens a cada pedaço de resposta que chega, e cada mensagem
// formatava data/números com `toLocale*String` (um formatador novo por chamada). Com 100 mensagens isso deixava
// a thread principal 77% ocupada durante o streaming (250 mensagens: 99,7%, quadros de 170 ms).
// `toLocaleString(loc, opts)` é definido como `new Intl.NumberFormat(loc, opts).format`: o texto é idêntico.
const intFmt = new Intl.NumberFormat('pt-BR');
const compactFmt1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const compactFmt0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const longDateFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const longTimeFmt = new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', minute: 'numeric', second: 'numeric' });

/** 1234567 → "1.234.567". */
export function formatInt(n: number): string {
  return intFmt.format(n);
}

/** "quinta-feira, 1 de outubro de 2026, 13:45:02" (dica da hora de envio). */
export function formatFullDateTime(ms: number): string {
  const d = new Date(ms);
  return `${longDateFmt.format(d)}, ${longTimeFmt.format(d)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m} min ${r} s`;
}

/**
 * Tempo corrido de um contador ao vivo, sempre em segundos inteiros (não pula de "9,5 s" para "10 s"):
 * 45 s · 9 min 12 s · 1 h 05 min.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m} min ${String(total % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** 271 → "271", 25359 → "25,4k", 1250000 → "1,3M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${(k < 100 ? compactFmt1 : compactFmt0).format(k)}k`;
  }
  return `${compactFmt1.format(n / 1_000_000)}M`;
}

export function formatCost(usd: number | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '';
  return usd < 0.01 ? `US$ ${usd.toFixed(4)}` : `US$ ${usd.toFixed(2)}`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i >= 0 ? s.slice(0, i) : s;
}

/** Busca "fuzzy" simples: todas as letras em ordem. Retorna pontuação (maior = melhor) ou -1. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) {
    const base = t.lastIndexOf('/') < idx || t.lastIndexOf('\\') < idx ? 2000 : 1000;
    return base - idx - t.length * 0.1;
  }
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti) * 0.5;
    ti = found + 1;
  }
  return score - t.length * 0.1;
}
