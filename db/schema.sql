-- FlashAware — Database Schema (snapshot)
-- Requires PostgreSQL 16+ with PostGIS 3.4+
--
-- AUTHORITATIVE source of schema is server/migrate.ts. This file is a
-- read-friendly snapshot of what migrate.ts produces, used only by
-- db/apply_schema.js to bootstrap an empty database. New migrations belong
-- in migrate.ts (use the runOnce(name, fn) helper there for one-shot
-- backfills); this file should be regenerated/kept in sync afterward.
--
-- Do NOT add migration logic here — schema.sql runs once on a brand-new DB
-- and never again. Anything you put here that isn't reflected in migrate.ts
-- will simply not exist on every other deployment.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- schema_migrations — tracks one-shot migrations applied via migrate.ts.
-- The always-runs idempotent block at the top of migrate.ts doesn't insert
-- here; only runOnce(name, fn) entries do.
-- ============================================================
CREATE TABLE schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Organisations — top-level tenant. deleted_at gives a 30-day grace window
-- before the retention job hard-deletes (see server/migrate.ts retention).
-- ============================================================
CREATE TABLE organisations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    slug       TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_organisations_active ON organisations (deleted_at) WHERE deleted_at IS NULL;

-- ============================================================
-- Users — authentication & RBAC, scoped to an organisation
-- ============================================================
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('super_admin','admin','operator','viewer')),
    org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Invite Tokens — single-use signup links
-- ============================================================
CREATE TABLE invite_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token      TEXT UNIQUE NOT NULL,
    org_id     UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','operator','viewer')),
    email      TEXT,
    used_at    TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Locations — monitored sites with configurable thresholds
-- ============================================================
CREATE TABLE locations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name                    TEXT NOT NULL,
    site_type               TEXT NOT NULL CHECK (site_type IN ('mine','golf_course','construction','event','wind_farm','other')),
    geom                    GEOMETRY(Polygon, 4326) NOT NULL,
    centroid                GEOMETRY(Point, 4326) NOT NULL,
    timezone                TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
    -- Safety-critical: a value of 0 silently disarms the corresponding
    -- evaluation branch in riskEngine.decideRiskState. CHECK > 0 prevents a
    -- bad UPDATE from turning a location into a permanent ALL_CLEAR.
    stop_radius_km          REAL NOT NULL DEFAULT 10  CHECK (stop_radius_km > 0),
    prepare_radius_km       REAL NOT NULL DEFAULT 20  CHECK (prepare_radius_km > 0),
    stop_flash_threshold    INTEGER NOT NULL DEFAULT 1  CHECK (stop_flash_threshold > 0),
    stop_window_min         INTEGER NOT NULL DEFAULT 15 CHECK (stop_window_min > 0),
    prepare_flash_threshold INTEGER NOT NULL DEFAULT 1  CHECK (prepare_flash_threshold > 0),
    prepare_window_min      INTEGER NOT NULL DEFAULT 15 CHECK (prepare_window_min > 0),
    allclear_wait_min       INTEGER NOT NULL DEFAULT 30 CHECK (allclear_wait_min > 0),
    persistence_alert_min   INTEGER NOT NULL DEFAULT 10 CHECK (persistence_alert_min > 0),
    alert_on_change_only    BOOLEAN NOT NULL DEFAULT FALSE,
    is_demo                 BOOLEAN NOT NULL DEFAULT FALSE,
    enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_locations_geom ON locations USING GIST (geom);
CREATE INDEX idx_locations_centroid ON locations USING GIST (centroid);
CREATE UNIQUE INDEX uq_locations_org_name ON locations (org_id, name);

-- ============================================================
-- Flash Events — individual lightning detections from LI-2-LFL
-- ============================================================
CREATE TABLE flash_events (
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
);

CREATE INDEX idx_flash_time ON flash_events (flash_time_utc);
CREATE INDEX idx_flash_geom ON flash_events USING GIST (geom);
CREATE INDEX idx_flash_product ON flash_events (product_id);
-- Required for the ingester's ON CONFLICT DO NOTHING dedupe.
CREATE UNIQUE INDEX uq_flash_events_product_flash ON flash_events (product_id, flash_id);

-- ============================================================
-- Risk States — immutable audit log of every evaluation
-- ============================================================
CREATE TABLE risk_states (
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
);

CREATE INDEX idx_risk_states_location   ON risk_states (location_id, evaluated_at DESC);
-- Supports "how many locations are STOP right now?" without a full table scan.
CREATE INDEX idx_risk_states_state_time ON risk_states (state, evaluated_at DESC);

-- ============================================================
-- Alerts — notification delivery tracking
-- ============================================================
CREATE TABLE alerts (
    id              BIGSERIAL PRIMARY KEY,
    location_id     UUID REFERENCES locations(id) ON DELETE CASCADE,
    state_id        BIGINT REFERENCES risk_states(id),
    alert_type      TEXT NOT NULL,
    recipient       TEXT NOT NULL DEFAULT 'system',
    sent_at         TIMESTAMPTZ DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT,
    escalated       BOOLEAN DEFAULT FALSE,
    error           TEXT,
    twilio_sid      TEXT,
    ack_token            TEXT,
    ack_token_expires_at TIMESTAMPTZ
);

