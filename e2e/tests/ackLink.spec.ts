import { test, expect } from '@playwright/test';
import { seedAckableAlert, SeededAlert } from './fixtures/seed';

// E2E for the public ack-link flow. This is the only public, unauthenticated
// route in the system that mutates state — the exact shape of thing that
// breaks subtly across deploys (URL pattern change, token format change,
// PII-scrub timing change). Server-side integration tests cover the route
// handlers in isolation; this exercises the full path including the SPA's
// AckPage.tsx render and the GET-then-POST sequence the page issues.

test.describe('ack-link flow', () => {
  let seeded: SeededAlert;

  test.beforeEach(async () => {
    seeded = await seedAckableAlert();
  });

  test.afterEach(async () => {
    await seeded.cleanup();
  });

  test('valid token renders the alert and the Acknowledge button submits', async ({ page }) => {
    await page.goto(`/a/${seeded.ackToken}`);

    // Phase 1: page loads and shows the actionable state.
    const ackButton = page.getByRole('button', { name: /acknowledge.*seen this/i });
    await expect(ackButton).toBeVisible();

    // Phase 2: clicking acknowledges. The button label flips and the
    // confirmation card appears.
    await ackButton.click();
    await expect(page.getByText(/acknowledged/i).first()).toBeVisible();
    // The "deliveries cleared at" copy is the canonical post-ack signal.
    await expect(page.getByText(/deliveries? cleared at/i)).toBeVisible();
  });

  test('reloading after ack shows the already-acknowledged state', async ({ page }) => {
    await page.goto(`/a/${seeded.ackToken}`);
    await page.getByRole('button', { name: /acknowledge.*seen this/i }).click();
    await expect(page.getByText(/deliveries? cleared at/i)).toBeVisible();

    // Hard reload — the fresh GET should now resolve to the
    // already-acknowledged branch.
    await page.goto(`/a/${seeded.ackToken}`);
    await expect(page.getByText(/already acknowledged/i)).toBeVisible();
  });

  test('invalid token returns the not-found state', async ({ page }) => {
    await page.goto('/a/this-token-does-not-exist');
    // The "invalid" phase shows "Link not recognised" — see AckPage.tsx.
    // We grep loosely so a future copy tweak ("not found", "unknown",
    // "expired" if expiry collapses both) doesn't break the test, as long
    // as the page is communicating failure rather than rendering an
    // actionable Acknowledge button.
    await expect(
      page.getByText(/recognised|invalid|not.*found|expired|unknown/i).first(),
    ).toBeVisible();
  });
});
