// "Testar todos" contra os servidores REAIS do ~/.ssh/config (só com DECK_CHECK_ALL=1).
// Só leitura e sem interação (como ssh -o BatchMode=yes): nada é gravado nos servidores, nenhuma
// senha é tentada. Não imprime endereços. Servidores filtrados por DECK_SKIP_HOSTS ficam de fora.
import { afterAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers';

const RUN = process.env.DECK_CHECK_ALL === '1';
const SKIP = process.env.DECK_SKIP_HOSTS ? new RegExp(process.env.DECK_SKIP_HOSTS, 'i') : /(?:^$)/;
const hideIps = (s: string) => s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>').replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '<ip>');

describe.skipIf(!RUN)('testar todos os servidores reais', () => {
  let env: Awaited<ReturnType<typeof startServer>>;
  afterAll(async () => {
    await env?.server.stop();
  });

  it('conecta sem interação e mede', async () => {
    env = await startServer({ settings: { notifications: false } });
    const hosts: any[] = await env.client.call('hosts.list');
    const targets = hosts.filter((h) => h.kind === 'ssh' && !SKIP.test(h.id));
    const skipped = hosts.filter((h) => h.kind === 'ssh' && SKIP.test(h.id)).map((h) => h.id);
    const results: { id: string; ok: boolean; ms: number; info: string }[] = [];
    const t0 = Date.now();
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const h = targets[i++];
        try {
          const r = await env.client.call('hosts.check', { id: h.id }, 90_000);
          results.push({
            id: h.id,
            ok: r.ok,
            ms: r.ms,
            info: r.ok ? (r.claude ? `Claude ${r.claude.version}` : 'sem Claude Code') : hideIps(String(r.error ?? '')),
          });
        } catch (e) {
          results.push({ id: h.id, ok: false, ms: 0, info: hideIps((e as Error).message) });
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const total = Date.now() - t0;
    results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.id.localeCompare(b.id));
    // Alias que é um endereço também é mascarado.
    let n = 0;
    const label = (id: string) => (/^[\d.:[\]]+$/.test(id) ? `(alias-IP ${++n})` : id);
    const rows = results.map((r) => ({ ...r, name: label(r.id) }));
    const w = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) process.stderr.write(`[check] ${r.ok ? 'OK  ' : 'FALHA'} ${r.name.padEnd(w)} ${String(r.ms).padStart(6)} ms  ${r.info}\n`);
    const ok = results.filter((r) => r.ok).length;
    process.stderr.write(`[check] ${ok}/${results.length} acessíveis em ${(total / 1000).toFixed(1)} s (6 em paralelo); fora do teste: ${skipped.join(', ') || 'nenhum'}\n`);
    expect(results.length).toBe(targets.length);
  }, 600_000);
});
