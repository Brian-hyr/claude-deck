import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/unit/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20000,
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
