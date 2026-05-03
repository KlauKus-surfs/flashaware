import { Client } from 'pg';
import { createHash, randomBytes } from 'node:crypto';

// Mirrors server/ackToken.ts hashAckToken(). Kept as a local copy rather
// than imported because e2e/ is a separate npm workspace from server/ and
// doesn't have a direct path back into server source. If the algorithm
// in server changes, update both places.
function hashAckTokenForDb(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Direct DB seeding for E2E. The alternative — driving the API to create an
// org/location/alert — requires a logged-in admin and exercises a wider
// surface than the test cares about. Inserting rows is cleaner for what
// we're testing (the public /a/<token> ack flow).
//
// Returns the seeded ack_token so the spec can navigate to /a/<token>
// directly. The cleanup() helper removes everything it inserted.

// Build the same connection the server uses. Prefers DATABASE_URL when set
// (Fly's managed Postgres injects this) but falls back to the POSTGRES_*
// tuple — the dev/CI default — without target_session_attrs, which a
// single-instance Postgres rejects.
const DATABASE_URL =
  process.env.DATABASE_URL ??
  `postgres://${process.env.POSTGRES_USER ?? 'lightning'}:${process.env.POSTGRES_PASSWORD ?? 'lightning_dev'}` +
    `@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? '5432'}` +
    `/${process.env.POSTGRES_DB ?? 'lightning_risk'}`;

export interface SeededAlert {
  ackToken: string;
  alertId: number;
  cleanup: () => Promise<void>;
}

export async function seedAckableAlert(): Promise<SeededAlert> {
  const ackToken = randomBytes(24).toString('hex');
  const orgSlug = `e2e-${randomBytes(4).toString('hex')}`;

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // 1. Org
    const orgResult = await client.query(
      `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`E2E ${orgSlug}`, orgSlug],
    );
    const orgId = orgResult.rows[0].id as string;

    // 2. Location — minimal viable geometry (centroid + 1km buffer polygon).
    //    Using a fixed point near Johannesburg so the test data is plausible
    //    without conflicting with real production sites.
    const locationResult = await client.query(
      `INSERT INTO locations (
         org_id, name, site_type, geom, centroid, timezone,
         stop_radius_km, prepare_radius_km, stop_flash_threshold,
         stop_window_min, prepare_flash_threshold, prepare_window_min,
         allclear_wait_min
       ) VALUES (
         $1, $2, 'other',
         ST_Buffer(ST_SetSRID(ST_MakePoint(28.0, -26.2), 4326)::geography, 1000)::geometry,
         ST_SetSRID(ST_MakePoint(28.0, -26.2), 4326),
         'Africa/Johannesburg', 10, 20, 1, 15, 1, 15, 30
       ) RETURNING id`,
      [orgId, `E2E location ${orgSlug}`],
    );
    const locationId = locationResult.rows[0].id as string;

    // 3. Risk state — a STOP transition that the alert refers to.
    const stateResult = await client.query(
      `INSERT INTO risk_states (
         location_id, state, previous_state, changed_at, reason,
         flashes_in_stop_radius, flashes_in_prepare_radius, nearest_flash_km,
         data_age_sec, is_degraded, evaluated_at
       ) VALUES ($1, 'STOP', 'PREPARE', NOW(),
         '{"reason": "E2E seeded transition"}'::jsonb,
         3, 5, 4.2, 30, false, NOW())
       RETURNING id`,
      [locationId],
    );
    const stateId = stateResult.rows[0].id as number;

    // 4. Alert with the known ack_token. recipient='e2e@example.com' so the
    //    page renders a non-system row (system rows show different copy).
    //    Token expires 24h from now so the spec has plenty of slack.
    //    alerts.ack_token now stores sha256(plaintext) — see ackToken.ts.
    //    The spec navigates to /a/<plaintext>; the route hashes the path
    //    param before the SELECT, so the DB row must hold the hash.
    const alertResult = await client.query(
      `INSERT INTO alerts (
         location_id, state_id, alert_type, recipient,
         sent_at, delivered_at,
         acknowledged_at, acknowledged_by, escalated, error,
         twilio_sid, ack_token, ack_token_expires_at
       ) VALUES (
         $1, $2, 'email', 'e2e@example.com',
         NOW(), NOW(),
         NULL, NULL, false, NULL,
         NULL, $3, NOW() + INTERVAL '24 hours'
       ) RETURNING id`,
      [locationId, stateId, hashAckTokenForDb(ackToken)],
    );
    const alertId = alertResult.rows[0].id as number;

    return {
      ackToken,
      alertId,
      cleanup: async () => {
        const cleanupClient = new Client({ connectionString: DATABASE_URL });
        await cleanupClient.connect();
        try {
          // Cascade order: alerts → risk_states → location_recipients → locations → organisation
          await cleanupClient.query(`DELETE FROM alerts WHERE id = $1`, [alertId]);
          await cleanupClient.query(`DELETE FROM risk_states WHERE id = $1`, [stateId]);
          await cleanupClient.query(`DELETE FROM location_recipients WHERE location_id = $1`, [
            locationId,
          ]);
          await cleanupClient.query(`DELETE FROM locations WHERE id = $1`, [locationId]);
          await cleanupClient.query(`DELETE FROM organisations WHERE id = $1`, [orgId]);
        } finally {
          await cleanupClient.end();
        }
      },
    };
  } finally {
    await client.end();
  }
}
