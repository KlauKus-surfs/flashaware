import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration';

const { query, getOne } = await import('../db');
const { addAlert, addRiskState, createLocation } = await import('../queries');
const { default: publicAckRoutes } = await import('../publicAckRoutes');
const { generateAckToken, hashAckToken } = await import('../ackToken');

const PFX = '__ack-';
const POLY = 'POLYGON((28.0 -26.0, 28.001 -26.0, 28.001 -25.999, 28.0 -25.999, 28.0 -26.0))';
const PT = 'POINT(28.0005 -25.9995)';

let app: express.Express;
let dbAvailable = false;
let orgId: string;
let locId: string;
let stateId: number;

async function makeAlertWithToken(opts: {
  recipient: string;
  ttlMs?: number;
  alertType?: string;
}): Promise<{ id: number; token: string }> {
  // alertService stores sha256(token), not the plaintext (see ackToken.ts).
  // The test mirrors that contract so the public-ack lookups (which hash the
  // path param before SELECT) find the row.
  const token = generateAckToken();
  const expiry = new Date(Date.now() + (opts.ttlMs ?? 60_000)).toISOString();
  const id = await addAlert({
    location_id: locId,
    state_id: stateId,
    alert_type: opts.alertType ?? 'email',
    recipient: opts.recipient,
    sent_at: new Date().toISOString(),
    delivered_at: new Date().toISOString(),
    acknowledged_at: null,
    acknowledged_by: null,
    escalated: false,
    error: null,
    twilio_sid: null,
    ack_token: hashAckToken(token),
    ack_token_expires_at: expiry,
  });
  return { id, token };
}

beforeAll(async () => {
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch {
    console.warn('[publicAck] DB not available — skipping suite');
    return;
  }

  app = express();
  app.use(express.json());
  app.use(publicAckRoutes);

  const org = await getOne<{ id: string }>(
    `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`${PFX}Org`, `${PFX}org-${Date.now()}`],
  );
  orgId = org!.id;

  const loc = await createLocation({
    name: `${PFX}Loc-${Date.now()}`,
    site_type: 'mine',
    geom: POLY,
    centroid: PT,
    org_id: orgId,
    timezone: 'Africa/Johannesburg',
    stop_radius_km: 10,
    prepare_radius_km: 20,
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

  stateId = await addRiskState({
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
});

afterAll(async () => {
  if (!dbAvailable) return;
  // Order matters: alerts.state_id has no ON DELETE CASCADE, so we must
  // clear the test alerts before the organisations cascade reaches risk_states.
  await query(`DELETE FROM alerts WHERE recipient LIKE $1`, [`${PFX}%`]);
  await query(`DELETE FROM organisations WHERE slug LIKE $1`, [`${PFX}%`]);
});

describe('GET /api/ack/by-token/:token', () => {
  it('returns 404 for an unknown token', async () => {
    if (!dbAvailable) return;
    const res = await request(app).get('/api/ack/by-token/this-token-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invalid');
  });

  it('returns the alert metadata for a valid unacked token', async () => {
    if (!dbAvailable) return;
    const { token } = await makeAlertWithToken({ recipient: `${PFX}alice@example.com` });
    const res = await request(app).get(`/api/ack/by-token/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('STOP');
    expect(res.body.expired).toBe(false);
    expect(res.body.alreadyAckedAt).toBeNull();
    expect(res.body.recipient).toBe(`${PFX}alice@example.com`);
    expect(res.body.locationName).toMatch(new RegExp(`^${PFX}Loc-`));
    expect(res.body.reason).toBe('flashes nearby');
  });

  it('returns expired:true for a token whose expiry has passed', async () => {
    if (!dbAvailable) return;
    const { token } = await makeAlertWithToken({
      recipient: `${PFX}bob@example.com`,
      ttlMs: -1000,
    });
    const res = await request(app).get(`/api/ack/by-token/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.expired).toBe(true);
  });

  it('reports already-acked state if a parallel ack happened first', async () => {
    if (!dbAvailable) return;
    const { token, id } = await makeAlertWithToken({ recipient: `${PFX}carol@example.com` });
    await query(`UPDATE alerts SET acknowledged_at = NOW(), acknowledged_by = $1 WHERE id = $2`, [
      'operator@example.com',
      id,
    ]);
    const res = await request(app).get(`/api/ack/by-token/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.alreadyAckedAt).not.toBeNull();
    expect(res.body.alreadyAckedBy).toBe('operator@example.com');
  });
});

