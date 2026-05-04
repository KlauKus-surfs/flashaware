import { test, expect } from '@playwright/test';
import { seedTenantWithAdmin, SeededTenant } from './fixtures/seed';

// E2E for the authenticated dashboard surface. The ack-link spec covers the
// public mutating route; this spec covers the private side: login → dashboard
// renders the seeded location, and an unauthenticated visit to the dashboard
// redirects through the login page.
//
// We deliberately don't drive the full "create location → simulate flash →
// see STOP → ack" loop here — flash simulation requires either a mocked
// EUMETSAT download or a direct DB insert that races the engine's tick
// scheduler, both of which add more flake than confidence. Login + render is
// the smallest authenticated flow that catches the frequent regressions:
// JWT-issuance breakage, axios interceptor regressions, route-guard drift.

test.describe('login + dashboard', () => {
  let tenant: SeededTenant;

  test.beforeEach(async () => {
    tenant = await seedTenantWithAdmin();
  });

  test.afterEach(async () => {
    await tenant.cleanup();
  });

  test('admin can sign in and sees their seeded location on the dashboard', async ({ page }) => {
    // Start unauthenticated on the dashboard root. The SPA's wildcard route
    // resolves to LoginPage when there's no stored user.
    await page.goto('/');
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();

    // The MUI TextField labels become accessible names; getByLabel works.
    await page.getByLabel(/email/i).fill(tenant.adminEmail);
    await page.getByLabel(/password/i).fill(tenant.adminPassword);

    const loginResp = page.waitForResponse(
      (r) => /\/api\/auth\/login$/.test(r.url()) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /^sign in$/i }).click();
    const resp = await loginResp;
    expect(resp.ok(), 'login should succeed').toBe(true);

    // Dashboard mounts after login. The seeded location's name is the most
    // specific marker that we're looking at THIS tenant's view (vs any other
    // seed leaking through). Wait up to the default 5s for the status grid
    // to populate.
    await expect(page.getByText(tenant.locationName)).toBeVisible();
  });

  test('rejects invalid credentials with a visible error', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(tenant.adminEmail);
    // Garbage password — the server returns 401 and the SPA surfaces the
    // backend's error message in an Alert above the form.
    await page.getByLabel(/password/i).fill('definitely-not-the-right-password');
    await page.getByRole('button', { name: /^sign in$/i }).click();
    // Server returns 'Invalid email or password' — but we grep loosely so
    // future copy tweaks (e.g. masking to 'Sign-in failed') don't break this
    // test as long as the page is communicating failure.
    await expect(page.getByText(/invalid|incorrect|failed|wrong|denied/i).first()).toBeVisible();
    // And of course the dashboard never mounted.
    await expect(page.getByText(tenant.locationName)).not.toBeVisible();
  });

  test('unauthenticated visits to /audit redirect to login (no admin screen flicker)', async ({
    page,
  }) => {
    // Direct URL hit on a route that exists but requires auth. Without
    // a session, the SPA wildcard ultimately resolves to LoginPage —
    // not an empty AuditLog that 403-storms every API call.
    await page.goto('/audit');
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });
});
