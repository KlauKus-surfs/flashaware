import { test, expect, request } from '@playwright/test';
import { seedTenantWithAdmin, seedAlertForLocation, SeededTenant } from './fixtures/seed';

// Cross-tenant isolation through the live API. Server-side integration tests
// (server/tests/tenantIsolation.integration.test.ts) check this at the route
// handler level; this spec verifies the property end-to-end against a running
// server, including the auth middleware + scope helpers + queries.
//
// Two fresh tenants are seeded per test; tenant A's admin must NOT see
// tenant B's location through any of the tenant-scoped read endpoints.

async function loginViaApi(
  baseURL: string,
  email: string,
  password: string,
): Promise<{ token: string; orgId: string }> {
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post('/api/auth/login', { data: { email, password } });
  if (!res.ok()) {
    throw new Error(`login failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string; user: { org_id: string } };
  await ctx.dispose();
  return { token: body.token, orgId: body.user.org_id };
}

test.describe('tenant isolation', () => {
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  test.beforeEach(async () => {
    tenantA = await seedTenantWithAdmin();
    tenantB = await seedTenantWithAdmin();
  });

  test.afterEach(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  test("tenant A's admin cannot see tenant B's location via /api/locations", async ({
    baseURL,
  }) => {
    const { token, orgId } = await loginViaApi(baseURL!, tenantA.adminEmail, tenantA.adminPassword);
    expect(orgId).toBe(tenantA.orgId);

    const ctx = await request.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    const res = await ctx.get('/api/locations');
    expect(res.ok()).toBe(true);
    const rows = (await res.json()) as Array<{ id: string; name: string; org_id: string }>;
    await ctx.dispose();

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(tenantA.locationId);
    expect(ids).not.toContain(tenantB.locationId);
    // Defense in depth: any row that snuck through must at least belong to
    // tenant A (so a future bug that returns *all* rows but with the right
    // org_id stamping is still caught here).
    for (const r of rows) {
      expect(r.org_id).toBe(tenantA.orgId);
    }
  });

  test("tenant A's admin gets 404 (not 403/200) on tenant B's location id", async ({ baseURL }) => {
    const { token } = await loginViaApi(baseURL!, tenantA.adminEmail, tenantA.adminPassword);
    const ctx = await request.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    // PUT against tenant B's location id — should 404, not 200 (cross-tenant
    // write) and not 403 (existence oracle). The route uses
    // getLocationForUser() which returns null for cross-tenant rows.
    const res = await ctx.put(`/api/locations/${tenantB.locationId}`, {
      data: { enabled: false },
    });
    await ctx.dispose();
    expect(res.status()).toBe(404);
  });

  test("tenant A's admin cannot see tenant B's alerts via /api/alerts", async ({ baseURL }) => {
    // Seed an alert into tenant B. Tenant A must not see it via the alerts
    // listing — this exercises the alerts/locations/orgs join + the
    // resolveOrgScope helper, which is a different code path from the
    // /api/locations test above. A bug that strips the org_id WHERE clause
    // from the alerts query would silently leak STOP/PREPARE notifications
    // (and recipient PII) cross-tenant; that's worse than leaking a
    // location row, hence the dedicated test.
    const seeded = await seedAlertForLocation(tenantB.locationId);
    try {
      const { token } = await loginViaApi(baseURL!, tenantA.adminEmail, tenantA.adminPassword);
      const ctx = await request.newContext({
        baseURL,
        extraHTTPHeaders: { Authorization: `Bearer ${token}` },
      });
      const res = await ctx.get('/api/alerts');
      expect(res.ok()).toBe(true);
      const rows = (await res.json()) as Array<{
        id: number;
        location_id: string;
        recipient: string;
      }>;
      await ctx.dispose();

      // The seeded alert id MUST NOT appear. Belt-and-braces: nothing should
      // reference tenant B's location id, and the canary recipient string
      // shouldn't surface anywhere — even if a future bug returns rows with
      // their fields nulled, the canary would still be visible.
      expect(rows.map((r) => r.id)).not.toContain(seeded.alertId);
      expect(rows.map((r) => r.location_id)).not.toContain(tenantB.locationId);
      expect(rows.map((r) => r.recipient)).not.toContain('cross-tenant-leak-canary@e2e.local');
    } finally {
      await seeded.cleanup();
    }
  });
});