describe('POST /api/ack/by-token/:token', () => {
  it('returns 404 for an unknown token', async () => {
    if (!dbAvailable) return;
    const res = await request(app).post('/api/ack/by-token/never-ever-issued-this');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invalid');
  });

  it('returns 410 for an expired token', async () => {
    if (!dbAvailable) return;
    const { token } = await makeAlertWithToken({ recipient: `${PFX}d@example.com`, ttlMs: -1000 });
    const res = await request(app).post(`/api/ack/by-token/${token}`);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('expired');
  });

  it('acks every alert row sharing the same state_id (per-event scope)', async () => {
    if (!dbAvailable) return;
    // One state event, three deliveries (email + sms + whatsapp). The first
    // delivery's token is the one the user clicks.
    const a = await makeAlertWithToken({
      recipient: `${PFX}team-email@example.com`,
      alertType: 'email',
    });
    await makeAlertWithToken({ recipient: `${PFX}+27821111111`, alertType: 'sms' });
    await makeAlertWithToken({ recipient: `${PFX}+27822222222`, alertType: 'whatsapp' });

    const res = await request(app).post(`/api/ack/by-token/${a.token}`);
    expect(res.status).toBe(200);
    expect(res.body.acked).toBeGreaterThanOrEqual(3);

    const remaining = await getOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM alerts
       WHERE state_id = $1 AND acknowledged_at IS NULL AND recipient LIKE $2`,
      [stateId, `${PFX}%`],
    );
    expect(remaining!.n).toBe(0);
  });

  it('is idempotent — second click returns alreadyAcked', async () => {
    if (!dbAvailable) return;
    const { token } = await makeAlertWithToken({ recipient: `${PFX}repeat@example.com` });
    const r1 = await request(app).post(`/api/ack/by-token/${token}`);
    expect(r1.status).toBe(200);
    expect(r1.body.acked).toBeGreaterThanOrEqual(1);

    const r2 = await request(app).post(`/api/ack/by-token/${token}`);
    expect(r2.status).toBe(200);
    expect(r2.body.acked).toBe(0);
    expect(r2.body.alreadyAcked).toBe(true);
  });

  it('writes an audit row with actor_role = "recipient"', async () => {
    if (!dbAvailable) return;
    const { token } = await makeAlertWithToken({ recipient: `${PFX}audit-target@example.com` });
    await request(app).post(`/api/ack/by-token/${token}`);
    const r = await getOne<{
      actor_email: string;
      actor_role: string;
      action: string;
      target_id: string;
    }>(
      `SELECT actor_email, actor_role, action, target_id FROM audit_log
        WHERE actor_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [`recipient:${PFX}audit-target@example.com`],
    );
    expect(r).not.toBeNull();
    expect(r!.actor_role).toBe('recipient');
    expect(r!.action).toBe('alert.ack');
    expect(r!.target_id).toMatch(/^token:[A-Za-z0-9_-]{8}…$/);
  });

  it('GET on a valid token does not modify state', async () => {
    if (!dbAvailable) return;
    const { token, id } = await makeAlertWithToken({ recipient: `${PFX}readonly@example.com` });
    await request(app).get(`/api/ack/by-token/${token}`);
    const row = await getOne<{ acknowledged_at: string | null }>(
      `SELECT acknowledged_at FROM alerts WHERE id = $1`,
      [id],
    );
    expect(row!.acknowledged_at).toBeNull();
  });
});
