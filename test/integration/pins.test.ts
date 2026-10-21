// Mensagens fixadas: marcadores de leitura persistidos por servidor + sessão. Nada disto toca o transcript.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/server/config';
import { MAX_PINS_PER_CONVERSATION, PIN_SNIPPET_MAX } from '../../src/shared/types';
import { startServer, type WsClient } from './helpers';

let env: Awaited<ReturnType<typeof startServer>>;
const sessionA = crypto.randomUUID();
const sessionB = crypto.randomUUID();
const anchor1 = crypto.randomUUID();
const anchor2 = `${crypto.randomUUID()}#1`;

beforeAll(async () => {
  env = await startServer();
});

afterAll(async () => {
  env?.client.close();
  await env?.server.stop();
});

async function expectPinsChanged(client: WsClient, sessionId: string, anchor: string, pinned: boolean) {
  return client.waitFor(
    (event) => event.event === 'pins.changed' && event.data.pinned === pinned && event.data.pin.sessionId === sessionId && event.data.pin.anchor === anchor,
    10_000,
    'evento de mensagem fixada',
  );
}

const pinEvents = () => env.client.events.filter((event) => event.event === 'pins.changed').length;

describe('mensagens fixadas', () => {
  it('anuncia a capacidade e rejeita entradas inválidas ou de outro host', async () => {
    expect((await env.client.call('app.info')).pins).toBe(true);
    await expect(env.client.call('pins.list', { hostId: 'servidor-inventado' })).rejects.toMatchObject({ code: 'nohost' });
    const ok = { hostId: 'local', sessionId: sessionA, anchor: anchor1, role: 'user', snippet: 'oi', pinned: true };
    await expect(env.client.call('pins.set', { ...ok, hostId: 'servidor-inventado' })).rejects.toMatchObject({ code: 'nohost' });
    await expect(env.client.call('pins.set', { ...ok, sessionId: 'não-é-uuid' })).rejects.toMatchObject({ code: 'bad' });
    await expect(env.client.call('pins.set', { ...ok, anchor: 'tem espaço "e aspas"' })).rejects.toMatchObject({ code: 'bad' });
    await expect(env.client.call('pins.set', { ...ok, anchor: 'x'.repeat(101) })).rejects.toMatchObject({ code: 'bad' });
    await expect(env.client.call('pins.set', { ...ok, role: 'system' })).rejects.toMatchObject({ code: 'bad' });
    await expect(env.client.call('pins.set', { ...ok, pinned: 'sim' })).rejects.toMatchObject({ code: 'bad' });
    expect(await env.client.call('pins.list', { hostId: 'local' })).toEqual([]);
  });

  it('fixa, é idempotente e mantém a original ao fixar de novo', async () => {
    const change = expectPinsChanged(env.client, sessionA, anchor1, true);
    await expect(
      env.client.call('pins.set', { hostId: 'local', sessionId: sessionA, anchor: anchor1, role: 'user', snippet: '  primeira \n\n  versão  ', at: 1234, pinned: true }),
    ).resolves.toBe(true);
    await change;
    const first = (await env.client.call('pins.list', { hostId: 'local' }))[0];
    // O trecho sai em uma linha só e a data de envio é guardada.
    expect(first).toMatchObject({ hostId: 'local', sessionId: sessionA, anchor: anchor1, role: 'user', snippet: 'primeira versão', at: 1234 });

    const before = pinEvents();
    // Repetir (inclusive com outro trecho) não muda nada, não regrava e não inunda as outras janelas.
    await env.client.call('pins.set', { hostId: 'local', sessionId: sessionA, anchor: anchor1, role: 'user', snippet: 'outro texto', pinned: true });
    expect(pinEvents()).toBe(before);
    expect(await env.client.call('pins.list', { hostId: 'local' })).toEqual([first]);
  });

  it('separa por conversa e por âncora (inclusive o sufixo #n do mesmo bloco)', async () => {
    const changeB = expectPinsChanged(env.client, sessionB, anchor1, true);
    await env.client.call('pins.set', { hostId: 'local', sessionId: sessionB, anchor: anchor1, role: 'assistant', snippet: 'resposta em outra conversa', pinned: true });
    await changeB;
    const changeA2 = expectPinsChanged(env.client, sessionA, anchor2, true);
    await env.client.call('pins.set', { hostId: 'local', sessionId: sessionA, anchor: anchor2, role: 'assistant', snippet: 'segundo bloco da mesma linha', pinned: true });
    await changeA2;

    const all = await env.client.call('pins.list', { hostId: 'local' });
    expect(all).toHaveLength(3);
    expect(all.filter((p: any) => p.sessionId === sessionA).map((p: any) => p.anchor).sort()).toEqual([anchor1, anchor2].sort());
    expect(all.filter((p: any) => p.sessionId === sessionB).map((p: any) => p.anchor)).toEqual([anchor1]);
  });

  it('persiste e uma nova Store enxerga as mesmas marcas', () => {
    // `flush` simula o processo fechar sem apagar hosts.json.
    env.server.store.flush();
    const restored = new Store(env.server.store.paths);
    expect(restored.listPins('local')).toHaveLength(3);
    expect(restored.listPins('local').map((p) => p.snippet)).toContain('segundo bloco da mesma linha');
    // Nada além do hosts.json é escrito: a conversa em si (transcript) nunca é tocada.
    const raw = JSON.parse(fs.readFileSync(env.server.store.paths.hostsFile, 'utf8'));
    expect(Object.keys(raw.pins)).toHaveLength(2);
  });

  it('remove só a âncora exata e transmite a alteração uma vez', async () => {
    const change = expectPinsChanged(env.client, sessionA, anchor1, false);
    await expect(env.client.call('pins.set', { hostId: 'local', sessionId: sessionA, anchor: anchor1, role: 'user', snippet: '', pinned: false })).resolves.toBe(true);
    await change;
    const left = await env.client.call('pins.list', { hostId: 'local' });
    expect(left.map((p: any) => `${p.sessionId}|${p.anchor}`).sort()).toEqual([`${sessionA}|${anchor2}`, `${sessionB}|${anchor1}`].sort());

    const before = pinEvents();
    await env.client.call('pins.set', { hostId: 'local', sessionId: sessionA, anchor: anchor1, role: 'user', snippet: '', pinned: false });
    expect(pinEvents()).toBe(before);
  });

  it('limita o trecho guardado e o número de fixadas por conversa', async () => {
    const long = crypto.randomUUID();
    await env.client.call('pins.set', { hostId: 'local', sessionId: sessionB, anchor: long, role: 'assistant', snippet: 'a'.repeat(PIN_SNIPPET_MAX * 3), pinned: true });
    const saved = (await env.client.call('pins.list', { hostId: 'local' })).find((p: any) => p.anchor === long);
    expect(saved.snippet).toHaveLength(PIN_SNIPPET_MAX);

    const used = (await env.client.call('pins.list', { hostId: 'local' })).filter((p: any) => p.sessionId === sessionB).length;
    for (let i = used; i < MAX_PINS_PER_CONVERSATION; i++) {
      await env.client.call('pins.set', { hostId: 'local', sessionId: sessionB, anchor: `lote-${i}`, role: 'user', snippet: `m${i}`, pinned: true });
    }
    await expect(
      env.client.call('pins.set', { hostId: 'local', sessionId: sessionB, anchor: 'um-a-mais', role: 'user', snippet: 'não cabe', pinned: true }),
    ).rejects.toMatchObject({ code: 'limit' });
    // Desafixar continua possível com o limite atingido, e libera espaço (`lote-${used}` é o primeiro criado acima).
    await env.client.call('pins.set', { hostId: 'local', sessionId: sessionB, anchor: `lote-${used}`, role: 'user', snippet: '', pinned: false });
    await expect(
      env.client.call('pins.set', { hostId: 'local', sessionId: sessionB, anchor: 'um-a-mais', role: 'user', snippet: 'agora cabe', pinned: true }),
    ).resolves.toBe(true);
  });

  it('ignora entradas corrompidas de um hosts.json antigo ou parcial', () => {
    const dir = fs.mkdtempSync(path.join(env.server.store.paths.dataDir, 'pins-corrupt-'));
    const paths = { ...env.server.store.paths, hostsFile: path.join(dir, 'hosts.json'), settingsFile: path.join(dir, 's.json'), stateFile: path.join(dir, 'st.json') };
    const good = { hostId: 'local', sessionId: sessionA, anchor: anchor1, role: 'user', snippet: 'ok', pinnedAt: 1 };
    fs.writeFileSync(
      paths.hostsFile,
      JSON.stringify({
        pins: {
          a: [good, good, { ...good, anchor: 'com espaço' }, { ...good, role: 'x' }, { ...good, pinnedAt: 'ontem' }, 'lixo', null],
          b: 'não é lista',
        },
      }),
    );
    expect(new Store(paths).listPins('local')).toEqual([good]);
    // E um hosts.json de antes desta funcionalidade (sem a chave) abre normalmente.
    fs.writeFileSync(paths.hostsFile, JSON.stringify({ favorites: [] }));
    expect(new Store(paths).listPins('local')).toEqual([]);
  });
});
