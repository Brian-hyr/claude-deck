// Executor remoto (runner.sh) contra o servidor de teste, usando /bin/cat como "Claude falso":
// testa início destacado, anexar, queda de rede, reanexar pelo offset, linha cortada e parada.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, resolvePaths } from '../../src/server/config';
import { PromptBroker } from '../../src/server/prompts';
import { HostRegistry, RUNNER_REL } from '../../src/server/hosts/registry';
import { RemoteTransport } from '../../src/server/claude/transport';
import { TEST_HOST } from './helpers';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe.skipIf(!TEST_HOST)(`runner remoto em ${TEST_HOST}`, () => {
  let registry: HostRegistry;
  const runnerId = `it-${crypto.randomUUID().slice(0, 8)}`;
  const logs: string[] = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-run-'));

  beforeAll(async () => {
    const store = new Store(resolvePaths(dataDir));
    registry = new HostRegistry(store, new PromptBroker(), (m) => logs.push(m));
    const st = await registry.connect(TEST_HOST);
    expect(st.state).toBe('ready');
    expect(st.home).toMatch(/^\//);
    await registry.ensureRunner(TEST_HOST);
  });

  afterAll(async () => {
    const ssh = registry.get(TEST_HOST).ssh!;
    await ssh.run(`sh "$HOME/${RUNNER_REL}" stop ${runnerId}`).catch(() => {});
    registry.closeAll();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function attach(offset: number) {
    return registry
      .get(TEST_HOST)
      .ssh!.exec(`sh "$HOME/${RUNNER_REL}" attach ${runnerId} ${offset}`)
      .then((ch) => new RemoteTransport(ch));
  }

  function collect(t: RemoteTransport) {
    const lines: string[] = [];
    let bytes = 0;
    t.on('line', (l: string, b: number) => {
      lines.push(l);
      bytes += b;
    });
    const ended = new Promise<{ reason: string; code?: number | null }>((r) => t.on('end', r));
    return { lines, bytesRef: () => bytes, ended };
  }

  const until = async (cond: () => boolean, ms = 10_000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('condição não satisfeita a tempo');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('lista binários do Claude no servidor', async () => {
    const bins = await registry.remoteBins(TEST_HOST);
    expect(bins.length).toBeGreaterThan(0);
    expect(bins[0].path).toMatch(/claude$/);
  });

  it('inicia destacado, conversa, sobrevive à queda e reanexa sem duplicar', async () => {
    const ssh = registry.get(TEST_HOST).ssh!;
    const T0 = Date.now();
    const mark = (s: string) => process.stderr.write(`[runner-it +${Date.now() - T0}ms] ${s}\n`);
    const start = await ssh.run(`sh "$HOME/${RUNNER_REL}" start ${runnerId} ${b64('/tmp')} ${b64('/bin/cat')} ${b64('-u')} 600`);
    mark(`start: ${start.stdout.trim()} ${start.stderr.trim()}`);
    expect(start.stdout).toMatch(/^OK \d+ 0/m);

    // 1ª conexão
    const t1 = await attach(0);
    const c1 = collect(t1);
    t1.write('{"n":1}');
    t1.write('{"n":2}');
    await until(() => c1.lines.length >= 2);
    mark('2 linhas recebidas');
    expect(c1.lines).toEqual(['{"n":1}', '{"n":2}']);
    const offset = c1.bytesRef();

    // Linha cortada no meio + queda abrupta da rede.
    (t1 as any).ch.write('{"partial":');
    await new Promise((r) => setTimeout(r, 300));
    ssh.destroyForTest();
    const end1 = await c1.ended;
    mark(`fim 1: ${JSON.stringify(end1)}`);
    expect(end1.reason).toBe('disconnect');

    // O processo continua vivo no servidor.
    await registry.connect(TEST_HOST, true);
    mark('reconectado');
    const st = await registry.get(TEST_HOST).ssh!.run(`sh "$HOME/${RUNNER_REL}" status ${runnerId}`);
    mark(`status: ${st.stdout.trim()}`);
    expect(JSON.parse(st.stdout).alive).toBe(true);

    // 2ª conexão a partir do offset: nada repetido, e a linha cortada foi descartada.
    const t2 = await attach(offset);
    const c2 = collect(t2);
    t2.write('{"n":3}');
    await until(() => c2.lines.length >= 1);
    mark(`2ª conexão: ${JSON.stringify(c2.lines)}`);
    await new Promise((r) => setTimeout(r, 500));
    expect(c2.lines).toEqual(['{"n":3}']);

    // Parar: o anexo recebe o fim do processo.
    await registry.get(TEST_HOST).ssh!.run(`sh "$HOME/${RUNNER_REL}" stop ${runnerId}`);
    mark('stop enviado');
    const end2 = await c2.ended;
    mark(`fim 2: ${JSON.stringify(end2)}`);
    expect(['exit', 'missing', 'disconnect']).toContain(end2.reason);
    const st2 = await registry.get(TEST_HOST).ssh!.run(`sh "$HOME/${RUNNER_REL}" status ${runnerId}`);
    expect(JSON.parse(st2.stdout).exists).toBe(false);
  });

  it('anexar a um runner inexistente avisa "missing"', async () => {
    const t = await attach(0);
    const c = collect(t);
    const end = await c.ended;
    expect(end.reason).toBe('missing');
  });

  it('o processo terminando sozinho chega como "exit" com código', async () => {
    const ssh = registry.get(TEST_HOST).ssh!;
    const id2 = `${runnerId}-x`;
    const r = await ssh.run(`sh "$HOME/${RUNNER_REL}" start ${id2} ${b64('/tmp')} ${b64('/bin/sh')} ${b64('-c exit\\ 7')} 600`);
    expect(r.stdout).toMatch(/^OK/m);
    const t = await registry
      .get(TEST_HOST)
      .ssh!.exec(`sh "$HOME/${RUNNER_REL}" attach ${id2} 0`)
      .then((ch) => new RemoteTransport(ch));
    const c = collect(t);
    const end = await c.ended;
    expect(end.reason).toBe('exit');
    await ssh.run(`sh "$HOME/${RUNNER_REL}" stop ${id2}`);
  });

  it('parar encerra na hora o grupo inteiro (Claude, filhos dele e o vigia de inatividade)', async () => {
    const ssh = registry.get(TEST_HOST).ssh!;
    const id3 = `${runnerId}-g`;
    const fake = `/tmp/deck-grp-${id3}.sh`;
    // "Claude" que abre dois filhos (como ferramentas rodando) e fica esperando.
    await ssh.run(`printf '#!/bin/sh\\nsleep 3001 &\\nsleep 3002 &\\nwait\\n' > ${fake} && chmod 700 ${fake}`);
    const count = async () =>
      Number(
        (
          await ssh.run(
            `n=0; for p in $(pgrep -f 'sleep 300[12]|deck-grp-${id3}|_wrap .*/s/${id3} '); do [ "$p" = "$$" ] || n=$((n+1)); done; echo $n`,
          )
        ).stdout.trim(),
      );
    const r = await ssh.run(`sh "$HOME/${RUNNER_REL}" start ${id3} ${b64('/tmp')} ${b64(fake)} ${b64('-x')} 600`);
    expect(r.stdout).toMatch(/^OK/m);
    await new Promise((res) => setTimeout(res, 400));
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(4); // wrapper, vigia, "Claude" e 2 filhos (+ o sleep do vigia)
    const t = Date.now();
    await ssh.run(`sh "$HOME/${RUNNER_REL}" stop ${id3}`);
    const after = await count();
    process.stderr.write(`[runner-it] grupo: ${before} processos antes, ${after} depois do stop (${Date.now() - t} ms)\n`);
    await ssh.run(`rm -f ${fake}`);
    expect(after).toBe(0);
  });

  it('parar derruba à força quem ignora o TERM (ferramenta presa)', async () => {
    const ssh = registry.get(TEST_HOST).ssh!;
    const id4 = `${runnerId}-k`;
    const fake = `/tmp/deck-grp-${id4}.sh`;
    // Tudo ignora o TERM (o "Claude" e os filhos herdam o sinal ignorado).
    await ssh.run(`printf '#!/bin/sh\\ntrap "" TERM\\nsleep 3003 &\\nsleep 3004 &\\nwait\\n' > ${fake} && chmod 700 ${fake}`);
    const count = async () =>
      Number(
        (
          await ssh.run(`n=0; for p in $(pgrep -f 'sleep 300[34]|deck-grp-${id4}'); do [ "$p" = "$$" ] || n=$((n+1)); done; echo $n`)
        ).stdout.trim(),
      );
    const r = await ssh.run(`sh "$HOME/${RUNNER_REL}" start ${id4} ${b64('/tmp')} ${b64(fake)} ${b64('-x')} 600`);
    expect(r.stdout).toMatch(/^OK/m);
    await new Promise((res) => setTimeout(res, 400));
    expect(await count()).toBeGreaterThanOrEqual(3);
    const t = Date.now();
    await ssh.run(`sh "$HOME/${RUNNER_REL}" stop ${id4}`);
    const ms = Date.now() - t;
    const after = await count();
    process.stderr.write(`[runner-it] ignorando TERM: ${after} processos depois do stop (${ms} ms)\n`);
    await ssh.run(`rm -f ${fake}`);
    expect(after).toBe(0);
    expect(ms).toBeLessThan(8000);
  });

  it('muitos canais na mesma conexão (abre conexão extra se o servidor limitar)', async () => {
    const ssh = registry.get(TEST_HOST).ssh!;
    const chans = await Promise.all(Array.from({ length: 12 }, () => ssh.exec('exec cat')));
    expect(chans.length).toBe(12);
    const echoes = await Promise.all(
      chans.map(
        (ch, i) =>
          new Promise<string>((resolve) => {
            ch.once('data', (d: Buffer) => resolve(d.toString().trim()));
            ch.write(`canal ${i}\n`);
          }),
      ),
    );
    expect(echoes).toEqual(chans.map((_, i) => `canal ${i}`));
    expect(ssh.connectionCount).toBeGreaterThanOrEqual(1);
    for (const ch of chans) ch.end();
  });
});
