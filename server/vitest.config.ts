import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests that need a running Postgres are tagged with
    // `.integration.test.ts` — excluded from the default unit run so
    // `npm test` is fast and safe in any environment. Run them explicitly
    // with `npm run test:integration`.
    exclude: ['tests/**/*.integration.test.ts', 'node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 30_000,
    globals: false,
  },
});
