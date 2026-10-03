// Encerra o servidor do Claude Deck de forma limpa (grava o estado antes de sair).
// As conversas remotas continuam rodando nos servidores e o app reanexa quando voltar.
//   node launcher/stop-server.mjs [--port 47319] [--data-dir <pasta>]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('port') ?? process.env.CLAUDE_DECK_PORT ?? 47319);
const dataDir = arg('data-dir') ?? process.env.CLAUDE_DECK_DATA ?? path.join(process.env.APPDATA ?? '', 'claude-deck');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = () =>
  new Promise((res) =>
    http
      .get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => res(b.includes('claude-deck')));
      })
      .on('error', () => res(false))
      .on('timeout', function () {
        this.destroy();
        res(false);
      }),
  );

if (!(await health())) {
  console.log(`Claude Deck não está rodando na porta ${port}.`);
  process.exit(0);
}
const token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
const cookie = await new Promise((res, rej) =>
  http
    .get({ host: '127.0.0.1', port, path: `/auth?t=${token}` }, (r) => {
      r.resume();
      const c = r.headers['set-cookie']?.[0]?.split(';')[0];
      c ? res(c) : rej(new Error('token recusado'));
    })
    .on('error', rej),
);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: `http://127.0.0.1:${port}` } });
await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('O servidor não confirmou o encerramento.')), 5000);
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.id !== 1) return;
      clearTimeout(timer);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    });
    ws.send(JSON.stringify({ id: 1, method: 'app.quit', params: {} }));
  });
} catch (e) {
  ws.terminate();
  console.error(e.message);
  process.exit(1);
}
for (let i = 0; i < 50 && (await health()); i++) await sleep(200);
ws.terminate();
if (await health()) {
  console.log('O servidor não encerrou a tempo.');
  process.exit(1);
}
console.log('Claude Deck encerrado.');
process.exit(0);
