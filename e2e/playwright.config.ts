import { defineConfig, devices } from '@playwright/test';

// Playwright config. The base URL points at the running FlashAware API
// (which serves the SPA in production builds). Override with E2E_BASE_URL
// in CI or against a deployed environment.
//
// We deliberately don't spin up the server here via webServer{} — the CI
// workflow does that explicitly so it can also seed the DB and wait for
// /api/health/ready before tests run. Local dev: start the server yourself
// (`npm run dev:server` in another shell) then `npm test` here.

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  // Tests share a DB; running them in parallel against the same Postgres
  // would race on the seeded rows. Keep workers=1 until we add per-test
  // schema isolation.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
