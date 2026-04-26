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
      await new Promise(r => setTimeout(r, delayMs));
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
  await query(`CREATE INDEX IF NOT EXISTS idx_risk_location ON risk_states (location_id, evaluated_at DESC)`);

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
  await query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS recipient TEXT NOT NULL DEFAULT 'system'`);
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

  // users
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email      TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('super_admin','admin','operator','viewer')),
      org_id     UUID REFERENCES organisations(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add org_id to locations if not present
  await query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id) ON DELETE CASCADE`);

  // Add org_id to users if not present
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organisations(id) ON DELETE CASCADE`);

  // Widen role check on users to include super_admin
  await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
  await query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','operator','viewer'))`);

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
  await query(`ALTER TABLE location_recipients ADD COLUMN IF NOT EXISTS notify_sms BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE location_recipients ADD COLUMN IF NOT EXISTS notify_whatsapp BOOLEAN DEFAULT FALSE`);
  await query(`ALTER TABLE location_recipients ADD COLUMN IF NOT EXISTS notify_email BOOLEAN DEFAULT TRUE`);

  // Add persistence re-alert interval to locations (how often to re-send while STOP/HOLD persists)
  await query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS persistence_alert_min INTEGER NOT NULL DEFAULT 10`);

  // Alert mode: when true, only alert on state changes — no persistence re-alerts (e.g. wind farms)
  await query(`ALTER TABLE locations ADD COLUMN IF NOT EXISTS alert_on_change_only BOOLEAN NOT NULL DEFAULT FALSE`);

  // Widen site_type CHECK to include 'wind_farm'
  await query(`ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_site_type_check`);
  await query(`ALTER TABLE locations ADD CONSTRAINT locations_site_type_check CHECK (site_type IN ('mine','golf_course','construction','event','wind_farm','other'))`);

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

  // Seed super-admin user if not exists (password: admin123)
  await query(`
    INSERT INTO users (email, password, name, role, org_id)
    VALUES ('admin@flashaware.com', '$2b$10$cUIouPbQiNjTDN/qqOrV.uw0mIqQmoeiylGBs6.E1s8DS3AOZuqE.', 'Admin', 'super_admin', '00000000-0000-0000-0000-000000000001')
    ON CONFLICT (email) DO UPDATE SET role = 'super_admin', org_id = '00000000-0000-0000-0000-000000000001'
  `);

  // Migrate existing users with no org_id into the default org
  await query(`UPDATE users SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL`);

  // Migrate existing locations with no org_id into the default org
  await query(`UPDATE locations SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL`);

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
  const orphanAlerts = await query(`DELETE FROM alerts WHERE location_id NOT IN (SELECT id FROM locations)`);
  const orphanStates = await query(`DELETE FROM risk_states WHERE location_id NOT IN (SELECT id FROM locations)`);
  const orphanRecips = await query(`DELETE FROM location_recipients WHERE location_id NOT IN (SELECT id FROM locations)`);
  const totalOrphans = (orphanAlerts.rowCount ?? 0) + (orphanStates.rowCount ?? 0) + (orphanRecips.rowCount ?? 0);
  if (totalOrphans > 0) {
    logger.info(`Cleaned up ${totalOrphans} orphaned records (alerts: ${orphanAlerts.rowCount}, risk_states: ${orphanStates.rowCount}, recipients: ${orphanRecips.rowCount})`);
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
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_org_name ON locations (org_id, name)`);

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
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_flash_events_product_flash ON flash_events (product_id, flash_id)`);

  // Hot-path index used by escalation + recent-alerts queries.
  await query(`CREATE INDEX IF NOT EXISTS idx_alerts_location_sent ON alerts (location_id, sent_at DESC)`);

  // Phone verification — recipients can be added with a phone but SMS/WhatsApp
  // dispatch is gated on phone_verified_at being set (via OTP confirmation).
  await query(`ALTER TABLE location_recipients ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ`);

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
  await query(`CREATE INDEX IF NOT EXISTS idx_phone_otps_recipient ON recipient_phone_otps (recipient_id, expires_at DESC)`);

  logger.info('Migrations complete');

  } catch (err: any) {
    if (err.code === '25006') {
      logger.warn('Database is read-only — skipping migrations (replica or read-only session)');
      return;
    }
    throw err;
  }
}
