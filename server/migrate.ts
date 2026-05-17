import { query } from './db';
import { logger } from './logger';

async function waitForDb(maxAttempts = 20, delayMs = 3000): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await query('SELECT 1');
      logger.info('Database connection established');
      return;
    } catch (err) {
      logger.warn(`DB not ready (attempt ${i}/${maxAttempts}), retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Database did not become available after maximum retries');
}

export async function runMigrations(): Promise<void> {
  logger.info('Running startup migrations...');
  await waitForDb();

  try {
    // Enable PostGIS extensions
    const tryExtension = async (sql: string) => {
      try {
        await query(sql);
      } catch (err: any) {
        if (err.code === '25006') {
          logger.warn(`Skipping extension (read-only, already installed): ${sql}`);
        } else {
          throw err;
        }
      }
    };
    await tryExtension(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await tryExtension(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // schema_migrations — version table. The current migrate.ts is one big
    // idempotent block, but new migrations from now on should register a row
    // here so a re-run doesn't re-execute heavy backfills. The presence of the
    // table itself signals "this DB is managed by migrate.ts, don't run the
    // legacy db/migrate_prod.sql script". apply_schema.js checks for it.
    await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    // Helper: run a one-shot migration only if its name isn't already recorded.
    // Use this for non-idempotent steps (data backfills, CHECK constraints with
    // backfill) instead of dropping them into the always-runs block below.
    const runOnce = async (name: string, fn: () => Promise<void>) => {
      const { rows } = await query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [name]);
      if (rows.length > 0) return;
      await fn();
      await query(`INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [
        name,
      ]);
      logger.info(`Applied one-shot migration: ${name}`);
    };
    // Reference it so the linter doesn't complain when there are no one-shots
    // pending. Future migrations call runOnce('20260601-foo', async () => {...}).

    // flash_events
    await query(`
    CREATE TABLE IF NOT EXISTS flash_events (
      id                  BIGSERIAL PRIMARY KEY,
      flash_id            INTEGER NOT NULL,
      flash_time_utc      TIMESTAMPTZ NOT NULL,
      geom                GEOMETRY(Point, 4326) NOT NULL,
      latitude            REAL NOT NULL,
      longitude           REAL NOT NULL,
      radiance            REAL,
      duration_ms         REAL,
      duration_clamped_ms REAL,
      footprint           REAL,
      num_groups          INTEGER,
      num_events          INTEGER,
      filter_confidence   REAL,
      is_truncated        BOOLEAN DEFAULT FALSE,
      product_id          TEXT NOT NULL,
      ingested_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_flash_time ON flash_events (flash_time_utc)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_flash_geom ON flash_events USING GIST (geom)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_flash_product ON flash_events (product_id)`);

    // locations
    await query(`
    CREATE TABLE IF NOT EXISTS locations (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name                    TEXT NOT NULL,
      site_type               TEXT NOT NULL CHECK (site_type IN ('mine','golf_course','construction','event','wind_farm','other')),
      geom                    GEOMETRY(Polygon, 4326) NOT NULL,
      centroid                GEOMETRY(Point, 4326) NOT NULL,
      timezone                TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
      stop_radius_km          REAL NOT NULL DEFAULT 10,
      prepare_radius_km       REAL NOT NULL DEFAULT 20,
      stop_flash_threshold    INTEGER NOT NULL DEFAULT 1,
      stop_window_min         INTEGER NOT NULL DEFAULT 15,
      prepare_flash_threshold INTEGER NOT NULL DEFAULT 1,
      prepare_window_min      INTEGER NOT NULL DEFAULT 15,
      allclear_wait_min       INTEGER NOT NULL DEFAULT 30,
      enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      updated_at              TIMESTAMPTZ DEFAULT NOW()
    )
  `);

    // risk_states
    await query(`
    CREATE TABLE IF NOT EXISTS risk_states (
      id                        BIGSERIAL PRIMARY KEY,
      location_id               UUID REFERENCES locations(id) ON DELETE CASCADE,
      state                     TEXT NOT NULL,
      previous_state            TEXT,
      changed_at                TIMESTAMPTZ DEFAULT NOW(),
      reason                    JSONB,
      flashes_in_stop_radius    INTEGER DEFAULT 0,
      flashes_in_prepare_radius INTEGER DEFAULT 0,
      nearest_flash_km          REAL,
      data_age_sec              INTEGER,
      is_degraded               BOOLEAN DEFAULT FALSE,
      evaluated_at              TIMESTAMPTZ DEFAULT NOW()
    )
  `);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_risk_location ON risk_states (location_id, evaluated_at DESC)`,
    );

    // alerts
    await query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id               BIGSERIAL PRIMARY KEY,
      location_id      UUID REFERENCES locations(id) ON DELETE CASCADE,
      state_id         BIGINT,
      alert_type       TEXT NOT NULL,
      recipient        TEXT NOT NULL DEFAULT 'system',
      sent_at          TIMESTAMPTZ DEFAULT NOW(),
      delivered_at     TIMESTAMPTZ,
      acknowledged_at  TIMESTAMPTZ,
      acknowledged_by  TEXT,
      escalated        BOOLEAN DEFAULT FALSE,
      error            TEXT
    )
  `);
    // Fix locations created with old bad defaults (stop_window_min=5, stop_flash_threshold=3)
    await query(`
    UPDATE locations
    SET stop_window_min = 15, stop_flash_threshold = 1
    WHERE stop_window_min = 5 AND stop_flash_threshold = 3
  `);

    // Migrate existing alerts table if it has the old schema
    await query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS state_id BIGINT`);
    await query(
      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS recipient TEXT NOT NULL DEFAULT 'system'`,
    );
    await query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`);
    await query(`ALTER TABLE alerts DROP COLUMN IF EXISTS state`);
    await query(`ALTER TABLE alerts DROP COLUMN IF EXISTS message`);
    await query(`ALTER TABLE alerts DROP COLUMN IF EXISTS acknowledged`);

    // ingestion_log
    await query(`
    CREATE TABLE IF NOT EXISTS ingestion_log (
      id                  BIGSERIAL PRIMARY KEY,
      product_id          TEXT NOT NULL UNIQUE,
      product_time_start  TIMESTAMPTZ,
      product_time_end    TIMESTAMPTZ,
      flash_count         INTEGER DEFAULT 0,
      ingested_at         TIMESTAMPTZ DEFAULT NOW(),
      qc_status           TEXT DEFAULT 'OK'
    )
  `);

    // organisations
    await query(`
    CREATE TABLE IF NOT EXISTS organisations (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT NOT NULL,
      slug       TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

    // invite_tokens
    await query(`
    CREATE TABLE IF NOT EXISTS invite_tokens (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token      TEXT UNIQUE NOT NULL,
      org_id     UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','operator','viewer')),
      email      TEXT,
      used_at    TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

    // users — column is password_hash since the 2026-05 rename. Existing
    // prod DBs created with the historic `password` column are migrated by
    // the runOnce step below ('20260502-users-password-rename'). The
    // CREATE TABLE IF NOT EXISTS path here only fires on a brand-new DB,
    // which gets the new name immediately.
    await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('super_admin','representative','admin','operator','viewer')),
      org_id        UUID REFERENCES organisations(id) ON DELETE CASCADE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

    // Add org_id to locations if not present
    await query(
      `ALTER TABLE locations ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id) ON DELETE CASCADE`,
    );

    // Add org_id to users if not present
    await query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id) ON DELETE CASCADE`,
    );

    // Widen role check on users to include super_admin and representative.
    // representative sits between admin and super_admin: cross-org reach
    // but no platform-shape actions (org create/delete, peer promotion,
    // platform settings, billing). See
    // docs/superpowers/specs/2026-05-11-roles-and-replay-visibility-design.md.
    await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await query(
      `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','representative','admin','operator','viewer'))`,
    );

    // location_recipients
    await query(`
    CREATE TABLE IF NOT EXISTS location_recipients (
      id               BIGSERIAL PRIMARY KEY,
      location_id      UUID REFERENCES locations(id) ON DELETE CASCADE,
      email            TEXT NOT NULL,
      phone            TEXT,
      active           BOOLEAN DEFAULT TRUE,
      notify_sms       BOOLEAN DEFAULT FALSE,
      notify_whatsapp  BOOLEAN DEFAULT FALSE
    )
  `);

    // Add notify columns to existing location_recipients tables
    await query(
      `ALTER TABLE location_recipients ADD COLUMN IF NOT EXISTS notify_sms BOOLEAN DEFAULT FALSE`,
    );
    await query(
      `ALTER TABLE location_recipients ADD COLUMN IF NOT EXISTS notify_whatsapp BOOLEAN DEFAULT FALSE`,
    );
    await query(
      `ALTER TABLE location_recipients ADD COLUMN IF NOT EXISTS notify_email BOOLEAN DEFAULT TRUE`,
    );

    // Add persistence re-alert interval to locations (how often to re-send while STOP/HOLD persists)
    await query(
      `ALTER TABLE locations ADD COLUMN IF NOT EXISTS persistence_alert_min INTEGER NOT NULL DEFAULT 10`,
    );

    // bootstrapped_at: durable cold-start marker. Replaces the implicit
    // `previousState === null` check in riskEngine.ts. Set on the first
    // evaluation that produces a risk_states row; subsequent evaluations
    // see a non-null bootstrapped_at and resume normal alert dispatch.
    // Pre-existing locations are backfilled from the earliest risk_states
    // row below so they aren't suddenly treated as "cold-start" again
    // after this migration runs.
    await query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS bootstrapped_at TIMESTAMPTZ`);
    await query(
      `UPDATE locations l
          SET bootstrapped_at = COALESCE(
            (SELECT MIN(rs.evaluated_at) FROM risk_states rs WHERE rs.location_id = l.id),
            NULL
          )
        WHERE bootstrapped_at IS NULL`,
    );

    // Alert mode: when true, only alert on state changes — no persistence re-alerts (e.g. wind farms)
    await query(
      `ALTER TABLE locations ADD COLUMN IF NOT EXISTS alert_on_change_only BOOLEAN NOT NULL DEFAULT FALSE`,
    );

    // Demo flag — when true, the location is hidden from the dashboard unless
    // the operator explicitly toggles "Show demo data" on. Risk engine still
    // evaluates demo locations (so test alerts still fire), but production
    // operators don't see them mixed in with real customer sites.
    await query(
      `ALTER TABLE locations ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE`,
    );

    // Widen site_type CHECK to include 'wind_farm'
    await query(`ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_site_type_check`);
    await query(
      `ALTER TABLE locations ADD CONSTRAINT locations_site_type_check CHECK (site_type IN ('mine','golf_course','construction','event','wind_farm','other'))`,
    );

    // Add twilio_sid to alerts for status callback correlation
    await query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS twilio_sid TEXT`);

    // app_settings — key/value store for global notification config
    await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
    await query(`
    INSERT INTO app_settings (key, value) VALUES
      ('email_enabled',        'true'),
      ('sms_enabled',          'false'),
      ('whatsapp_enabled',     'false'),
      ('escalation_enabled',   'true'),
      ('escalation_delay_min', '10'),
      ('alert_from_address',   'alerts@flashaware.io')
    ON CONFLICT (key) DO NOTHING
  `);

    // Seed default organisation
    await query(`
    INSERT INTO organisations (id, name, slug)
    VALUES ('00000000-0000-0000-0000-000000000001', 'FlashAware', 'flashaware')
    ON CONFLICT (slug) DO NOTHING
  `);

    // Demo super-admin seed — gated behind SEED_DEMO_ADMIN=true so production
    // can't accidentally re-introduce the well-known admin@flashaware.com /
    // admin123 credential by simply running a fresh migration. Two important
    // hardening changes from the previous seed:
    //   • DO NOTHING on conflict (no longer DO UPDATE) — running migrate
    //     against a tenant that has rotated the password used to overwrite
    //     `role` back to super_admin every boot, which would silently
    //     re-elevate a demoted account.
    //   • Only fires when the env flag is set, with a loud WARN log so a
    //     misconfigured prod deploy is visible instead of silent.
    if (process.env.SEED_DEMO_ADMIN === 'true') {
      // Hard refusal in production. Even with the BANNED_PASSWORDS rotation
      // gate, a known-username super-admin on a public host is a fail-open
      // posture: the gate only fires *after* a successful login, and the
      // attacker race for that login is wide open. Production must never
      // accidentally seed this account, regardless of which password the
      // operator picks.
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'SEED_DEMO_ADMIN=true is refused in production. Insert a real super-admin manually (see db/schema.sql).',
        );
      }
      // Require the operator to choose the password explicitly. The historic
      // `'admin123'` default made the seeded account redeemable without
      // looking at any env var; making the password mandatory removes that
      // shortcut and forces the well-known credential to come from a
      // deliberate config choice.
      const seedPassword = process.env.SEED_DEMO_ADMIN_PASSWORD;
      if (!seedPassword) {
        throw new Error(
          'SEED_DEMO_ADMIN=true requires SEED_DEMO_ADMIN_PASSWORD to be set explicitly (no default).',
        );
      }
      logger.warn(
        'SEED_DEMO_ADMIN=true — seeding demo super-admin (admin@flashaware.com / <env-supplied>). DEV ONLY.',
      );
      const bcrypt = (await import('bcrypt')).default;
      const seedHash = await bcrypt.hash(seedPassword, 12);
      await query(
        `INSERT INTO users (email, password_hash, name, role, org_id)
         VALUES ('admin@flashaware.com', $1, 'Admin', 'super_admin', '00000000-0000-0000-0000-000000000001')
         ON CONFLICT (email) DO NOTHING`,
        [seedHash],
      );
    }

    // Migrate existing users with no org_id into the default org
    await query(
      `UPDATE users SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL`,
    );

    // Migrate existing locations with no org_id into the default org
    await query(
      `UPDATE locations SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL`,
    );

    // Seed demo locations only when explicitly opted-in via SEED_DEMO_LOCATIONS=true
    // and the database has no locations at all yet. Avoids polluting the default
    // org with demo data after the platform has real customers.
    if (process.env.SEED_DEMO_LOCATIONS === 'true') {
      const { rows } = await query(`SELECT COUNT(*) AS c FROM locations`);
      if (parseInt(rows[0].c) === 0) {
        await query(`
        INSERT INTO locations (name, site_type, geom, centroid, org_id) VALUES
        ('Johannesburg CBD', 'construction',
          ST_GeomFromText('POLYGON((28.0373 -26.1941, 28.0573 -26.1941, 28.0573 -26.2141, 28.0373 -26.2141, 28.0373 -26.1941))', 4326),
          ST_SetSRID(ST_MakePoint(28.0473, -26.2041), 4326), '00000000-0000-0000-0000-000000000001'),
        ('Rustenburg Platinum Mine', 'mine',
          ST_GeomFromText('POLYGON((27.2300 -25.6467, 27.2700 -25.6467, 27.2700 -25.6867, 27.2300 -25.6867, 27.2300 -25.6467))', 4326),
          ST_SetSRID(ST_MakePoint(27.2500, -25.6667), 4326), '00000000-0000-0000-0000-000000000001'),
        ('Durban Beachfront', 'event',
          ST_GeomFromText('POLYGON((31.0118 -29.8487, 31.0318 -29.8487, 31.0318 -29.8687, 31.0118 -29.8687, 31.0118 -29.8487))', 4326),
          ST_SetSRID(ST_MakePoint(31.0218, -29.8587), 4326), '00000000-0000-0000-0000-000000000001'),
        ('Sun City Golf Course', 'golf_course',
          ST_GeomFromText('POLYGON((27.0828 -25.3246, 27.1028 -25.3246, 27.1028 -25.3446, 27.0828 -25.3446, 27.0828 -25.3246))', 4326),
          ST_SetSRID(ST_MakePoint(27.0928, -25.3346), 4326), '00000000-0000-0000-0000-000000000001')
      `);
        logger.info('Seeded demo locations (SEED_DEMO_LOCATIONS=true, fresh DB)');
      }
    }

    // Clean up orphaned records for locations that no longer exist
    const orphanAlerts = await query(
      `DELETE FROM alerts WHERE location_id NOT IN (SELECT id FROM locations)`,
    );
    const orphanStates = await query(
      `DELETE FROM risk_states WHERE location_id NOT IN (SELECT id FROM locations)`,
    );
    const orphanRecips = await query(
      `DELETE FROM location_recipients WHERE location_id NOT IN (SELECT id FROM locations)`,
    );
    const totalOrphans =
      (orphanAlerts.rowCount ?? 0) + (orphanStates.rowCount ?? 0) + (orphanRecips.rowCount ?? 0);
    if (totalOrphans > 0) {
      logger.info(
        `Cleaned up ${totalOrphans} orphaned records (alerts: ${orphanAlerts.rowCount}, risk_states: ${orphanStates.rowCount}, recipients: ${orphanRecips.rowCount})`,
      );
    }

    // ============================================================
    // Schema hardening (2026-04 review)
    // ============================================================

    // Make org_id non-null on locations now that all rows are backfilled.
    await query(`ALTER TABLE locations ALTER COLUMN org_id SET NOT NULL`);

    // Prevent two locations with the same name in the same org.
    // First: rename any existing collisions so the unique index can be created.
    await query(`
    WITH ranked AS (
      SELECT id, name, org_id,
             ROW_NUMBER() OVER (PARTITION BY org_id, name ORDER BY created_at) AS rn
      FROM locations
    )
    UPDATE locations l
    SET name = l.name || ' (duplicate ' || ranked.rn || ')'
    FROM ranked
    WHERE l.id = ranked.id AND ranked.rn > 1
  `);
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_org_name ON locations (org_id, name)`,
    );

    // Prevent ingesting the same flash twice from overlapping product batches.
    // (Note: ingester uses INSERT … ON CONFLICT DO NOTHING; this index is what
    // makes that conflict-target match.) De-duplicate any existing rows first.
    await query(`
    DELETE FROM flash_events a
    USING flash_events b
    WHERE a.id > b.id
      AND a.product_id = b.product_id
      AND a.flash_id   = b.flash_id
  `);
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_flash_events_product_flash ON flash_events (product_id, flash_id)`,
    );

    // Hot-path index used by escalation + recent-alerts queries.
    await query(
      `CREATE INDEX IF NOT EXISTS idx_alerts_location_sent ON alerts (location_id, sent_at DESC)`,
    );

    // Twilio status callbacks look up alerts by twilio_sid. Without this
    // index every webhook does a sequential scan on alerts — fine today,
    // expensive once the table accumulates months of dispatches. Partial
    // index excludes the system / email rows where twilio_sid is NULL.
    await query(
      `CREATE INDEX IF NOT EXISTS idx_alerts_twilio_sid
         ON alerts (twilio_sid) WHERE twilio_sid IS NOT NULL`,
    );

    // Operational queries like "how many locations are STOP right now?" filter
    // by state and time. Without this they scan the whole risk_states log
    // (which retention only trims at 30 days).
    await query(
      `CREATE INDEX IF NOT EXISTS idx_risk_states_state_time ON risk_states (state, evaluated_at DESC)`,
    );

    // Hot-path index for alert dispatch fan-out: dispatchAlerts() runs
    // SELECT ... FROM location_recipients WHERE location_id = $1 AND active = TRUE
    // on every state-change. With dozens of recipients per location and
    // thousands of locations across orgs, the absence of this index turns
    // every dispatch into a sequential scan. Partial index keeps it tight
    // because inactive rows are essentially never queried.
    await query(
      `CREATE INDEX IF NOT EXISTS idx_location_recipients_loc_active
         ON location_recipients (location_id) WHERE active = TRUE`,
    );

    // Safety-critical CHECK constraints on risk-decision columns. Without these,
    // a bad UPDATE that sets a threshold to 0 silently disarms a location (the
    // risk engine reads the value directly with no guard). Coerce any pre-existing
    // bad rows to defaults before applying the constraint.
    await query(
      `UPDATE locations SET stop_radius_km          = 10 WHERE stop_radius_km          IS NULL OR stop_radius_km          <= 0`,
    );
    await query(
      `UPDATE locations SET prepare_radius_km       = 20 WHERE prepare_radius_km       IS NULL OR prepare_radius_km       <= 0`,
    );
    await query(
      `UPDATE locations SET stop_flash_threshold    = 1  WHERE stop_flash_threshold    IS NULL OR stop_flash_threshold    <= 0`,
    );
    await query(
      `UPDATE locations SET stop_window_min         = 15 WHERE stop_window_min         IS NULL OR stop_window_min         <= 0`,
    );
    await query(
      `UPDATE locations SET prepare_flash_threshold = 1  WHERE prepare_flash_threshold IS NULL OR prepare_flash_threshold <= 0`,
    );
    await query(
      `UPDATE locations SET prepare_window_min      = 15 WHERE prepare_window_min      IS NULL OR prepare_window_min      <= 0`,
    );
    await query(
      `UPDATE locations SET allclear_wait_min       = 30 WHERE allclear_wait_min       IS NULL OR allclear_wait_min       <= 0`,
    );
    await query(
      `UPDATE locations SET persistence_alert_min   = 10 WHERE persistence_alert_min   IS NULL OR persistence_alert_min   <= 0`,
    );
    const riskCheckConstraints: Array<[string, string]> = [
      ['locations_stop_radius_positive', 'stop_radius_km > 0'],
      ['locations_prepare_radius_positive', 'prepare_radius_km > 0'],
      ['locations_stop_flash_threshold_positive', 'stop_flash_threshold > 0'],
      ['locations_stop_window_positive', 'stop_window_min > 0'],
      ['locations_prepare_flash_threshold_positive', 'prepare_flash_threshold > 0'],
      ['locations_prepare_window_positive', 'prepare_window_min > 0'],
      ['locations_allclear_wait_positive', 'allclear_wait_min > 0'],
      ['locations_persistence_alert_positive', 'persistence_alert_min > 0'],
    ];
    for (const [name, expr] of riskCheckConstraints) {
      // ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS isn't supported in PG16,
      // so emulate it with a name lookup.
      const { rows } = await query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
      if (rows.length === 0) {
        await query(`ALTER TABLE locations ADD CONSTRAINT ${name} CHECK (${expr})`);
      }
    }

    // Phone verification — recipients can be added with a phone but SMS/WhatsApp
    // dispatch is gated on phone_verified_at being set (via OTP confirmation).
    await query(
      `ALTER TABLE location_recipients ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ`,
    );

    // OTP storage for phone verification. Codes are short-lived; old rows are
    // purged by the retention job.
    await query(`
    CREATE TABLE IF NOT EXISTS recipient_phone_otps (
      id            BIGSERIAL PRIMARY KEY,
      recipient_id  BIGINT NOT NULL REFERENCES location_recipients(id) ON DELETE CASCADE,
      phone         TEXT NOT NULL,
      code_hash     TEXT NOT NULL,
      attempts      INTEGER NOT NULL DEFAULT 0,
      expires_at    TIMESTAMPTZ NOT NULL,
      verified_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_phone_otps_recipient ON recipient_phone_otps (recipient_id, expires_at DESC)`,
    );

    // Audit log — every mutation by every user, durable. Especially important
    // for super_admin actions across tenants; without this we can't answer "who
    // touched my data" for paying customers. before/after capture column-level
    // diffs as JSONB.
    await query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id             BIGSERIAL PRIMARY KEY,
      actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
      actor_email    TEXT NOT NULL,
      actor_role     TEXT NOT NULL,
      action         TEXT NOT NULL,
      target_type    TEXT NOT NULL,
      target_id      TEXT,
      target_org_id  UUID REFERENCES organisations(id) ON DELETE CASCADE,
      "before"       JSONB,
      "after"        JSONB,
      ip             TEXT,
      user_agent     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log (created_at DESC)`);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_audit_target_org ON audit_log (target_org_id, created_at DESC)`,
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_user_id, created_at DESC)`,
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, created_at DESC)`,
    );

    // Per-org settings — overrides app_settings (which becomes platform defaults).
    // Lookup falls back: org_settings → app_settings → null. Lets each tenant
    // configure their own escalation timing, sender address, etc.
    await query(`
    CREATE TABLE IF NOT EXISTS org_settings (
      org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (org_id, key)
    )
  `);

    // Soft-delete for organisations — gives a grace window before destructive
    // cascade. Hard-delete happens in the retention job after 30 days.
    await query(`ALTER TABLE organisations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_organisations_active ON organisations (deleted_at) WHERE deleted_at IS NULL`,
    );

    // Per-state alert preferences per recipient. Each recipient can opt in or
    // out of specific risk states (STOP / PREPARE / HOLD / ALL_CLEAR / DEGRADED)
    // for the location they're assigned to. Default = subscribed to all five.
    // Server-enforced in alertService.dispatchAlerts before each channel send.
    await query(`
    ALTER TABLE location_recipients
    ADD COLUMN IF NOT EXISTS notify_states JSONB
    NOT NULL DEFAULT '{"STOP":true,"PREPARE":true,"HOLD":true,"ALL_CLEAR":true,"DEGRADED":true}'::jsonb
  `);

    await runOnce('20260502-users-password-rename', async () => {
      // Rename users.password → users.password_hash. ALTER TABLE RENAME
      // COLUMN is metadata-only in PG, so it's instant and atomic — no
      // table lock beyond the millisecond catalog update. The IF EXISTS
      // guard handles the brand-new-DB case where the table was already
      // created with `password_hash` (because schema.sql / the updated
      // CREATE TABLE block above ran first).
      await query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'password'
          ) THEN
            ALTER TABLE users RENAME COLUMN password TO password_hash;
          END IF;
        END $$
      `);
    });

    await runOnce('20260502-alerts-ack-token', async () => {
      // Tokenised one-tap ack from email/SMS/WhatsApp messages. The token is
      // 24 random bytes (base64url), embedded in the message URL. Partial
      // unique index because legacy rows have NULL token and we only care
      // that LIVE tokens are unique.
      await query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ack_token TEXT`);
      await query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ack_token_expires_at TIMESTAMPTZ`);
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_ack_token
                 ON alerts (ack_token) WHERE ack_token IS NOT NULL`);
    });

    await runOnce('20260503-alerts-dispatch-idempotency', async () => {
      // Make alert dispatch idempotent across process restarts and dual-leader
      // races. Without this, a restart between the audit row insert and the
      // SMTP/Twilio send re-fires the same (location_id, state_id) pair on
      // recovery, paging recipients twice. With INSERT ... ON CONFLICT DO
      // NOTHING in alertService, the second attempt becomes a no-op.
      //
      // Partial index: only enforces uniqueness on rows that target an actual
      // delivery. The 'system' audit row (alert_type='system', recipient='system')
      // is intentionally allowed to repeat because its purpose is the per-tick
      // audit trail, not delivery dedup. Rows with NULL state_id (legacy) are
      // excluded too — the constraint only applies to the modern shape.
      //
      // Dedup pre-existing duplicate dispatches BEFORE creating the index —
      // otherwise the CREATE fails on production data shaped by the very bug
      // we're fixing. We keep the earliest row per (state_id, alert_type,
      // recipient) tuple (the "first attempt" record); later duplicates were
      // already redundant pages or retries and contribute no new audit value.
      const dedup = await query(`
        DELETE FROM alerts a
        USING alerts b
        WHERE a.id > b.id
          AND a.state_id IS NOT NULL
          AND a.state_id = b.state_id
          AND a.alert_type <> 'system'
          AND a.alert_type = b.alert_type
          AND a.recipient = b.recipient
      `);
      if ((dedup.rowCount ?? 0) > 0) {
        logger.info(
          `Removed ${dedup.rowCount} duplicate alert rows before creating uq_alerts_dispatch_idempotent`,
        );
      }
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_dispatch_idempotent
          ON alerts (state_id, alert_type, recipient)
         WHERE state_id IS NOT NULL
           AND alert_type <> 'system'
      `);
    });

    await runOnce('20260503-alerts-org-id-denorm', async () => {
      // Denormalise org_id onto alerts. Tenant scoping is currently enforced
      // by joining `alerts → locations → org_id` on every query; one missed
      // join is the single point of cross-tenant failure. Carrying org_id on
      // the row removes that risk and lets us index alerts directly by tenant
      // for hot dashboard queries.
      await query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS org_id UUID`);
      // Backfill from current location → org. Locations.org_id is NOT NULL
      // (enforced earlier in this file), so every alert with a still-extant
      // location gets a non-null org_id; orphans (which retention should have
      // deleted anyway) keep org_id=NULL.
      await query(`
        UPDATE alerts a
           SET org_id = l.org_id
          FROM locations l
         WHERE l.id = a.location_id
           AND a.org_id IS NULL
      `);
      // FK so a tenant hard-delete can still cascade through alerts.
      // ALTER TABLE ADD CONSTRAINT lacks IF NOT EXISTS in PG16, so emulate
      // it with a name lookup so the migration can be re-run safely if it
      // partially completed (the runOnce guard around this block is the
      // primary defence; this is belt-and-braces against an aborted run).
      const fkRows = await query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [
        'alerts_org_id_fkey',
      ]);
      if (fkRows.rows.length === 0) {
        await query(`
          ALTER TABLE alerts
          ADD CONSTRAINT alerts_org_id_fkey
          FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE
        `);
      }
      // Trigger: every new alert row inherits its location's org_id
      // automatically. Removes the "did the application remember to set
      // org_id?" footgun from every dispatch path.
      await query(`
        CREATE OR REPLACE FUNCTION alerts_set_org_id() RETURNS TRIGGER AS $$
        BEGIN
          IF NEW.org_id IS NULL AND NEW.location_id IS NOT NULL THEN
            SELECT org_id INTO NEW.org_id FROM locations WHERE id = NEW.location_id;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await query(`DROP TRIGGER IF EXISTS alerts_org_id_trg ON alerts`);
      await query(`
        CREATE TRIGGER alerts_org_id_trg
        BEFORE INSERT ON alerts
        FOR EACH ROW EXECUTE FUNCTION alerts_set_org_id();
      `);
      // Hot-path tenant-scoped read index.
      await query(`
        CREATE INDEX IF NOT EXISTS idx_alerts_org_sent
          ON alerts (org_id, sent_at DESC) WHERE org_id IS NOT NULL
      `);
    });

    await runOnce('20260504-alerts-state-id-on-delete-set-null', async () => {
      // alerts.state_id was created without an ON DELETE rule, defaulting to
      // NO ACTION. The retention transaction in index.ts deletes from
      // risk_states BEFORE alerts (same DATA_RETENTION_DAYS cutoff), so once
      // any production alerts row references a risk_states row at the
      // boundary, the risk_states DELETE FK-fails and rolls back the whole
      // retention transaction silently. Switch to SET NULL so retention can
      // proceed; the alerts row remains for audit, and getAlertByToken /
      // public-ack pages already tolerate state_id=NULL (they look up the
      // location and return state: null cleanly).
      //
      // We discover the existing constraint by referenced column rather than
      // by hard-coded name. Postgres auto-names FKs as <table>_<column>_fkey
      // by default, but a manually-applied schema or an older db/schema.sql
      // revision could use a different name; binding to the column makes the
      // migration idempotent regardless. Drop EVERY FK that references the
      // state_id column so we can't end up with two FK constraints (the old
      // NO ACTION one + the new SET NULL one) coexisting and deadlocking
      // each other at delete time.
      const existingFks = await query(
        `SELECT con.conname
           FROM pg_constraint con
           JOIN pg_class rel       ON rel.oid = con.conrelid
           JOIN pg_attribute att   ON att.attrelid = con.conrelid
                                  AND att.attnum = ANY(con.conkey)
          WHERE rel.relname = 'alerts'
            AND con.contype = 'f'
            AND att.attname = 'state_id'`,
      );
      for (const row of existingFks.rows as Array<{ conname: string }>) {
        await query(`ALTER TABLE alerts DROP CONSTRAINT "${row.conname}"`);
      }
      await query(`
        ALTER TABLE alerts
        ADD CONSTRAINT alerts_state_id_fkey
        FOREIGN KEY (state_id) REFERENCES risk_states(id) ON DELETE SET NULL
      `);
    });

    await runOnce('20260515-afa-pixels', async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS afa_pixels (
          id              BIGSERIAL PRIMARY KEY,
          product_id      TEXT NOT NULL,
          observed_at_utc TIMESTAMPTZ NOT NULL,
          pixel_lat       REAL NOT NULL,
          pixel_lon       REAL NOT NULL,
          geom            GEOMETRY(Polygon, 4326) NOT NULL,
          flash_count     INTEGER NOT NULL CHECK (flash_count > 0)
        )
      `);
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_afa_pixel
          ON afa_pixels (product_id, pixel_lat, pixel_lon)
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_afa_pixels_time ON afa_pixels (observed_at_utc)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_afa_pixels_geom ON afa_pixels USING GIST (geom)`);
    });

    await runOnce('20260515-location-afa-thresholds', async () => {
      await query(`
        ALTER TABLE locations
          ADD COLUMN IF NOT EXISTS stop_lit_pixels    INTEGER NOT NULL DEFAULT 1
            CHECK (stop_lit_pixels >= 1),
          ADD COLUMN IF NOT EXISTS stop_incidence     INTEGER NOT NULL DEFAULT 5
            CHECK (stop_incidence >= 1),
          ADD COLUMN IF NOT EXISTS prepare_lit_pixels INTEGER NOT NULL DEFAULT 1
            CHECK (prepare_lit_pixels >= 1),
          ADD COLUMN IF NOT EXISTS prepare_incidence  INTEGER NOT NULL DEFAULT 1
            CHECK (prepare_incidence >= 1)
      `);
    });

    await runOnce('20260516-password-reset-tokens', async () => {
      // Self-service password reset. The token table stores the SHA-256 hash
      // of the random token, never the token itself — the only place the
      // raw token exists outside the user's inbox is the bytes that briefly
      // pass through Express in the /reset request body. A DB read does
      // not give an attacker a usable reset link.
      //
      // ON DELETE CASCADE on user_id so deleting an account purges any
      // outstanding reset links (otherwise a re-created account with the
      // same UUID — possible via DB import — could inherit a live token).
      await query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          token_hash   TEXT UNIQUE NOT NULL,
          user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at   TIMESTAMPTZ NOT NULL,
          used_at      TIMESTAMPTZ,
          requested_ip TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Recent-tokens-per-user lookup for the per-account request throttle.
      await query(
        `CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
           ON password_reset_tokens (user_id, created_at DESC)`,
      );
      // Partial index for the "consume this active token" lookup. Used tokens
      // are dead weight in the lookup path; expired tokens fall out as time
      // passes and the periodic cleanup below removes them entirely.
      await query(
        `CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_active
           ON password_reset_tokens (expires_at) WHERE used_at IS NULL`,
      );
    });

    logger.info('Migrations complete');
  } catch (err: any) {
    if (err.code === '25006') {
      logger.warn('Database is read-only — skipping migrations (replica or read-only session)');
      return;
    }
    throw err;
  }
}
