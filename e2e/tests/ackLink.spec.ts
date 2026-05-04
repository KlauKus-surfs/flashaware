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
    await expect(page.getByText(/(delivery|deliveries) cleared at/i)).toBeVisible();
  });

  test('reloading after ack shows a terminal "link no longer active" state', async ({ page }) => {
    await page.goto(`/a/${seeded.ackToken}`);

    // AckPage flips the UI optimistically and POSTs in the background
    // (so flaky cell connections don't reward double-tapping). That means
    // "deliveries cleared at" can appear *before* the server has actually
    // acked. Wait for the real POST/response to land before reloading,
    // otherwise the next GET races against the unfinished ack.
    const responsePromise = page.waitForResponse(
      (r) => /\/api\/ack\/by-token\//.test(r.url()) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /acknowledge.*seen this/i }).click();
    await responsePromise;
    await expect(page.getByText(/(delivery|deliveries) cleared at/i)).toBeVisible();

    // Hard reload — the token is revoked on first ack (server clears the
    // ack_token column on the UPDATE), so the fresh GET resolves to a
    // terminal "link not active" panel rather than echoing back the alert
    // state. This is intentional: the GET endpoint used to be a passive
    // oracle for state/locationName/recipient even after ack, and revoking
    // the token closes that read surface as well as the replay surface.
    await page.goto(`/a/${seeded.ackToken}`);
    await expect(
      page.getByText(/no longer active|already.*used|not active|not.*found/i).first(),
    ).toBeVisible();
    // The actionable Acknowledge button must NOT be back, regardless of copy.
    await expect(page.getByRole('button', { name: /acknowledge.*seen this/i })).not.toBeVisible();
  });

  test('invalid token returns the not-found state', async ({ page }) => {
    await page.goto('/a/this-token-does-not-exist');
    // The "invalid" phase shows "Link not active" — see AckPage.tsx.
    // We grep loosely so a future copy tweak doesn't break the test, as
    // long as the page is communicating failure rather than rendering an
    // actionable Acknowledge button.
    await expect(
      page
        .getByText(/recognised|invalid|not.*found|not.*active|no longer active|expired|unknown/i)
        .first(),
    ).toBeVisible();
  });
});
