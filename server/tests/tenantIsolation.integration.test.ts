import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// JWT_SECRET must be set before importing auth/queries.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration';

const { query, getOne } = await import('../db');
const {
  createUser,
  createLocation,
  getAllUsers,
  getAllLocations,
  getLocationById,
  getLocationsWithLatestState,
  addLocationRecipient,
  getLocationRecipients,
  getAllLocationsAdmin,
  addAlert,
} = await import('../queries');
const { canAccessLocation } = await import('../authScope');
const { getAuditRows, logAudit } = await import('../audit');

// Seed two distinct orgs (A and B) plus a fresh user in each role tier per org,
// then exercise the data-access helpers and the SQL patterns that production
// REST handlers rely on. The `__iso-…` slug/email prefix makes cleanup
// deterministic so a failed run never poisons subsequent ones.

const PFX = '__iso-';
const POLY = 'POLYGON((28.0 -26.0, 28.001 -26.0, 28.001 -25.999, 28.0 -25.999, 28.0 -26.0))';
const PT = 'POINT(28.0005 -25.9995)';

interface TestState {
  orgAId: string;
  orgBId: string;
  orgAAdminId: string;
  orgAOperatorId: string;
  orgAViewerId: string;
  orgBAdminId: string;
  orgBViewerId: string;
  superAdminId: string;
  // org A has two locations, one of them is the "shared name" with org B.
  locA1Id: string;
  locA2Id: string;
  locB1Id: string;
  // Pre-seeded alerts on a location in each org for the ack-isolation test.
  alertAId: number;
  alertBId: number;
}

let state: TestState | null = null;
let dbAvailable = false;

beforeAll(async () => {
  // If Postgres isn't reachable, skip the entire suite cleanly so this file
  // doesn't fail unexpectedly in environments without docker compose up.
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch (e) {
    console.warn(
      '[tenantIsolation] DB not available — skipping integration suite:',
      (e as Error).message,
    );
    return;
  }

  // Two fresh orgs.
  const orgA = await getOne<{ id: string }>(
    `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`${PFX}Org A`, `${PFX}org-a`],
  );
  const orgB = await getOne<{ id: string }>(
    `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`${PFX}Org B`, `${PFX}org-b`],
  );

  // One user per role tier. super_admin lives in org A but should still see
  // both orgs through the helpers.
  const orgAAdmin = await createUser({
    email: `${PFX}a-admin@example.com`,
    password: 'unique-admin-pw-1',
    name: 'Iso A Admin',
    role: 'admin',
    org_id: orgA!.id,
  });
  const orgAOperator = await createUser({
    email: `${PFX}a-op@example.com`,
    password: 'unique-operator-pw-1',
    name: 'Iso A Op',
    role: 'operator',
    org_id: orgA!.id,
  });
  const orgAViewer = await createUser({
    email: `${PFX}a-view@example.com`,
    password: 'unique-viewer-pw-1',
    name: 'Iso A Viewer',
    role: 'viewer',
    org_id: orgA!.id,
  });
  const orgBAdmin = await createUser({
    email: `${PFX}b-admin@example.com`,
    password: 'unique-admin-pw-2',
    name: 'Iso B Admin',
    role: 'admin',
    org_id: orgB!.id,
  });
  const orgBViewer = await createUser({
    email: `${PFX}b-view@example.com`,
    password: 'unique-viewer-pw-2',
    name: 'Iso B Viewer',
    role: 'viewer',
    org_id: orgB!.id,
  });
  const superAdmin = await createUser({
    email: `${PFX}super@example.com`,
    password: 'unique-super-pw-1',
    name: 'Iso Super',
    role: 'super_admin',
    org_id: orgA!.id,
  });

  // Two locations in org A, one in org B. The matching name in both orgs is
  // intentional — the (org_id, name) unique index allows it and we want to be
  // sure neither query returns the foreign-org row by accident.
  const locA1 = await createLocation({
    name: `${PFX}site-shared`,
    site_type: 'mine',
    geom: POLY,
    centroid: PT,
    org_id: orgA!.id,
  });
  const locA2 = await createLocation({
    name: `${PFX}site-a-only`,
    site_type: 'mine',
    geom: POLY,
    centroid: PT,
    org_id: orgA!.id,
  });
  const locB1 = await createLocation({
    name: `${PFX}site-shared`,
    site_type: 'mine',
    geom: POLY,
    centroid: PT,
    org_id: orgB!.id,
  });

  // One unacknowledged alert per org so we can exercise the ack-org-scoping
  // SQL pattern. addAlert needs a state_id, so seed a synthetic risk_state row
  // first; type/state values mirror the engine output.
  const stateA = await getOne<{ id: number }>(
    `INSERT INTO risk_states
       (location_id, state, evaluated_at, flashes_in_stop_radius, flashes_in_prepare_radius, data_age_sec, is_degraded)
     VALUES ($1, 'STOP', NOW(), 1, 1, 0, false) RETURNING id`,
    [locA1.id],
  );
  const stateB = await getOne<{ id: number }>(
    `INSERT INTO risk_states
       (location_id, state, evaluated_at, flashes_in_stop_radius, flashes_in_prepare_radius, data_age_sec, is_degraded)
     VALUES ($1, 'STOP', NOW(), 1, 1, 0, false) RETURNING id`,
    [locB1.id],
  );

  const alertA = await addAlert({
    location_id: locA1.id,
    state_id: stateA!.id,
    alert_type: 'email',
    recipient: `${PFX}rec-a-alert@example.com`,
    sent_at: new Date().toISOString(),
    delivered_at: null,
    error: null,
    escalated: false,
    acknowledged_at: null,
    acknowledged_by: null,
    twilio_sid: null,
  });
  const alertB = await addAlert({
    location_id: locB1.id,
    state_id: stateB!.id,
    alert_type: 'email',
    recipient: `${PFX}rec-b-alert@example.com`,
    sent_at: new Date().toISOString(),
    delivered_at: null,
    error: null,
    escalated: false,
    acknowledged_at: null,
    acknowledged_by: null,
    twilio_sid: null,
  });

  state = {
    orgAId: orgA!.id,
    orgBId: orgB!.id,
    orgAAdminId: orgAAdmin.id,
    orgAOperatorId: orgAOperator.id,
    orgAViewerId: orgAViewer.id,
    orgBAdminId: orgBAdmin.id,
    orgBViewerId: orgBViewer.id,
    superAdminId: superAdmin.id,
    locA1Id: locA1.id,
    locA2Id: locA2.id,
    locB1Id: locB1.id,
    alertAId: alertA,
    alertBId: alertB,
  };
});

