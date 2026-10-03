// Ponto de entrada do servidor do Claude Deck.
//   node dist/server.mjs [--port 47319] [--data-dir <pasta>] [--web-dir <pasta>]
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './config';
import { DeckServer } from './app';

// node:sqlite ainda emite aviso de "experimental" em algumas versões.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function alreadyRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(body.includes('claude-deck')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function main() {
  const port = Number(arg('port') ?? process.env.CLAUDE_DECK_PORT ?? 47319);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = arg('web-dir') ?? path.join(here, 'web');
  if (port && (await alreadyRunning(port))) {
    console.log(`Claude Deck já está rodando na porta ${port}.`);
    process.exit(0);
  }
  const server = new DeckServer({
    port,
    paths: resolvePaths(arg('data-dir')),
    webDir,
    quiet: process.argv.includes('--quiet'),
    skipVscodeImport: process.argv.includes('--no-import'),
  });
  await server.start();
  const shutdown = () => {
    server
      .stop()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (e) => server.log(`ERRO não tratado: ${e?.stack ?? e}`));
  process.on('unhandledRejection', (e: any) => server.log(`promessa rejeitada sem tratamento: ${e?.stack ?? e}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
