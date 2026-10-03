import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  plugins: [
    {
      name: 'sh-as-text',
      transform(code: string, id: string) {
        if (id.endsWith('.sh')) return { code: `export default ${JSON.stringify(code)};`, map: null };
        return undefined;
      },
    },
  ],
});
