import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../../src/web/lib/format';

describe('tempo corrido do turno', () => {
  it('segundos, minutos e horas, sempre inteiros', () => {
    expect(formatElapsed(0)).toBe('0 s');
    expect(formatElapsed(999)).toBe('0 s');
    expect(formatElapsed(1000)).toBe('1 s');
    expect(formatElapsed(59_999)).toBe('59 s');
    expect(formatElapsed(60_000)).toBe('1 min 00 s');
    expect(formatElapsed(9 * 60_000 + 12_000)).toBe('9 min 12 s');
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe('59 min 59 s');
    expect(formatElapsed(3_600_000)).toBe('1 h 00 min');
    expect(formatElapsed(3_600_000 + 5 * 60_000 + 30_000)).toBe('1 h 05 min');
    expect(formatElapsed(26 * 3_600_000)).toBe('26 h 00 min');
  });

  it('relógio adiantado (negativo) não vira número estranho', () => {
    expect(formatElapsed(-5000)).toBe('0 s');
  });
});
