// Soltar a conexão SSH de um servidor: ao fechar a última aba, ao fechar a janela cujas conversas estão paradas
// e no botão "Desconectar" (que NÃO pode reconectar sozinho). Contra o servidor de teste (DECK_TEST_HOST).
// Os terminais e o "Claude falso" são de verdade no servidor; nada de inferência real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, login, connectWs, TEST_HOST, type WsClient } from './helpers';

type Env = Awaited<ReturnType<typeof startServer>>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GRACE_MS = 400;
const keys = ['CLAUDE_DECK_TEST_HOOKS', 'CLAUDE_DECK_RELEASE_GRACE_MS', 'CLAUDE_DECK_CLOSE_GRACE_MS'] as const;
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setEnv() {
  process.env.CLAUDE_DECK_TEST_HOOKS = '1';
  process.env.CLAUDE_DECK_RELEASE_GRACE_MS = String(GRACE_MS);
  process.env.CLAUDE_DECK_CLOSE_GRACE_MS = '300';
}
function restoreEnv() {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

async function statusOf(client: WsClient) {
  return (await client.call('hosts.statuses')).find((s: any) => s.id === TEST_HOST);
}
async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout esperando ${what}`);
    await sleep(100);
  }
}
let env: Env; // o ambiente do describe em andamento (para o diagnóstico do waitState)
const waitState = async (client: WsClient, want: string, timeoutMs?: number) => {
  let last: any;
  try {
    return await waitFor(`servidor ${want}`, async () => {
      last = await statusOf(client);
      return last?.state === want ? last : undefined;
    }, timeoutMs);
  } catch (e) {
    // O servidor roda neste processo: mostra por que o SshHost se considera ocupado.
    const ssh = (env as any)?.server?.registry?.handles?.get?.(TEST_HOST)?.ssh;
    const inside = ssh
      ? ` | busy=${ssh.busy} leases=${ssh.leases.size}connecting=${!!ssh.connecting} sftpOpening=${!!ssh.sftpOpening} conns=${JSON.stringify(ssh.conns.map((c: any) => ({ alive: c.alive, channels: c.channels, sftp: !!c.sftp })))} timers=${(env as any).server.registry.releaseTimers.size}`
      : '';
    throw new Error(`${(e as Error).message} (último estado: ${last?.state}, conexões=${last?.connections}, canais=${last?.channels})${inside}`);
  }
};

describe.skipIf(!TEST_HOST)(`soltar a conexão SSH: terminais (${TEST_HOST})`, () => {
  beforeAll(async () => {
    setEnv();
    env = await startServer();
    await env.client.call('hosts.connect', { id: TEST_HOST });
  }, 120_000);
  afterAll(async () => {
    env?.client.close();
    await env?.server.stop();
    restoreEnv();
  });

  const openTerm = async (): Promise<string> => (await env.client.call('term.open', { hostId: TEST_HOST, cols: 80, rows: 24 })).id;

  it('só solta quando a ÚLTIMA aba fecha, e reconecta ao usar o servidor de novo', async () => {
    const a = await openTerm();
    const b = await openTerm();
    expect((await statusOf(env.client)).state).toBe('ready');

    await env.client.call('term.close', { id: a });
    await sleep(GRACE_MS * 3);
    expect((await statusOf(env.client)).state).toBe('ready'); // b ainda está aberta

    await env.client.call('term.close', { id: b });
    const idle = await waitState(env.client, 'idle');
    expect(idle.connections ?? 0).toBe(0);
    // Mantém o que já se sabia do servidor (a interface não perde a pasta pessoal).
    expect(idle.home).toBeTruthy();

    // Usar o servidor de novo (explorador de arquivos) reconecta sozinho.
    const items = await env.client.call('fs.list', { h: TEST_HOST, p: '/tmp' });
    expect(Array.isArray(items)).toBe(true);
    expect((await statusOf(env.client)).state).toBe('ready');
  }, 120_000);

  it('abrir outra aba durante a folga mantém a conexão', async () => {
    await env.client.call('hosts.connect', { id: TEST_HOST });
    const a = await openTerm();
    await env.client.call('term.close', { id: a });
    const b = await openTerm(); // dentro da folga
    await sleep(GRACE_MS * 3);
    expect((await statusOf(env.client)).state).toBe('ready');
    await env.client.call('term.close', { id: b });
    await waitState(env.client, 'idle');
  }, 120_000);
});

describe.skipIf(!TEST_HOST)(`soltar a conexão SSH: conversas remotas (${TEST_HOST})`, () => {
  const remoteBase = `/tmp/deck-it-release-${crypto.randomBytes(4).toString('hex')}`;
  const remoteFake = `${remoteBase}/fake-claude.mjs`;
  const remoteProj = `${remoteBase}/proj`;
  const projKey = remoteProj.replace(/[^a-zA-Z0-9]/g, '-');
  let anchor: WsClient;

  const sshRun = (cmd: string) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', TEST_HOST, cmd], { encoding: 'utf8', timeout: 60_000 });

  beforeAll(async () => {
    setEnv();
    // Uma pasta por janela: cada pasta é de uma janela só.
    sshRun(`mkdir -p '${remoteProj}' '${remoteProj}-win2' '${remoteProj}-win3' '${remoteProj}-win4' && chmod 700 '${remoteBase}'`);
    execFileSync('scp', ['-q', '-o', 'BatchMode=yes', 'fake-claude.mjs', `${TEST_HOST}:${remoteFake}`], { cwd: path.join(ROOT, 'test', 'fake-claude'), timeout: 60_000 });
    sshRun(`chmod 755 '${remoteFake}'`);
    env = await startServer({
      settings: { notifications: false, defaultModel: 'fake-sonnet', defaultPermissionMode: 'bypassPermissions', hostClaudePath: { [TEST_HOST]: remoteFake } },
    });
    // Janela âncora: mantém sempre uma janela viva, para as outras fecharem "sozinhas" sem restaurar nada.
    anchor = await extraClient();
    await anchor.call('window.attach', { wid: `w-anchor-${crypto.randomUUID()}` });
  }, 120_000);
  afterAll(async () => {
    anchor?.close();
    env?.client.close();
    await env?.server.stop();
    try {
      sshRun(`rm -rf '${remoteBase}' ` + ['', '-win2', '-win3', '-win4'].map((x) => `"$HOME/.claude/projects/${projKey}${x}"`).join(' '));
    } catch {
      /* limpeza remota é best-effort */
    }
    restoreEnv();
  });

  async function extraClient(): Promise<WsClient> {
    const cookie = await login(env.server.port, env.server.token);
    return connectWs(env.server.port, cookie);
  }
  async function newChat(client: WsClient, cwd = remoteProj): Promise<string> {
    const st = await client.call('sessions.create', { hostId: TEST_HOST, cwd });
    await client.waitFor((e) => e.event === 'session.state' && e.data.sid === st.sid && e.data.phase === 'idle', 60_000, 'conversa pronta');
    return st.sid as string;
  }
  async function turn(client: WsClient, sid: string, text: string) {
    const from = client.events.length;
    await client.call('sessions.send', { sid, uuid: crypto.randomUUID(), content: [{ type: 'text', text }] });
    await waitFor('resultado do turno', async () => client.events.slice(from).some((e) => e.event === 'session.msg' && e.data.sid === sid && e.data.msg.type === 'result'), 45_000);
  }
  const phaseOf = async (client: WsClient, sid: string) => (await client.call('sessions.list')).find((s: any) => s.sid === sid)?.phase;
  /** Quantas vezes o servidor abriu conexão com TEST_HOST (pelo contador de conexões vivas + registro de quedas). */
  const connections = async (client: WsClient) => (await statusOf(client))?.connections ?? 0;

  it('"Desconectar" com conversa aberta: não reconecta sozinho; a próxima mensagem volta a funcionar', async () => {
    const client = env.client;
    await client.call('window.attach', { wid: `w-${crypto.randomUUID()}` });
    const sid = await newChat(client);
    await turn(client, sid, 'echo antes');
    expect(await connections(client)).toBeGreaterThan(0);

    await client.call('hosts.disconnect', { id: TEST_HOST });
    // A reconexão automática (a que o botão não conseguia vencer) começava em 0,5 s e repetia: espera bem mais.
    await sleep(4000);
    const st = await statusOf(client);
    expect(st.state).toBe('idle');
    expect(st.connections ?? 0).toBe(0);
    expect(await phaseOf(client, sid)).toBe('dormant');

    // Usar a conversa de novo é o que reconecta (o Claude dela seguiu no servidor).
    await turn(client, sid, 'echo depois');
    expect((await statusOf(client)).state).toBe('ready');
    await client.call('sessions.close', { sid });
    await waitState(client, 'idle');
  }, 180_000);

  it('"Desconectar" com várias conversas: nenhuma reconecta', async () => {
    const client = env.client;
    const a = await newChat(client);
    const b = await newChat(client);
    await client.call('hosts.disconnect', { id: TEST_HOST });
    await sleep(4000);
    expect((await statusOf(client)).connections ?? 0).toBe(0);
    expect(await phaseOf(client, a)).toBe('dormant');
    expect(await phaseOf(client, b)).toBe('dormant');
    await client.call('sessions.close', { sid: a });
    await client.call('sessions.close', { sid: b });
  }, 180_000);

  it('interface antiga (reattach sem sids) só religa as conversas da própria janela', async () => {
    // Janela com a interface antiga ainda aberta: antes reanexava as conversas de TODAS as janelas e servidores
    // a cada abertura/reinício, religando as conexões que acabaram de ser soltas.
    const winA = await extraClient();
    const winB = await extraClient();
    try {
      await winA.call('window.attach', { wid: `w-${crypto.randomUUID()}` });
      await winB.call('window.attach', { wid: `w-${crypto.randomUUID()}` });
      const a = await newChat(winA, `${remoteProj}-win3`);
      const b = await newChat(winB, `${remoteProj}-win4`);
      await winA.call('hosts.disconnect', { id: TEST_HOST });
      await waitFor('as duas soltas', async () => (await phaseOf(winA, a)) === 'dormant' && (await phaseOf(winA, b)) === 'dormant');

      await winA.call('sessions.reattach', {}); // exatamente o que a interface antiga manda
      await waitFor('a conversa da janela A voltar', async () => (await phaseOf(winA, a)) === 'idle', 30_000);
      await sleep(3000);
      expect(await phaseOf(winA, b)).toBe('dormant'); // a da janela B continua solta
      await winA.call('sessions.close', { sid: a });
      await winB.call('sessions.close', { sid: b });
    } finally {
      winA.close();
      winB.close();
    }
  }, 180_000);

  it('fechar a última conversa solta a conexão', async () => {
    const client = env.client;
    const a = await newChat(client);
    const b = await newChat(client);
    await client.call('sessions.close', { sid: a });
    await sleep(GRACE_MS * 3);
    expect((await statusOf(client)).state).toBe('ready'); // b ainda está aberta
    await client.call('sessions.close', { sid: b });
    const st = await waitState(client, 'idle');
    expect(st.connections ?? 0).toBe(0);
  }, 180_000);

  it('fechar a janela solta as conversas paradas dela e, com elas, a conexão', async () => {
    const win = await extraClient();
    await win.call('window.attach', { wid: `w-${crypto.randomUUID()}` });
    const sid = await newChat(win, `${remoteProj}-win2`);
    expect((await statusOf(env.client)).state).toBe('ready');
    win.close(); // a janela some; passada a folga ela conta como fechada
    await waitFor('conversa solta', async () => (await phaseOf(anchor, sid)) === 'dormant');
    const st = await waitState(env.client, 'idle');
    expect(st.connections ?? 0).toBe(0);
    // A conversa continua existindo (a janela volta a abrir com ela); só não segura a conexão.
    expect((await anchor.call('sessions.list')).some((s: any) => s.sid === sid)).toBe(true);
  }, 180_000);
});
