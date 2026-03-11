-- Production migration: fix issues found during testing
-- Safe to run multiple times (idempotent)

-- 1. Drop the invalid composite GIST index if it exists
DROP INDEX IF EXISTS idx_flash_time_geom;

-- 2. Fix admin password hash (bcrypt of 'admin123')
UPDATE users 
SET password = '$2b$10$cUIouPbQiNjTDN/qqOrV.uw0mIqQmoeiylGBs6.E1s8DS3AOZuqE.'
WHERE email = 'admin@lightning.local'
  AND password != '$2b$10$cUIouPbQiNjTDN/qqOrV.uw0mIqQmoeiylGBs6.E1s8DS3AOZuqE.';

-- 3. Ensure ingestion_log has qc_status column (in case old schema is missing it)
ALTER TABLE ingestion_log ADD COLUMN IF NOT EXISTS qc_status TEXT DEFAULT 'OK';

-- 4. Ensure risk_states has all columns added in new schema
ALTER TABLE risk_states ADD COLUMN IF NOT EXISTS flashes_in_stop_radius INTEGER DEFAULT 0;
ALTER TABLE risk_states ADD COLUMN IF NOT EXISTS flashes_in_prepare_radius INTEGER DEFAULT 0;
ALTER TABLE risk_states ADD COLUMN IF NOT EXISTS nearest_flash_km REAL;
ALTER TABLE risk_states ADD COLUMN IF NOT EXISTS data_age_sec INTEGER;
ALTER TABLE risk_states ADD COLUMN IF NOT EXISTS is_degraded BOOLEAN DEFAULT FALSE;

-- 5. Ensure alerts table has escalated column
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalated BOOLEAN DEFAULT FALSE;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS error TEXT;

SELECT 'Migration complete' AS status;