afterAll(async () => {
  if (!dbAvailable || !state) return;
  // Cascade DELETE on organisations cleans up users, locations, risk_states,
  // alerts, recipients, invite_tokens, audit_log, org_settings.
  await query(`DELETE FROM organisations WHERE id = ANY($1::uuid[])`, [
    [state.orgAId, state.orgBId],
  ]);
  // Belt-and-braces: any audit rows we wrote with target_org_id = NULL won't be
  // covered by the cascade; clean those up by the actor email prefix.
  await query(`DELETE FROM audit_log WHERE actor_email LIKE $1`, [`${PFX}%`]);
});

describe.skipIf(!dbAvailable)('tenant isolation — data-access layer', () => {
  it('getAllUsers(orgA) excludes every org B user', async () => {
    const users = await getAllUsers(state!.orgAId);
    const ids = users.map((u) => u.id);
    expect(ids).toContain(state!.orgAAdminId);
    expect(ids).toContain(state!.orgAOperatorId);
    expect(ids).toContain(state!.orgAViewerId);
    expect(ids).not.toContain(state!.orgBAdminId);
    expect(ids).not.toContain(state!.orgBViewerId);
  });

  it('getAllUsers(orgB) excludes every org A user', async () => {
    const users = await getAllUsers(state!.orgBId);
    const ids = users.map((u) => u.id);
    expect(ids).toContain(state!.orgBAdminId);
    expect(ids).toContain(state!.orgBViewerId);
    expect(ids).not.toContain(state!.orgAAdminId);
    expect(ids).not.toContain(state!.orgAOperatorId);
    expect(ids).not.toContain(state!.orgAViewerId);
  });

  it('getAllLocationsAdmin(orgA) returns only org A locations', async () => {
    const locs = await getAllLocationsAdmin(state!.orgAId);
    const ids = locs.map((l) => l.id);
    expect(ids).toContain(state!.locA1Id);
    expect(ids).toContain(state!.locA2Id);
    expect(ids).not.toContain(state!.locB1Id);
  });

  it('getAllLocations(orgA) returns only org A locations', async () => {
    const locs = await getAllLocations(state!.orgAId);
    const ids = locs.map((l) => l.id);
    expect(ids).toContain(state!.locA1Id);
    expect(ids).toContain(state!.locA2Id);
    expect(ids).not.toContain(state!.locB1Id);
  });

  it('getLocationsWithLatestState(orgA) keeps shared-name location separate from org B', async () => {
    const locs = await getLocationsWithLatestState(state!.orgAId);
    const ids = new Set(locs.map((l) => l.id));
    expect(ids.has(state!.locA1Id)).toBe(true);
    expect(ids.has(state!.locA2Id)).toBe(true);
    expect(ids.has(state!.locB1Id)).toBe(false);
    // Every returned row's org_id matches the requested org.
    for (const l of locs) expect(l.org_id).toBe(state!.orgAId);
  });

  it('getLocationsWithLatestState(undefined) — super_admin cross-org view sees both', async () => {
    const locs = await getLocationsWithLatestState(undefined);
    const ids = new Set(locs.map((l) => l.id));
    expect(ids.has(state!.locA1Id)).toBe(true);
    expect(ids.has(state!.locB1Id)).toBe(true);
  });
});

