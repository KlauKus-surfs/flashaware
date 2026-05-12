import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// JWT_SECRET must be set before importing auth/queries so generateToken's
// module-load-time secret lookup picks it up.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration';

const { query, getOne } = await import('../db');
const { createUser, createLocation, addRiskState, addAlert } = await import('../queries');
const { generateToken } = await import('../auth');
const { default: statusRoutes } = await import('../statusRoutes');

// Tight, deterministic seed prefix so a failed run cleans up cleanly. Mirrors
// the prefix patterns in tenantIsolation/publicAck integration suites.
const PFX = '__replay-';
const POLY = 'POLYGON((28.0 -26.0, 28.001 -26.0, 28.001 -25.999, 28.0 -25.999, 28.0 -26.0))';
const CENTROID_LAT = -26.2;
const CENTROID_LNG = 28.0;
const CENTROID_PT = `POINT(${CENTROID_LNG} ${CENTROID_LAT})`;
// Mirrors the server-side cap in statusRoutes.ts. Kept in sync by convention;
// if the server constant changes, update this and the assertion below together.
const FLASH_LIMIT = 5000;

let app: express.Express;
let dbAvailable = false;
let orgId: string;
let locId: string;
let adminUser: { id: string; email: string; name: string; role: string; org_id: string };
let token: string;

// Helper: insert a flash a given distance/age relative to the location centroid.
// We seed (lat, lng) directly and let the SQL build the geometry — matches the
// pattern other tests use to avoid pulling in a separate flash-ingest helper.
async function insertFlash(opts: { lat: number; lng: number; minutesAgo: number }): Promise<void> {
  const wkt = `POINT(${opts.lng} ${opts.lat})`;
  await query(
    `INSERT INTO flash_events
       (flash_id, flash_time_utc, geom, latitude, longitude,
        radiance, duration_ms, filter_confidence, product_id)
     VALUES (nextval('flash_events_id_seq'),
             NOW() - ($1 || ' minutes')::interval,
             ST_GeomFromText($2, 4326), $3, $4,
             1.0, 1.0, 1.0, $5)`,
    [opts.minutesAgo.toString(), wkt, opts.lat, opts.lng, `${PFX}prod-${Date.now()}-${Math.random()}`],
  );
}

