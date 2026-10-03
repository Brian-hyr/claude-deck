import { describe, it, expect } from 'vitest';
import { formatDateTime, formatFullDateTime, formatInt, formatTokens } from '../../src/web/lib/format';

// Os formatadores foram criados uma vez (era um por chamada). O texto tem que ser exatamente o de antes.

const ANTES = {
  tokens: (n: number) => {
    if (n < 1000) return String(Math.round(n));
    if (n < 1_000_000) {
      const k = n / 1000;
      return `${k.toLocaleString('pt-BR', { maximumFractionDigits: k < 100 ? 1 : 0 })}k`;
    }
    return `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}M`;
  },
  full: (ms: number) => {
    const d = new Date(ms);
    return `${d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${d.toLocaleTimeString('pt-BR')}`;
  },
  dateTime: (ms: number) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
};

describe('formatadores em cache dão o mesmo texto de antes', () => {
  it('formatTokens', () => {
    for (const n of [0, 1, 271, 999, 1000, 1049, 1050, 1500, 9999, 25359, 99_949, 99_950, 100_000, 154_321, 999_999, 1_000_000, 1_250_000, 12_345_678]) {
      expect(formatTokens(n)).toBe(ANTES.tokens(n));
    }
  });
  it('formatInt', () => {
    for (const n of [0, 5, 999, 1000, 12_345, 1_234_567, 987_654_321]) expect(formatInt(n)).toBe(n.toLocaleString('pt-BR'));
  });
  it('formatFullDateTime (dica da hora de envio)', () => {
    for (const s of ['2026-01-01T00:00:00', '2026-10-01T13:45:02', '2025-12-31T23:59:59', '2024-02-29T09:05:07', '2026-07-04T12:00:00']) {
      const ms = new Date(s).getTime();
      expect(formatFullDateTime(ms)).toBe(ANTES.full(ms));
    }
  });
  it('formatDateTime', () => {
    for (const s of ['2026-01-01T00:00:00', '2026-10-01T13:45:02', '2025-12-31T23:59:59']) {
      const ms = new Date(s).getTime();
      expect(formatDateTime(ms)).toBe(ANTES.dateTime(ms));
    }
  });
  it('rápido: milhares de chamadas', () => {
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) {
      formatFullDateTime(1_790_000_000_000 + i * 1000);
      formatInt(i * 37);
      formatTokens(i * 53);
    }
    expect(performance.now() - t0).toBeLessThan(600);
  });
});