describe.skipIf(!dbAvailable)(
  'tenant isolation — canAccessLocation predicate (route-level gate)',
  () => {
    it('an org A admin cannot access an org B location', async () => {
      const locB = await getLocationById(state!.locB1Id);
      expect(canAccessLocation(locB, { role: 'admin', org_id: state!.orgAId })).toBe(false);
    });

    it('an org B admin cannot access an org A location', async () => {
      const locA = await getLocationById(state!.locA1Id);
      expect(canAccessLocation(locA, { role: 'admin', org_id: state!.orgBId })).toBe(false);
    });

    it('an org A viewer can access their own location but not org B', async () => {
      const locA = await getLocationById(state!.locA1Id);
      const locB = await getLocationById(state!.locB1Id);
      expect(canAccessLocation(locA, { role: 'viewer', org_id: state!.orgAId })).toBe(true);
      expect(canAccessLocation(locB, { role: 'viewer', org_id: state!.orgAId })).toBe(false);
    });

    it('super_admin can access locations in any org', async () => {
      const locA = await getLocationById(state!.locA1Id);
      const locB = await getLocationById(state!.locB1Id);
      // super_admin's seeded org_id is orgA, but role=super_admin lets it cross.
      expect(canAccessLocation(locA, { role: 'super_admin', org_id: state!.orgAId })).toBe(true);
      expect(canAccessLocation(locB, { role: 'super_admin', org_id: state!.orgAId })).toBe(true);
    });
  },
);