CREATE INDEX idx_alerts_location_sent ON alerts (location_id, sent_at DESC);
CREATE UNIQUE INDEX uq_alerts_ack_token ON alerts (ack_token) WHERE ack_token IS NOT NULL;

-- ============================================================
-- Ingestion Log — track every product processed
-- ============================================================
CREATE TABLE ingestion_log (
    id                  BIGSERIAL PRIMARY KEY,
    product_id          TEXT UNIQUE NOT NULL,
    product_time_start  TIMESTAMPTZ,
    product_time_end    TIMESTAMPTZ,
    flash_count         INTEGER DEFAULT 0,
    file_size_bytes     INTEGER,
    download_ms         INTEGER,
    parse_ms            INTEGER,
    ingested_at         TIMESTAMPTZ DEFAULT NOW(),
    qc_status           TEXT DEFAULT 'OK',
    trail_data          JSONB
);

-- ============================================================
-- Notification Recipients per Location
-- ============================================================
CREATE TABLE location_recipients (
    id                  BIGSERIAL PRIMARY KEY,
    location_id         UUID REFERENCES locations(id) ON DELETE CASCADE,
    email               TEXT NOT NULL,
    phone               TEXT,
    active              BOOLEAN DEFAULT TRUE,
    notify_email        BOOLEAN DEFAULT TRUE,
    notify_sms          BOOLEAN DEFAULT FALSE,
    notify_whatsapp     BOOLEAN DEFAULT FALSE,
    phone_verified_at   TIMESTAMPTZ,
    -- Per-state opt-in: which risk states (STOP/PREPARE/HOLD/ALL_CLEAR/DEGRADED)
    -- this recipient wants alerts for. Server-enforced in alertService.dispatchAlerts.
    notify_states       JSONB NOT NULL DEFAULT '{"STOP":true,"PREPARE":true,"HOLD":true,"ALL_CLEAR":true,"DEGRADED":true}'::jsonb
);

-- ============================================================
-- Phone OTPs — one-time codes for verifying recipient phone numbers
-- before SMS/WhatsApp dispatch is unlocked.
-- ============================================================
CREATE TABLE recipient_phone_otps (
    id            BIGSERIAL PRIMARY KEY,
    recipient_id  BIGINT NOT NULL REFERENCES location_recipients(id) ON DELETE CASCADE,
    phone         TEXT NOT NULL,
    code_hash     TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    expires_at    TIMESTAMPTZ NOT NULL,
    verified_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_phone_otps_recipient ON recipient_phone_otps (recipient_id, expires_at DESC);

-- ============================================================
-- App Settings — platform-wide defaults (FlashAware-level config). Per-org
-- overrides live in org_settings; lookup order is org_settings → app_settings.
-- ============================================================
CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Org Settings — per-tenant overrides of app_settings.
-- ============================================================
CREATE TABLE org_settings (
    org_id     UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (org_id, key)
);

-- ============================================================
-- Audit log — every mutation (creates/updates/deletes) by every user.
-- Reads are not logged. before/after are JSONB diffs.
-- ============================================================
CREATE TABLE audit_log (
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
);

CREATE INDEX idx_audit_created_at ON audit_log (created_at DESC);
CREATE INDEX idx_audit_target_org ON audit_log (target_org_id, created_at DESC);
CREATE INDEX idx_audit_actor      ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX idx_audit_action     ON audit_log (action, created_at DESC);

-- ============================================================
-- Seed: default organisation, super-admin user, and app settings.
-- The migration runner re-asserts these on every boot — kept here so a fresh
-- apply_schema.js bootstrap produces a usable installation.
-- ============================================================
INSERT INTO organisations (id, name, slug) VALUES
    ('00000000-0000-0000-0000-000000000001', 'FlashAware', 'flashaware')
ON CONFLICT (slug) DO NOTHING;

-- NOTE: We deliberately DO NOT seed a default admin user here. The previous
-- well-known credential (admin@flashaware.com / admin123) was a security
-- footgun for any fresh deploy. Use the runtime migration with
-- SEED_DEMO_ADMIN=true for local dev, or insert a real admin manually:
--
--   INSERT INTO users (email, password, name, role, org_id) VALUES
--     ('you@example.com',
--      crypt('STRONG_PASSWORD', gen_salt('bf', 10)),
--      'Your Name', 'super_admin',
--      '00000000-0000-0000-0000-000000000001');
--
-- (requires the pgcrypto extension already installed above).

INSERT INTO app_settings (key, value) VALUES
    ('email_enabled',        'true'),
    ('sms_enabled',          'false'),
    ('whatsapp_enabled',     'false'),
    ('escalation_enabled',   'true'),
    ('escalation_delay_min', '10'),
    ('alert_from_address',   'alerts@flashaware.io')
ON CONFLICT (key) DO NOTHING;