beforeAll(async () => {
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch (e) {
    console.warn(
      '[replay] DB not available — skipping integration suite:',
      (e as Error).message,
    );
    return;
  }

  app = express();
  app.use(express.json());
  app.use(statusRoutes);

  // Fresh org + admin so the route's authorization passes.
  const org = await getOne<{ id: string }>(
    `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`${PFX}Org`, `${PFX}org-${Date.now()}`],
  );
  orgId = org!.id;

  adminUser = await createUser({
    email: `${PFX}admin-${Date.now()}@example.com`,
    password: 'replay-admin-pw-1',
    name: 'Replay Admin',
    role: 'admin',
    org_id: orgId,
  });

  const loc = await createLocation({
    name: `${PFX}Loc-${Date.now()}`,
    site_type: 'mine',
    geom: POLY,
    centroid: CENTROID_PT,
    org_id: orgId,
    timezone: 'Africa/Johannesburg',
    stop_radius_km: 10,
    prepare_radius_km: 25,
    stop_flash_threshold: 1,
    stop_window_min: 15,
    prepare_flash_threshold: 1,
    prepare_window_min: 15,
    allclear_wait_min: 30,
    persistence_alert_min: 10,
    alert_on_change_only: false,
    is_demo: true,
  });
  locId = loc.id;

  token = generateToken(adminUser);

  // Clear out any flash rows tagged with this prefix from a prior aborted run.
  await query(`DELETE FROM flash_events WHERE product_id LIKE $1`, [`${PFX}%`]);
});

// Isolate cases: each test starts with no prefixed flash rows, so the bulk
// truncation test isn't perturbed by leftover seeds from the radius test.
afterEach(async () => {
  if (!dbAvailable) return;
  await query(`DELETE FROM flash_events WHERE product_id LIKE $1`, [`${PFX}%`]);
});

afterAll(async () => {
  if (!dbAvailable) return;
  // Order: flash_events references nothing — clean by prefix.
  await query(`DELETE FROM flash_events WHERE product_id LIKE $1`, [`${PFX}%`]);
  // Cascade from organisations cleans users, locations, risk_states.
  await query(`DELETE FROM organisations WHERE slug LIKE $1`, [`${PFX}%`]);
});

describe.skipIf(!dbAvailable)('GET /api/replay/:locationId — wide-area visibility', () => {
  it('returns flashes outside prepare_radius_km but within 200 km', async () => {
    // ~22 km north of the centroid — just outside stop_radius_km(10) but
    // inside prepare_radius_km(25).
    await insertFlash({ lat: -26.0, lng: 28.0, minutesAgo: 5 });
    // ~133 km north — far outside prepare_radius_km(25), well inside 200 km.
    await insertFlash({ lat: -25.0, lng: 28.0, minutesAgo: 5 });
    // ~470 km north — well beyond the 200 km wide-area ceiling. Must NOT
    // appear in the response. Anchors the upper bound of ST_DWithin.
    await insertFlash({ lat: -22.0, lng: 28.0, minutesAgo: 5 });

    const res = await request(app)
      .get(`/api/replay/${locId}?hours=1`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const distances = res.body.flashes.map((f: any) => Math.round(f.distance_km));
    // Critical assertion: the new endpoint returns the >25 km flash too.
    expect(distances.some((d: number) => d > 25 && d <= 200)).toBe(true);
    expect(distances.every((d: number) => d <= 200)).toBe(true);
    // The >200 km seed must be excluded — guards against radius regression.
    expect(res.body.flashes.every((f: any) => f.distance_km <= 200)).toBe(true);
    expect(res.body.flashes_truncated).toBe(false);
  });

  it('sets flashes_truncated when result exceeds 5000', async () => {
    // Use a bulk-insert path so this stays well under the suite's 30 s timeout.
    // generate_series scatters points in a small lat/lng grid near the centroid.
    // Seed FLASH_LIMIT + 1 rows so the server's `LIMIT FLASH_LIMIT+1` overflow
    // detector trips. afterEach has already wiped prefixed rows from prior
    // cases, so this test is self-sufficient — no reliance on leftover seeds.
    await query(
      `INSERT INTO flash_events
         (flash_id, flash_time_utc, geom, latitude, longitude,
          radiance, duration_ms, filter_confidence, product_id)
       SELECT s,
              NOW() - INTERVAL '10 minutes',
              ST_SetSRID(ST_MakePoint($1 + ((s / 100) * 0.001), $2 + ((s % 100) * 0.001)), 4326),
              ($2 + ((s % 100) * 0.001))::real,
              ($1 + ((s / 100) * 0.001))::real,
              1.0, 1.0, 1.0,
              $3 || '-' || s
       FROM generate_series(1, $4::int) AS s`,
      [CENTROID_LNG, CENTROID_LAT, `${PFX}bulk-${Date.now()}`, FLASH_LIMIT + 1],
    );

    const res = await request(app)
      .get(`/api/replay/${locId}?hours=1`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.flashes.length).toBe(FLASH_LIMIT);
    expect(res.body.flashes_truncated).toBe(true);
  });

  it('returns triggered_alerts array correlating with state transitions that dispatched alerts', async () => {
    // Seed a state transition and a matching alert so the join produces a row.
    const stateId = await addRiskState({
      location_id: locId,
      state: 'STOP',
      previous_state: 'ALL_CLEAR',
      changed_at: new Date().toISOString(),
      reason: { reason: 'flashes nearby', source: 'test' },
      flashes_in_stop_radius: 3,
      flashes_in_prepare_radius: 5,
      nearest_flash_km: 4.2,
      data_age_sec: 12,
      is_degraded: false,
      evaluated_at: new Date().toISOString(),
    });
    const alertId = await addAlert({
      location_id: locId,
      state_id: stateId,
      alert_type: 'email',
      recipient: `${PFX}t@example.com`,
      sent_at: new Date().toISOString(),
      delivered_at: null,
      acknowledged_at: null,
      acknowledged_by: null,
      escalated: false,
      error: null,
      twilio_sid: null,
    });

    const res = await request(app)
      .get(`/api/replay/${locId}?hours=1`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.triggered_alerts)).toBe(true);
    expect(res.body.triggered_alerts.length).toBeGreaterThan(0);
    // Validate the FK-driven join, not just the shape: the returned row must
    // refer to the exact alert + transition we seeded.
    const row = res.body.triggered_alerts.find((r: any) => Number(r.alert_id) === alertId);
    expect(row).toBeDefined();
    expect(Number(row.transition_id)).toBe(stateId);
  });
});
