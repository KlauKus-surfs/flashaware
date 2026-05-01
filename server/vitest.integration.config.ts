import { defineConfig } from 'vitest/config';

// Separate config for the integration suite. These tests need a running
// Postgres (docker compose up -d) and seed/teardown their own data. They are
// excluded from the default `npm test` run via vitest.config.ts so an
// engineer without a DB checked out can still get green unit tests.
export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    environment: 'node',
    // Integration setups can be slow on cold caches.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
    // One worker — the suite seeds shared rows and we don't want parallel
    // workers fighting over slug uniqueness or auditing each other's writes.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
