// Empacota o servidor (src/server) em dist/server.mjs com esbuild.
// As dependências ficam externas (lidas de node_modules em tempo de execução);
// o runner.sh remoto é embutido como texto.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/main.ts'],
  outfile: process.env.DECK_BUILD_SERVER_OUTFILE || 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  loader: { '.sh': 'text' },
  sourcemap: 'linked',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
