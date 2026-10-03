import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'src/web',
  base: '/',
  plugins: [preact()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:47319', ws: true },
      '/api': 'http://127.0.0.1:47319',
      '/preview': 'http://127.0.0.1:47319',
    },
  },
});
