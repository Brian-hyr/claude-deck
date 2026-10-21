// Comparação de versões do Claude Code ("2.1.293"), usada pelo servidor e pela interface.

/** Positivo se `a` é mais nova que `b`; negativo se mais velha; 0 se iguais. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Versão no formato X.Y.Z (a única que o Deck compara; "?" e textos soltos não contam). */
export function isPlainVersion(v: string | undefined | null): v is string {
  return !!v && /^\d+\.\d+\.\d+$/.test(v);
}

/** `candidate` é uma versão válida e estritamente mais nova que `current`. Versão desconhecida nunca é "mais nova". */
export function isNewerVersion(candidate: string | undefined | null, current: string | undefined | null): boolean {
  if (!isPlainVersion(candidate) || !isPlainVersion(current)) return false;
  return compareVersions(candidate, current) > 0;
}