describe.skipIf(!dbAvailable)(
  'tenant isolation — alert acknowledgement (POST /api/ack/:alertId pattern)',
  () => {
    // Mirrors the SQL the route handler runs after the security fix:
    //   non-super: UPDATE alerts a FROM locations l WHERE a.id=$1 AND a.location_id=l.id AND l.org_id=$2
    //   super_admin: UPDATE alerts WHERE id=$1
    it('an org A operator cannot ack an org B alert (rowCount = 0)', async () => {
      const r = await query(
        `UPDATE alerts a SET acknowledged_at = NOW(), acknowledged_by = $1
         FROM locations l
         WHERE a.id = $2 AND a.acknowledged_at IS NULL
           AND a.location_id = l.id AND l.org_id = $3
         RETURNING a.id`,
        ['attacker@example.com', state!.alertBId, state!.orgAId],
      );
      expect(r.rowCount ?? 0).toBe(0);

      const after = await getOne<{ acknowledged_at: string | null }>(
        'SELECT acknowledged_at FROM alerts WHERE id = $1',
        [state!.alertBId],
      );
      expect(after?.acknowledged_at).toBeNull();
    });

    it('an org A operator can ack their own org A alert (rowCount = 1)', async () => {
      const r = await query(
        `UPDATE alerts a SET acknowledged_at = NOW(), acknowledged_by = $1
         FROM locations l
         WHERE a.id = $2 AND a.acknowledged_at IS NULL
           AND a.location_id = l.id AND l.org_id = $3
         RETURNING a.id`,
        [`${PFX}a-op@example.com`, state!.alertAId, state!.orgAId],
      );
      expect(r.rowCount ?? 0).toBe(1);

      // Reset for any later assertions that re-test this path.
      await query(
        'UPDATE alerts SET acknowledged_at = NULL, acknowledged_by = NULL WHERE id = $1',
        [state!.alertAId],
      );
    });

    it('super_admin path acknowledges across orgs (rowCount = 1) — the wildcard branch', async () => {
      const r = await query(
        `UPDATE alerts SET acknowledged_at = NOW(), acknowledged_by = $1
         WHERE id = $2 AND acknowledged_at IS NULL
         RETURNING id`,
        [`${PFX}super@example.com`, state!.alertBId],
      );
      expect(r.rowCount ?? 0).toBe(1);

      // Reset.
      await query(
        'UPDATE alerts SET acknowledged_at = NULL, acknowledged_by = NULL WHERE id = $1',
        [state!.alertBId],
      );
    });
  },
);

describe.skipIf(!dbAvailable)(
  'tenant isolation — recipients are reachable only via the owning location',
  () => {
    it('addLocationRecipient + getLocationRecipients stay org-scoped', async () => {
      await addLocationRecipient({
        location_id: state!.locA1Id,
        email: `${PFX}rec-a@example.com`,
        phone: null,
        active: true,
        notify_email: true,
        notify_sms: false,
        notify_whatsapp: false,
      });
      await addLocationRecipient({
        location_id: state!.locB1Id,
        email: `${PFX}rec-b@example.com`,
        phone: null,
        active: true,
        notify_email: true,
        notify_sms: false,
        notify_whatsapp: false,
      });

      const a = await getLocationRecipients(state!.locA1Id);
      const b = await getLocationRecipients(state!.locB1Id);

      expect(a.some((r) => r.email === `${PFX}rec-a@example.com`)).toBe(true);
      expect(a.some((r) => r.email === `${PFX}rec-b@example.com`)).toBe(false);
      expect(b.some((r) => r.email === `${PFX}rec-b@example.com`)).toBe(true);
      expect(b.some((r) => r.email === `${PFX}rec-a@example.com`)).toBe(false);
    });
  },
);

describe.skipIf(!dbAvailable)('tenant isolation — audit log (GET /api/audit pattern)', () => {
  it("audit rows filtered by org_id never leak the other org's rows", async () => {
    await logAudit({
      actor: { id: state!.orgAAdminId, email: `${PFX}a-admin@example.com`, role: 'admin' },
      action: 'location.update',
      target_type: 'location',
      target_id: state!.locA1Id,
      target_org_id: state!.orgAId,
      after: { name: 'Iso A1 renamed' },
    });
    await logAudit({
      actor: { id: state!.orgBAdminId, email: `${PFX}b-admin@example.com`, role: 'admin' },
      action: 'location.update',
      target_type: 'location',
      target_id: state!.locB1Id,
      target_org_id: state!.orgBId,
      after: { name: 'Iso B1 renamed' },
    });

    const aRows = await getAuditRows({ org_id: state!.orgAId, target_type: 'location' });
    const bRows = await getAuditRows({ org_id: state!.orgBId, target_type: 'location' });

    expect(aRows.some((r) => r.target_id === state!.locA1Id)).toBe(true);
    expect(aRows.some((r) => r.target_id === state!.locB1Id)).toBe(false);
    expect(bRows.some((r) => r.target_id === state!.locB1Id)).toBe(true);
    expect(bRows.some((r) => r.target_id === state!.locA1Id)).toBe(false);
  });

  it('super_admin (no org filter) sees rows from both orgs', async () => {
    const all = await getAuditRows({ target_type: 'location' });
    const aRow = all.some((r) => r.target_id === state!.locA1Id);
    const bRow = all.some((r) => r.target_id === state!.locB1Id);
    expect(aRow).toBe(true);
    expect(bRow).toBe(true);
  });
});
