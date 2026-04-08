-- FlashAware — Database Schema
-- Requires PostgreSQL 16+ with PostGIS 3.4+

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Flash Events — individual lightning detections from LI-2-LFL
-- ============================================================
CREATE TABLE flash_events (
    id                  BIGSERIAL PRIMARY KEY,
    flash_id            INTEGER NOT NULL,
    flash_time_utc      TIMESTAMPTZ NOT NULL,
    geom                GEOMETRY(Point, 4326) NOT NULL,
    latitude            DOUBLE PRECISION NOT NULL,
    longitude           DOUBLE PRECISION NOT NULL,
    radiance            REAL,
    duration_ms         INTEGER,
    duration_clamped_ms INTEGER,
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

-- ============================================================
-- Locations — monitored sites with configurable thresholds
-- ============================================================
CREATE TABLE locations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    TEXT NOT NULL,
    site_type               TEXT NOT NULL CHECK (site_type IN ('mine','golf_course','construction','event','wind_farm','other')),
    geom                    GEOMETRY(Polygon, 4326) NOT NULL,
    centroid                GEOMETRY(Point, 4326) NOT NULL,
    timezone                TEXT DEFAULT 'Africa/Johannesburg',
    stop_radius_km          REAL DEFAULT 10.0,
    prepare_radius_km       REAL DEFAULT 20.0,
    stop_flash_threshold    INTEGER DEFAULT 3,
    stop_window_min         INTEGER DEFAULT 5,
    prepare_flash_threshold INTEGER DEFAULT 1,
    prepare_window_min      INTEGER DEFAULT 15,
    allclear_wait_min       INTEGER DEFAULT 30,
    enabled                 BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_locations_geom ON locations USING GIST (geom);
CREATE INDEX idx_locations_centroid ON locations USING GIST (centroid);

-- ============================================================
-- Risk States — immutable audit log of every evaluation
-- ============================================================
CREATE TABLE risk_states (
    id                      BIGSERIAL PRIMARY KEY,
    location_id             UUID REFERENCES locations(id) ON DELETE CASCADE,
    state                   TEXT NOT NULL CHECK (state IN ('ALL_CLEAR','PREPARE','STOP','HOLD','DEGRADED')),
    previous_state          TEXT,
    changed_at              TIMESTAMPTZ DEFAULT NOW(),
    reason                  JSONB NOT NULL,
    flashes_in_stop_radius  INTEGER,
    flashes_in_prepare_radius INTEGER,
    nearest_flash_km        REAL,
    data_age_sec            INTEGER,
    is_degraded             BOOLEAN DEFAULT FALSE,
    evaluated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_risk_states_location ON risk_states (location_id, evaluated_at DESC);

-- ============================================================
-- Alerts — notification delivery tracking
-- ============================================================
CREATE TABLE alerts (
    id              BIGSERIAL PRIMARY KEY,
    location_id     UUID REFERENCES locations(id) ON DELETE CASCADE,
    state_id        BIGINT REFERENCES risk_states(id),
    alert_type      TEXT NOT NULL CHECK (alert_type IN ('email','sms','push')),
    recipient       TEXT NOT NULL,
    sent_at         TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT,
    escalated       BOOLEAN DEFAULT FALSE,
    error           TEXT
);

CREATE INDEX idx_alerts_location ON alerts (location_id, sent_at DESC);

-- ============================================================
-- Ingestion Log — track every product processed
-- ============================================================
CREATE TABLE ingestion_log (
    id                  BIGSERIAL PRIMARY KEY,
    product_id          TEXT UNIQUE NOT NULL,
    product_time_start  TIMESTAMPTZ,
    product_time_end    TIMESTAMPTZ,
    flash_count         INTEGER,
    file_size_bytes     INTEGER,
    download_ms         INTEGER,
    parse_ms            INTEGER,
    ingested_at         TIMESTAMPTZ DEFAULT NOW(),
    qc_status           TEXT DEFAULT 'OK' CHECK (qc_status IN ('OK','HIGH_REJECTION','LOW_COUNT','STALE','ERROR')),
    trail_data          JSONB
);

-- ============================================================
-- Users — authentication & RBAC
-- ============================================================
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','operator','viewer')),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Notification Recipients per Location
-- ============================================================
CREATE TABLE location_recipients (
    id          BIGSERIAL PRIMARY KEY,
    location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    phone       TEXT,
    active      BOOLEAN DEFAULT TRUE
);

-- ============================================================
-- Seed: default admin user (password: admin123 — change in production!)
-- ============================================================
INSERT INTO users (email, password, name, role) VALUES
    ('admin@lightning.local', '$2b$10$cUIouPbQiNjTDN/qqOrV.uw0mIqQmoeiylGBs6.E1s8DS3AOZuqE.', 'Admin', 'admin');

-- ============================================================
-- Seed: demo locations for South Africa
-- ============================================================
INSERT INTO locations (name, site_type, geom, centroid) VALUES
    (
        'Johannesburg CBD',
        'construction',
        ST_GeomFromText('POLYGON((28.0373 -26.1941, 28.0573 -26.1941, 28.0573 -26.2141, 28.0373 -26.2141, 28.0373 -26.1941))', 4326),
        ST_SetSRID(ST_MakePoint(28.0473, -26.2041), 4326)
    ),
    (
        'Rustenburg Platinum Mine',
        'mine',
        ST_GeomFromText('POLYGON((27.2300 -25.6467, 27.2700 -25.6467, 27.2700 -25.6867, 27.2300 -25.6867, 27.2300 -25.6467))', 4326),
        ST_SetSRID(ST_MakePoint(27.2500, -25.6667), 4326)
    ),
    (
        'Durban Beachfront',
        'event',
        ST_GeomFromText('POLYGON((31.0118 -29.8487, 31.0318 -29.8487, 31.0318 -29.8687, 31.0118 -29.8687, 31.0118 -29.8487))', 4326),
        ST_SetSRID(ST_MakePoint(31.0218, -29.8587), 4326)
    ),
    (
        'Sun City Golf Course',
        'golf_course',
        ST_GeomFromText('POLYGON((27.0828 -25.3246, 27.1028 -25.3246, 27.1028 -25.3446, 27.0828 -25.3446, 27.0828 -25.3246))', 4326),
        ST_SetSRID(ST_MakePoint(27.0928, -25.3346), 4326)
    );
