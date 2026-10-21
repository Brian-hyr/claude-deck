// Atualizar o Claude Code de um servidor: pelo protocolo do Deck (sempre) e contra o servidor de teste
// com um "claude" FALSO (só com DECK_TEST_HOST). O Claude de verdade do servidor nunca é tocado.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, resolvePaths } from '../../src/server/config';
import { PromptBroker } from '../../src/server/prompts';
import { HostRegistry } from '../../src/server/hosts/registry';
import { LatestClaude } from '../../src/server/claude/latest';
import { startServer, TEST_HOST } from './helpers';

describe('hosts.updateClaude no protocolo', () => {
  let env: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    env = await startServer();
  });
  afterAll(async () => {
    env?.client.close();
    await env?.server.stop();
  });

  it('recusa o computador local e servidor que não existe, com códigos que a interface entende', async () => {
    await expect(env.client.call('hosts.updateClaude', { id: 'local' })).rejects.toMatchObject({ code: 'local' });
    await expect(env.client.call('hosts.updateClaude', { id: 'servidor-que-nao-existe' })).rejects.toMatchObject({ code: 'nohost' });
  });
});

// Claude falso: --version lê um arquivo; update se comporta como o arquivo "mode" manda.
const FAKE_CLAUDE = `#!/bin/sh
D="$HOME/.cache/claude-deck-it"
case "$1" in
  --version) echo "$(cat "$D/ver") (Claude Code)" ;;
  update)
    echo x >> "$D/calls"
    case "$(cat "$D/mode")" in
      ok) echo "Updating..."; sleep 1; cp "$D/target" "$D/ver"; echo "Updated" ;;
      noop) echo "Already up to date" ;;
      fail) echo "EACCES: permission denied, rename /usr/lib/node_modules" >&2; exit 1 ;;
    esac ;;
esac
`;

describe.skipIf(!TEST_HOST)(`atualizar o Claude Code em ${TEST_HOST} (claude falso)`, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-upd-'));
  let registry: HostRegistry;
  let store: Store;
  let fakePath = '';
  let createdBinDir = false;
  const statuses: any[] = [];

  const sh = async (cmd: string, input?: string) => registry.get(TEST_HOST).ssh!.run(cmd, { input, timeoutMs: 30_000 });
  const setFake = (ver: string, mode: 'ok' | 'noop' | 'fail', target = '99.0.0') =>
    sh(`D="$HOME/.cache/claude-deck-it"; printf %s ${ver} > "$D/ver"; printf %s ${mode} > "$D/mode"; printf %s ${target} > "$D/target"`);
  const calls = async () => Number((await sh(`wc -l < "$HOME/.cache/claude-deck-it/calls" 2>/dev/null || echo 0`)).stdout.trim());

  beforeAll(async () => {
    store = new Store(resolvePaths(dataDir));
    registry = new HostRegistry(store, new PromptBroker(), () => {});
    (registry as any).latest = new LatestClaude(undefined, undefined, '99.0.0');
    registry.on('status', (s) => statuses.push(s));
    const home = (await registry.connect(TEST_HOST)).home!;
    fakePath = `${home}/bin/claude`;
    // Nunca sobrescreve um claude de verdade que já esteja ali.
    const there = await sh(`[ -e "$HOME/bin/claude" ] && echo SIM || echo NAO`);
    if (there.stdout.includes('SIM')) throw new Error(`${fakePath} já existe em ${TEST_HOST}; o teste não vai sobrescrever.`);
    createdBinDir = (await sh(`[ -d "$HOME/bin" ] && echo SIM || echo NAO`)).stdout.includes('NAO');
    await sh(`mkdir -p "$HOME/bin" "$HOME/.cache/claude-deck-it" && cat > "$HOME/bin/claude" && chmod 755 "$HOME/bin/claude" && : > "$HOME/.cache/claude-deck-it/calls"`, FAKE_CLAUDE);
    store.settings.hostClaudePath = { [TEST_HOST]: fakePath };
  }, 90_000);

  afterAll(async () => {
    try {
      await sh(`rm -rf "$HOME/.cache/claude-deck-it" "$HOME/bin/claude"; ${createdBinDir ? 'rmdir "$HOME/bin" 2>/dev/null;' : ''} true`);
    } catch {
      /* servidor fora do ar: nada a limpar daqui */
    }
    registry?.closeAll();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('ao conectar já avisa que há versão mais nova', async () => {
    await setFake('2.1.205', 'ok');
    const st = await registry.connect(TEST_HOST, true);
    expect(st.claude).toMatchObject({ path: fakePath, version: '2.1.205' });
    expect(st.claudeLatest).toBe('99.0.0');
  }, 60_000);

  it('atualiza de verdade no servidor e a versão sobe', async () => {
    await setFake('2.1.205', 'ok');
    await registry.connect(TEST_HOST, true);
    const before = await calls();
    const r = await registry.updateClaude(TEST_HOST);
    expect(r).toMatchObject({ before: '2.1.205', after: '99.0.0', changed: true });
    expect(r.output).toContain('Updated');
    expect(await calls()).toBe(before + 1);
    expect(registry.status(TEST_HOST).claudeLatest).toBeUndefined();
    expect(statuses.at(-1)?.claude?.version).toBe('99.0.0');
  }, 90_000);

  it('já na mais nova do canal: não mudou e o aviso deixa de aparecer', async () => {
    await setFake('2.1.206', 'noop');
    await registry.connect(TEST_HOST, true);
    expect(registry.status(TEST_HOST).claudeLatest).toBe('99.0.0');
    const r = await registry.updateClaude(TEST_HOST);
    expect(r).toMatchObject({ before: '2.1.206', after: '2.1.206', changed: false });
    expect(registry.status(TEST_HOST).claudeLatest).toBeUndefined();
  }, 90_000);

  it('erro do claude update vira erro com a mensagem e a versão fica como estava', async () => {
    await setFake('2.1.207', 'fail');
    await registry.connect(TEST_HOST, true);
    await expect(registry.updateClaude(TEST_HOST)).rejects.toMatchObject({ code: 'update', message: expect.stringContaining('EACCES') });
    expect(registry.status(TEST_HOST).claude?.version).toBe('2.1.207');
    expect(registry.status(TEST_HOST).claudeLatest).toBe('99.0.0');
  }, 90_000);

  it('dois cliques ao mesmo tempo rodam o update uma vez só', async () => {
    await setFake('2.1.208', 'ok');
    await registry.connect(TEST_HOST, true);
    const before = await calls();
    const [a, b] = await Promise.all([registry.updateClaude(TEST_HOST), registry.updateClaude(TEST_HOST)]);
    expect(a).toEqual(b);
    expect(await calls()).toBe(before + 1);
  }, 90_000);
});
