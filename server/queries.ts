import { pool, query, getOne, getMany } from './db';
import bcrypt from 'bcrypt';
import { DateTime } from 'luxon';

// ============================================================
// User queries
// ============================================================

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'super_admin' | 'admin' | 'operator' | 'viewer';
  org_id: string;
  created_at: string;
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  return getOne<UserRecord>('SELECT id, email, password AS password_hash, name, role, org_id, created_at FROM users WHERE email = $1', [email]);
}

export async function createUser(userData: {
  email: string;
  password: string;
  name: string;
  role: 'super_admin' | 'admin' | 'operator' | 'viewer';
  org_id: string;
}): Promise<UserRecord> {
  const passwordHash = await bcrypt.hash(userData.password, 10);
  const result = await getOne<UserRecord>(
    `INSERT INTO users (email, password, name, role, org_id) 
     VALUES ($1, $2, $3, $4, $5) 
     RETURNING id, email, password AS password_hash, name, role, org_id, created_at`,
    [userData.email, passwordHash, userData.name, userData.role, userData.org_id]
  );
  if (!result) throw new Error('Failed to create user');
  return result;
}

export async function updateUser(id: string, updates: Partial<{
  email: string;
  name: string;
  role: 'super_admin' | 'admin' | 'operator' | 'viewer';
  password: string;
}>): Promise<UserRecord | null> {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  if (updates.email) {
    fields.push(`email = $${paramIndex++}`);
    values.push(updates.email);
  }
  if (updates.name) {
    fields.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.role) {
    fields.push(`role = $${paramIndex++}`);
    values.push(updates.role);
  }
  if (updates.password) {
    fields.push(`password = $${paramIndex++}`);
    values.push(updates.password);
  }

  if (fields.length === 0) return null;

  values.push(id);
  const result = await getOne<UserRecord>(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result;
}

export async function deleteUser(id: string): Promise<boolean> {
  const result = await query('DELETE FROM users WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function getAllUsers(orgId: string): Promise<UserRecord[]> {
  return getMany<UserRecord>(
    'SELECT id, email, password AS password_hash, name, role, org_id, created_at FROM users WHERE org_id = $1 ORDER BY created_at DESC',
    [orgId]
  );
}

// ============================================================
// Location queries
// ============================================================

export interface LocationRecord {
  id: string;
  name: string;
  site_type: string;
  geom: string; // PostGIS geometry
  centroid: string; // PostGIS geometry
  timezone: string;
  stop_radius_km: number;
  prepare_radius_km: number;
  stop_flash_threshold: number;
  stop_window_min: number;
  prepare_flash_threshold: number;
  prepare_window_min: number;
  allclear_wait_min: number;
  persistence_alert_min: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function getAllLocations(orgId?: string): Promise<LocationRecord[]> {
  if (orgId) {
    return getMany<LocationRecord>(
      `SELECT id, name, site_type, ST_AsText(geom) AS geom, ST_AsText(centroid) AS centroid,
       timezone, stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
       prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, enabled, created_at, updated_at
       FROM locations WHERE enabled = true AND org_id = $1 ORDER BY name`,
      [orgId]
    );
  }
  return getMany<LocationRecord>(
    `SELECT id, name, site_type, ST_AsText(geom) AS geom, ST_AsText(centroid) AS centroid,
     timezone, stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
     prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, enabled, created_at, updated_at
     FROM locations WHERE enabled = true ORDER BY name`
  );
}

export async function getAllLocationsAdmin(orgId: string): Promise<LocationRecord[]> {
  return getMany<LocationRecord>(
    `SELECT id, name, site_type, ST_AsText(geom) AS geom, ST_AsText(centroid) AS centroid,
     timezone, stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
     prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, enabled, created_at, updated_at
     FROM locations WHERE org_id = $1 ORDER BY name`,
    [orgId]
  );
}

export async function getLocationById(id: string): Promise<LocationRecord | null> {
  return getOne<LocationRecord>(
    `SELECT id, name, site_type, ST_AsText(geom) AS geom, ST_AsText(centroid) AS centroid,
     timezone, stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
     prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, enabled, created_at, updated_at
     FROM locations WHERE id = $1`,
    [id]
  );
}

export async function createLocation(locationData: {
  name: string;
  site_type: string;
  geom: string;
  centroid: string;
  org_id: string;
  timezone?: string;
  stop_radius_km?: number;
  prepare_radius_km?: number;
  stop_flash_threshold?: number;
  stop_window_min?: number;
  prepare_flash_threshold?: number;
  prepare_window_min?: number;
  allclear_wait_min?: number;
  persistence_alert_min?: number;
}): Promise<LocationRecord> {
  const result = await getOne<LocationRecord>(
    `INSERT INTO locations (
      name, site_type, geom, centroid, timezone,
      stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
      prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, org_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [
      locationData.name,
      locationData.site_type,
      locationData.geom,
      locationData.centroid,
      locationData.timezone || 'Africa/Johannesburg',
      locationData.stop_radius_km || 10,
      locationData.prepare_radius_km || 20,
      locationData.stop_flash_threshold || 1,
      locationData.stop_window_min || 15,
      locationData.prepare_flash_threshold || 1,
      locationData.prepare_window_min || 15,
      locationData.allclear_wait_min || 30,
      locationData.persistence_alert_min ?? 10,
      locationData.org_id,
    ]
  );
  if (!result) throw new Error('Failed to create location');
  return result;
}

export async function deleteLocation(id: string): Promise<boolean> {
  const result = await query(`DELETE FROM locations WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function updateLocation(id: string, updates: Partial<{
  name: string;
  site_type: string;
  geom: string;
  centroid: string;
  timezone: string;
  stop_radius_km: number;
  prepare_radius_km: number;
  stop_flash_threshold: number;
  stop_window_min: number;
  prepare_flash_threshold: number;
  prepare_window_min: number;
  allclear_wait_min: number;
  persistence_alert_min: number;
  enabled: boolean;
}>): Promise<LocationRecord | null> {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  // Add all updatable fields
  const updateableFields = [
    'name', 'site_type', 'geom', 'centroid', 'timezone',
    'stop_radius_km', 'prepare_radius_km', 'stop_flash_threshold',
    'stop_window_min', 'prepare_flash_threshold', 'prepare_window_min',
    'allclear_wait_min', 'persistence_alert_min', 'enabled'
  ] as const;

  for (const field of updateableFields) {
    if (field in updates) {
      fields.push(`${field} = $${paramIndex++}`);
      values.push((updates as any)[field]);
    }
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await getOne<LocationRecord>(
    `UPDATE locations SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result;
}

// ============================================================
// Risk State queries
// ============================================================

export interface RiskStateRecord {
  id: number;
  location_id: string;
  state: string;
  previous_state: string | null;
  changed_at: string;
  reason: any;
  flashes_in_stop_radius: number;
  flashes_in_prepare_radius: number;
  nearest_flash_km: number | null;
  data_age_sec: number;
  is_degraded: boolean;
  evaluated_at: string;
}

export async function addRiskState(record: Omit<RiskStateRecord, 'id'>): Promise<number> {
  const result = await getOne<{ id: number }>(
    `INSERT INTO risk_states (
      location_id, state, previous_state, changed_at, reason,
      flashes_in_stop_radius, flashes_in_prepare_radius, nearest_flash_km,
      data_age_sec, is_degraded, evaluated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      record.location_id,
      record.state,
      record.previous_state,
      record.changed_at,
      JSON.stringify(record.reason),
      record.flashes_in_stop_radius,
      record.flashes_in_prepare_radius,
      record.nearest_flash_km,
      record.data_age_sec,
      record.is_degraded,
      record.evaluated_at,
    ]
  );
  if (!result) throw new Error('Failed to add risk state');
  return result.id;
}

export async function getLatestRiskState(locationId: string): Promise<RiskStateRecord | null> {
  return getOne<RiskStateRecord>(
    'SELECT * FROM risk_states WHERE location_id = $1 ORDER BY evaluated_at DESC LIMIT 1',
    [locationId]
  );
}

export async function getLastNonDegradedState(locationId: string): Promise<'ALL_CLEAR' | 'PREPARE' | 'STOP' | 'HOLD' | null> {
  const row = await getOne<{ state: string }>(
    `SELECT state FROM risk_states
     WHERE location_id = $1 AND state != 'DEGRADED'
     ORDER BY evaluated_at DESC LIMIT 1`,
    [locationId]
  );
  return (row?.state as 'ALL_CLEAR' | 'PREPARE' | 'STOP' | 'HOLD') ?? null;
}

export async function getRecentRiskStates(locationId: string, limit: number = 50): Promise<RiskStateRecord[]> {
  return getMany<RiskStateRecord>(
    'SELECT * FROM risk_states WHERE location_id = $1 ORDER BY evaluated_at DESC LIMIT $2',
    [locationId, limit]
  );
}

export async function getAllRiskStates(hours: number = 2): Promise<RiskStateRecord[]> {
  return getMany<RiskStateRecord>(
    `SELECT * FROM risk_states 
     WHERE evaluated_at >= NOW() - interval '${hours} hours' 
     ORDER BY evaluated_at DESC`
  );
}

// ============================================================
// Alert queries
// ============================================================

export interface AlertRecord {
  id: number;
  location_id: string;
  state_id: number;
  alert_type: string;
  recipient: string;
  sent_at: string | null;
  delivered_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  escalated: boolean;
  error: string | null;
  twilio_sid: string | null;
}

export async function addAlert(record: Omit<AlertRecord, 'id'>): Promise<number> {
  const result = await getOne<{ id: number }>(
    `INSERT INTO alerts (
      location_id, state_id, alert_type, recipient, sent_at, delivered_at,
      acknowledged_at, acknowledged_by, escalated, error, twilio_sid
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      record.location_id,
      record.state_id,
      record.alert_type,
      record.recipient,
      record.sent_at,
      record.delivered_at,
      record.acknowledged_at,
      record.acknowledged_by,
      record.escalated,
      record.error,
      record.twilio_sid ?? null,
    ]
  );
  if (!result) throw new Error('Failed to add alert');
  return result.id;
}

export async function updateAlertStatus(
  twilioSid: string,
  status: string,
  error: string | null
): Promise<void> {
  const delivered = status === 'delivered' || status === 'read';
  const failed = status === 'failed' || status === 'undelivered';
  await query(
    `UPDATE alerts SET
      delivered_at = CASE WHEN $2 THEN NOW() ELSE delivered_at END,
      error        = CASE WHEN $3 THEN $4 ELSE error END
    WHERE twilio_sid = $1`,
    [twilioSid, delivered, failed, error]
  );
}

export async function acknowledgeAlert(alertId: number, acknowledgedBy: string): Promise<boolean> {
  const result = await query(
    'UPDATE alerts SET acknowledged_at = NOW(), acknowledged_by = $1 WHERE id = $2 AND acknowledged_at IS NULL',
    [acknowledgedBy, alertId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getAlerts(filters?: {
  location_id?: string;
  limit?: number;
  offset?: number;
}): Promise<AlertRecord[]> {
  let sql = 'SELECT * FROM alerts';
  const params: any[] = [];
  let paramIndex = 1;

  if (filters?.location_id) {
    sql += ` WHERE location_id = $${paramIndex++}`;
    params.push(filters.location_id);
  }

  sql += ' ORDER BY sent_at DESC NULLS LAST';

  if (filters?.limit) {
    sql += ` LIMIT $${paramIndex++}`;
    params.push(filters.limit);
    if (filters?.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(filters.offset);
    }
  }

  return getMany<AlertRecord>(sql, params);
}

export async function getRecentAlertsForLocation(locationId: string, withinMinutes: number): Promise<AlertRecord[]> {
  return getMany<AlertRecord>(
    `SELECT * FROM alerts
     WHERE location_id = $1
       AND sent_at >= NOW() - ($2 || ' minutes')::interval
     ORDER BY sent_at DESC`,
    [locationId, withinMinutes.toString()]
  );
}

export async function getUnacknowledgedAlerts(olderThanMinutes: number = 5): Promise<AlertRecord[]> {
  return getMany<AlertRecord>(
    `SELECT * FROM alerts 
     WHERE acknowledged_at IS NULL 
       AND sent_at < NOW() - interval '${olderThanMinutes} minutes'
       AND escalated = false
     ORDER BY sent_at ASC`,
  );
}

export async function escalateAlert(alertId: number): Promise<boolean> {
  const result = await query('UPDATE alerts SET escalated = true WHERE id = $1', [alertId]);
  return (result.rowCount ?? 0) > 0;
}

// ============================================================
// Ingestion queries
// ============================================================

export interface IngestionRecord {
  id: number;
  product_id: string;
  product_time_start: string;
  product_time_end: string;
  flash_count: number;
  file_size_bytes: number | null;
  download_ms: number | null;
  parse_ms: number | null;
  ingested_at: string;
  qc_status: string;
  trail_data: any;
}

export async function addIngestionRecord(record: Omit<IngestionRecord, 'id'>): Promise<number> {
  const result = await getOne<{ id: number }>(
    `INSERT INTO ingestion_log (
      product_id, product_time_start, product_time_end, flash_count,
      file_size_bytes, download_ms, parse_ms, ingested_at, qc_status, trail_data
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      record.product_id,
      record.product_time_start,
      record.product_time_end,
      record.flash_count,
      record.file_size_bytes,
      record.download_ms,
      record.parse_ms,
      record.ingested_at,
      record.qc_status,
      record.trail_data ? JSON.stringify(record.trail_data) : null,
    ]
  );
  if (!result) throw new Error('Failed to add ingestion record');
  return result.id;
}

export async function getRecentIngestionLogs(hours: number = 1): Promise<IngestionRecord[]> {
  return getMany<IngestionRecord>(
    `SELECT * FROM ingestion_log 
     WHERE ingested_at >= NOW() - interval '${hours} hours'
     ORDER BY ingested_at DESC`,
  );
}

export async function getLatestIngestionTime(): Promise<Date | null> {
  const result = await getOne<{ latest: Date }>(
    'SELECT MAX(product_time_end) AS latest FROM ingestion_log WHERE qc_status != \'ERROR\''
  );
  return result?.latest || null;
}

// ============================================================
// Location Recipients queries
// ============================================================

export interface LocationRecipientRecord {
  id: number;
  location_id: string;
  email: string;
  phone: string | null;
  active: boolean;
  notify_email: boolean;
  notify_sms: boolean;
  notify_whatsapp: boolean;
}

export async function getLocationRecipients(locationId: string): Promise<LocationRecipientRecord[]> {
  return getMany<LocationRecipientRecord>(
    'SELECT * FROM location_recipients WHERE location_id = $1 AND active = true',
    [locationId]
  );
}

export async function getLocationRecipientById(id: string): Promise<LocationRecipientRecord | null> {
  return getOne<LocationRecipientRecord>(
    'SELECT * FROM location_recipients WHERE id = $1',
    [id]
  );
}

export async function addLocationRecipient(record: Omit<LocationRecipientRecord, 'id'>): Promise<number> {
  const result = await getOne<{ id: number }>(
    'INSERT INTO location_recipients (location_id, email, phone, active, notify_email, notify_sms, notify_whatsapp) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [record.location_id, record.email, record.phone, record.active, record.notify_email ?? true, record.notify_sms ?? false, record.notify_whatsapp ?? false]
  );
  if (!result) throw new Error('Failed to add location recipient');
  return result.id;
}

export async function updateLocationRecipient(id: string, updates: Partial<{
  email: string;
  phone: string;
  active: boolean;
  notify_email: boolean;
  notify_sms: boolean;
  notify_whatsapp: boolean;
}>): Promise<LocationRecipientRecord | null> {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  if (updates.email !== undefined) {
    fields.push(`email = $${paramIndex++}`);
    values.push(updates.email);
  }
  if (updates.phone !== undefined) {
    fields.push(`phone = $${paramIndex++}`);
    values.push(updates.phone);
  }
  if (updates.active !== undefined) {
    fields.push(`active = $${paramIndex++}`);
    values.push(updates.active);
  }
  if (updates.notify_email !== undefined) {
    fields.push(`notify_email = $${paramIndex++}`);
    values.push(updates.notify_email);
  }
  if (updates.notify_sms !== undefined) {
    fields.push(`notify_sms = $${paramIndex++}`);
    values.push(updates.notify_sms);
  }
  if (updates.notify_whatsapp !== undefined) {
    fields.push(`notify_whatsapp = $${paramIndex++}`);
    values.push(updates.notify_whatsapp);
  }

  if (fields.length === 0) return null;

  values.push(id);
  const result = await getOne<LocationRecipientRecord>(
    `UPDATE location_recipients SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result;
}

export async function deleteLocationRecipient(id: string): Promise<boolean> {
  const result = await query('DELETE FROM location_recipients WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

// ============================================================
// Flash Event queries (using existing db.ts functions)
// ============================================================

export { 
  countFlashesInRadius, 
  getNearestFlashDistance, 
  getTimeSinceLastFlashInRadius,
  getFlashTrend,
  getRecentFlashes
} from './db';

// ============================================================
// Utility functions
// ============================================================

export async function pruneOldData(): Promise<void> {
  const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || '30');
  
  // Prune old risk states
  await query(
    `DELETE FROM risk_states 
     WHERE evaluated_at < NOW() - interval '${retentionDays} days'`
  );
  
  // Prune old flash events  
  await query(
    `DELETE FROM flash_events 
     WHERE flash_time_utc < NOW() - interval '${retentionDays} days'`
  );
  
  // Prune old alerts (keep longer for audit)
  await query(
    `DELETE FROM alerts 
     WHERE sent_at < NOW() - interval '${retentionDays * 2} days'`
  );
  
  // Prune old ingestion logs
  await query(
    `DELETE FROM ingestion_log 
     WHERE ingested_at < NOW() - interval '${retentionDays} days'`
  );
}

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch (error) {
    return false;
  }
}

// ============================================================
// App Settings queries
// ============================================================

export async function getAppSettings(): Promise<Record<string, string>> {
  const rows = await getMany<{ key: string; value: string }>('SELECT key, value FROM app_settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

// ============================================================
// Org helpers for escalation
// ============================================================

export async function getOrgAdminEmails(orgId: string): Promise<string[]> {
  const rows = await getMany<{ email: string }>(
    `SELECT email FROM users WHERE org_id = $1 AND role IN ('admin', 'super_admin')`,
    [orgId]
  );
  return rows.map(r => r.email);
}

export async function getOrgIdForLocation(locationId: string): Promise<string | null> {
  const row = await getOne<{ org_id: string }>(
    'SELECT org_id FROM locations WHERE id = $1',
    [locationId]
  );
  return row?.org_id ?? null;
}
