// Memória com muitas conversas abertas: N conversas remotas (pelo runner, no servidor de teste,
// simulando "5 servidores × 5 conversas") + algumas locais, cada uma com histórico de verdade.
// A interface (Brave) fica aberta recebendo tudo, como no uso real; o controle do teste usa um
// cliente WebSocket próprio no Node (sem depender de limites do navegador).
// Mede: servidor do app (RSS), aba da interface (heap JS, processo do renderizador) e canais SSH.
//
//   node test/e2e/memory.mjs            (MEM_REMOTE=25 MEM_LOCAL=5 por padrão)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { startEnv, sleep, SANDBOX } from './harness.mjs';

const HOST = process.env.DECK_TEST_HOST;
if (!HOST) {
  console.log('DECK_TEST_HOST não definido. Pulando teste de memória remoto.');
  process.exit(0);
}
if (process.env.DECK_SKIP_HOSTS && new RegExp(process.env.DECK_SKIP_HOSTS, 'i').test(HOST)) {
  throw new Error('Servidor marcado em DECK_SKIP_HOSTS: não usar para testes.');
}
const N_REMOTE = Number(process.env.MEM_REMOTE ?? 25);
const N_LOCAL = Number(process.env.MEM_LOCAL ?? 5);
const SANDBOX_SRC = SANDBOX;
const BASE = `/tmp/deck-mem-${crypto.randomBytes(4).toString('hex')}`;
const FAKE_REMOTE = `${BASE}/fake-claude.mjs`;
const ssh = (cmd) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, cmd], { encoding: 'utf8', timeout: 120_000 });
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`tempo esgotado: ${label}`)), ms))]);

// 5 pastas no servidor (uma por "servidor" simulado).
ssh(`mkdir -p ${BASE} && for i in 1 2 3 4 5; do mkdir -p ${BASE}/proj$i && printf 'teste %s\\n' $i > ${BASE}/proj$i/README.md; done`);
execFileSync('scp', ['-q', '-o', 'BatchMode=yes', path.resolve('test/fake-claude/fake-claude.mjs'), `${HOST}:${FAKE_REMOTE}`]);
ssh(`chmod 755 ${FAKE_REMOTE}`);

const env = await startEnv({ sandboxSrc: SANDBOX_SRC, useRealSsh: true, settings: { hostClaudePath: { [HOST]: FAKE_REMOTE } } });
const { page } = env;

// ------------------------------------------------------------------ cliente de controle (Node)
const token = fs.readFileSync(path.join(env.dataDir, 'token'), 'utf8').trim();
const cookie = await new Promise((res, rej) =>
  http
    .get({ host: '127.0.0.1', port: env.port, path: `/auth?t=${token}` }, (r) => {
      r.resume();
      const c = r.headers['set-cookie']?.[0]?.split(';')[0];
      c ? res(c) : rej(new Error('sem cookie'));
    })
    .on('error', rej),
);
const ws = new WebSocket(`ws://127.0.0.1:${env.port}/ws`, { headers: { cookie, origin: `http://127.0.0.1:${env.port}` } });
await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
let seq = 0;
const pending = new Map();
const states = new Map();
const results = new Map(); // sid -> quantos "result" já chegaram
ws.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p?.rej(new Error(m.error.message)) : p?.res(m.result);
  } else if (m.event === 'session.state') states.set(m.data.sid, m.data);
  else if (m.event === 'session.msg' && m.data.msg?.type === 'result') results.set(m.data.sid, (results.get(m.data.sid) ?? 0) + 1);
});

/** Memória dos processos do Brave de teste (perfil temporário "deck-brave-"), por tipo. */
function braveProcs() {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='brave.exe'\" | Where-Object { $_.CommandLine -match 'deck-brave-' } | " +
    "ForEach-Object { $t = if ($_.CommandLine -match '--type=([\\w-]+)') { $matches[1] } else { 'browser' }; $u = if ($_.CommandLine -match '--utility-sub-type=([\\w.]+)') { ':' + $matches[1] } else { '' }; " +
    "'{0}{1} {2}' -f $t, $u, [math]::Round((Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 / 1MB) }";
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  const list = out.map((l) => {
    const i = l.lastIndexOf(' ');
    return { type: l.slice(0, i), mb: Number(l.slice(i + 1)) || 0 };
  });
  const renderers = list.filter((p) => p.type === 'renderer');
  return {
    rendererMB: renderers.length ? Math.max(...renderers.map((p) => p.mb)) : null,
    renderers: renderers.length,
    braveTotalMB: list.reduce((n, p) => n + p.mb, 0),
    braveProcs: list.length,
  };
}
const call = (method, params) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

// Limpeza SEMPRE (mesmo se o teste quebrar no meio).
let cleaned = false;
async function cleanupAll() {
  if (cleaned) return;
  cleaned = true;
  try {
    const list = await withTimeout(call('sessions.list'), 10_000, 'listar');
    await withTimeout(Promise.all(list.map((s) => call('sessions.close', { sid: s.sid }).catch(() => {}))), 60_000, 'fechar conversas');
  } catch {
    /* app travado: o script abaixo para os processos no servidor */
  }
  ws.close();
  await env.stop().catch(() => {});
  try {
    execFileSync('scp', ['-q', '-o', 'BatchMode=yes', path.resolve('test/e2e/cleanup-remote.sh'), `${HOST}:/tmp/deck-cleanup.sh`]);
    console.log('limpeza no servidor: ' + ssh(`sh /tmp/deck-cleanup.sh '${BASE}'; rm -f /tmp/deck-cleanup.sh`).trim().split('\n').join(' · '));
  } catch (e) {
    console.log(`limpeza no servidor falhou: ${String(e.message).split('\n')[0]}`);
  }
}
const die = async (e) => {
  console.log(`ERRO: ${e?.message ?? e}`);
  await cleanupAll();
  process.exit(1);
};
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

