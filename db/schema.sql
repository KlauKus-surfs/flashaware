-- FlashAware — Database Schema
-- Requires PostgreSQL 16+ with PostGIS 3.4+
--
-- This file mirrors the state produced by server/migrate.ts. The runtime
-- migration is the source of truth; this file exists for fresh-DB bootstrap
-- (db/apply_schema.js) and for reading the schema in one place. Keep them in
-- sync — if you add a column in migrate.ts, add it here too.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Organisations — top-level tenant
-- ============================================================
CREATE TABLE organisations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    slug       TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

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
    stop_radius_km          REAL NOT NULL DEFAULT 10,
    prepare_radius_km       REAL NOT NULL DEFAULT 20,
    stop_flash_threshold    INTEGER NOT NULL DEFAULT 1,
    stop_window_min         INTEGER NOT NULL DEFAULT 15,
    prepare_flash_threshold INTEGER NOT NULL DEFAULT 1,
    prepare_window_min      INTEGER NOT NULL DEFAULT 15,
    allclear_wait_min       INTEGER NOT NULL DEFAULT 30,
    persistence_alert_min   INTEGER NOT NULL DEFAULT 10,
    alert_on_change_only    BOOLEAN NOT NULL DEFAULT FALSE,
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

CREATE INDEX idx_risk_states_location ON risk_states (location_id, evaluated_at DESC);

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
    twilio_sid      TEXT
);

CREATE INDEX idx_alerts_location_sent ON alerts (location_id, sent_at DESC);

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
    phone_verified_at   TIMESTAMPTZ
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
-- App Settings — global key/value config
-- ============================================================
CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Seed: default organisation, super-admin user, and app settings.
-- The migration runner re-asserts these on every boot — kept here so a fresh
-- apply_schema.js bootstrap produces a usable installation.
-- ============================================================
INSERT INTO organisations (id, name, slug) VALUES
    ('00000000-0000-0000-0000-000000000001', 'FlashAware', 'flashaware')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO users (email, password, name, role, org_id) VALUES
    ('admin@flashaware.com', '$2b$10$cUIouPbQiNjTDN/qqOrV.uw0mIqQmoeiylGBs6.E1s8DS3AOZuqE.', 'Admin', 'super_admin', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (email) DO NOTHING;

INSERT INTO app_settings (key, value) VALUES
    ('email_enabled',        'true'),
    ('sms_enabled',          'false'),
    ('escalation_enabled',   'true'),
    ('escalation_delay_min', '10'),
    ('alert_from_address',   'alerts@flashaware.io')
ON CONFLICT (key) DO NOTHING;
