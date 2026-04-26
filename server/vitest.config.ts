import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests that need a running Postgres are tagged with
    // `.integration.test.ts` — run them explicitly with `npm test -- integration`.
    // The default `npm test` covers pure unit tests only, so it's fast and
    // safe to run in any environment.
    environment: 'node',
    testTimeout: 5000,
    globals: false,
  },
});