// ------------------------------------------------------------------ medição
async function measure(label) {
  const pid = env.server.pid;
  const rssServer = Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' }).trim());
  const st = await call('app.stats');
  const hs = (await call('hosts.statuses')).find((s) => s.id === HOST);
  let pageInfo = { pageHeapMB: null, domNodes: null, responsive: false };
  try {
    const m = await withTimeout(page.metrics(), 20_000, 'métricas da página');
    const t = Date.now();
    await withTimeout(page.evaluate(() => 1), 20_000, 'página responde');
    pageInfo = { pageHeapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), domNodes: m.Nodes, responsive: true, evalMs: Date.now() - t };
  } catch (e) {
    pageInfo.error = e.message;
  }
  Object.assign(pageInfo, braveProcs());
  const row = {
    label,
    tabs: await page.$$eval('.center .tabs .tab', (e) => e.length).catch(() => null),
    serverRssMB: +(rssServer / 1048576).toFixed(0),
    serverHeapMB: +(st.heapUsed / 1048576).toFixed(1),
    processesAlive: st.alive,
    sshConnections: hs?.connections ?? 0,
    sshChannels: hs?.channels ?? 0,
    ...pageInfo,
  };
  console.log(JSON.stringify(row));
  return row;
}

const rows = [];
rows.push(await measure('vazio'));

// ------------------------------------------------------------------ cria todas de uma vez
const t0 = Date.now();
const created = await withTimeout(
  Promise.all([
    ...Array.from({ length: N_REMOTE }, (_, i) => call('sessions.create', { hostId: HOST, cwd: `${BASE}/proj${(i % 5) + 1}` })),
    ...Array.from({ length: N_LOCAL }, () => call('sessions.create', { hostId: 'local', cwd: env.sandbox })),
  ]),
  60_000,
  'criar conversas',
);
const sids = created.map((s) => s.sid);
const readyAt = new Map();
for (let i = 0; i < 480 && readyAt.size < sids.length; i++) {
  for (const sid of sids) if (states.get(sid)?.phase === 'idle' && !readyAt.has(sid)) readyAt.set(sid, Date.now() - t0);
  const errs = sids.map((s) => states.get(s)).filter((s) => s?.phase === 'error');
  if (errs.length && i % 20 === 0) console.log(`com erro: ${errs.length} — ${errs[0].error}`);
  await sleep(250);
}
const times = [...readyAt.values()].sort((a, b) => a - b);
const pct = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))];
const readyNote = `${readyAt.size}/${sids.length} prontas; 1ª em ${times[0]} ms, mediana ${pct(0.5)} ms, última ${times[times.length - 1]} ms`;
console.log(readyNote);
rows.push(await measure(`${sids.length} conversas abertas (sem mensagens)`));

// ------------------------------------------------------------------ 6 turnos em todas ao mesmo tempo
// Um turno termina quando chega o "result" dele (não basta olhar a fase: pode ser cedo demais).
const turnTimes = [];
for (const msg of ['long', 'markdown', 'long', 'markdown', 'long', 'echo fim']) {
  const before = new Map(sids.map((s) => [s, results.get(s) ?? 0]));
  const t = Date.now();
  await Promise.all(sids.map((sid) => call('sessions.send', { sid, uuid: crypto.randomUUID(), content: [{ type: 'text', text: msg }] })));
  let done = false;
  for (let i = 0; i < 2400 && !done; i++) {
    done = sids.every((s) => (results.get(s) ?? 0) > before.get(s));
    if (!done) await sleep(50);
  }
  if (!done) throw new Error(`turno "${msg}": ${sids.filter((s) => (results.get(s) ?? 0) <= before.get(s)).length} conversas sem resposta`);
  turnTimes.push(`${msg} ${Date.now() - t} ms`);
}
console.log(`turnos (todas as ${sids.length} ao mesmo tempo, até a última responder): ${turnTimes.join(', ')}`);
rows.push(await measure(`${sids.length} conversas × 6 turnos (abas em segundo plano)`));

// ------------------------------------------------------------------ visita todas as abas
const tabCount = await page.$$eval('.center .tabs .tab', (e) => e.length);
const tv = Date.now();
for (let i = 0; i < tabCount; i++) {
  await page.evaluate((k) => document.querySelectorAll('.center .tabs .tab')[k]?.click(), i);
  await page.waitForFunction(() => !document.querySelector('.chat .loading, .chat-loading'), { timeout: 20000 }).catch(() => {});
  await sleep(150);
}
const visitMs = Date.now() - tv;
await sleep(1500);
rows.push(await measure(`${sids.length} conversas, todas as abas visitadas (${visitMs} ms)`));

const cdp = await page.createCDPSession();
await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
await cdp.detach().catch(() => {});
await sleep(800);
rows.push(await measure('após coleta de lixo'));

fs.mkdirSync(path.resolve('test/shots/memoria'), { recursive: true });
fs.writeFileSync(
  path.resolve('test/shots/memoria/relatorio.json'),
  JSON.stringify({ when: new Date().toISOString(), host: HOST, N_REMOTE, N_LOCAL, ready: readyNote, turnTimes, rows }, null, 2),
);
await cleanupAll();
process.exit(0);
