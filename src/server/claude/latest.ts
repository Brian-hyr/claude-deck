// Descobre a versão mais nova do Claude Code publicada (tag "latest" do npm).
// A consulta sai do computador do Deck, não dos servidores: eles podem não ter npm nem internet.
// Falha de rede nunca vira erro visível: sem versão, a interface simplesmente não mostra o aviso.
import { isPlainVersion } from '../../shared/version';

const URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const OK_TTL_MS = 30 * 60_000;
const FAIL_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 4_000;

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<any> }>;

export class LatestClaude {
  private value: string | undefined;
  private expiresAt = 0;
  private pending: Promise<string | undefined> | null = null;

  constructor(
    private fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private now: () => number = Date.now,
    /** Só os testes definem isto (ver `testOverride`): a versão "mais nova" passa a ser a informada. */
    private override: string | undefined = testOverride(),
  ) {}

  /** O último valor conhecido, sem consultar a rede. */
  get current(): string | undefined {
    return this.override ?? this.value;
  }

  /** Consulta (ou reaproveita o cache). Nunca rejeita. */
  ensure(): Promise<string | undefined> {
    if (this.override) return Promise.resolve(this.override);
    if (this.now() < this.expiresAt) return Promise.resolve(this.value);
    if (this.pending) return this.pending;
    this.pending = this.fetchLatest().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async fetchLatest(): Promise<string | undefined> {
    try {
      const res = await this.fetchImpl(URL, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', 'User-Agent': 'Claude-Deck/1.0' } });
      if (!res.ok) throw new Error('resposta não ok');
      const version = (await res.json())?.version;
      if (!isPlainVersion(version)) throw new Error('versão inválida');
      this.value = version;
      this.expiresAt = this.now() + OK_TTL_MS;
    } catch {
      // Mantém a última versão boa (se houver) e tenta de novo daqui a pouco.
      this.expiresAt = this.now() + FAIL_TTL_MS;
    }
    return this.value;
  }
}

/** Só vale com os ganchos de teste ligados (mesmo padrão de `CLAUDE_DECK_TEST_OLD_SERVER` em app.ts). */
export function testOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CLAUDE_DECK_TEST_HOOKS !== '1') return undefined;
  const v = env.CLAUDE_DECK_TEST_LATEST;
  return isPlainVersion(v) ? v : undefined;
}
