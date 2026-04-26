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
  org_id: string;
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
  alert_on_change_only: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function getAllLocations(orgId?: string): Promise<LocationRecord[]> {
  // Always filter out locations belonging to soft-deleted orgs — these should
  // be invisible to the risk engine, dashboards, and search until either
  // restored or hard-deleted by retention.
  if (orgId) {
    return getMany<LocationRecord>(
      `SELECT l.id, l.name, l.site_type, ST_AsText(l.geom) AS geom, ST_AsText(l.centroid) AS centroid,
       l.timezone, l.stop_radius_km, l.prepare_radius_km, l.stop_flash_threshold, l.stop_window_min,
       l.prepare_flash_threshold, l.prepare_window_min, l.allclear_wait_min, l.persistence_alert_min,
       l.alert_on_change_only, l.enabled, l.created_at, l.updated_at
       FROM locations l
       INNER JOIN organisations o ON o.id = l.org_id AND o.deleted_at IS NULL
       WHERE l.enabled = true AND l.org_id = $1
       ORDER BY l.name`,
      [orgId]
    );
  }
  return getMany<LocationRecord>(
    `SELECT l.id, l.name, l.site_type, ST_AsText(l.geom) AS geom, ST_AsText(l.centroid) AS centroid,
     l.timezone, l.stop_radius_km, l.prepare_radius_km, l.stop_flash_threshold, l.stop_window_min,
     l.prepare_flash_threshold, l.prepare_window_min, l.allclear_wait_min, l.persistence_alert_min,
     l.alert_on_change_only, l.enabled, l.created_at, l.updated_at
     FROM locations l
     INNER JOIN organisations o ON o.id = l.org_id AND o.deleted_at IS NULL
     WHERE l.enabled = true
     ORDER BY l.name`
  );
}

export async function getAllLocationsAdmin(orgId: string): Promise<LocationRecord[]> {
  return getMany<LocationRecord>(
    `SELECT id, name, site_type, ST_AsText(geom) AS geom, ST_AsText(centroid) AS centroid,
     timezone, stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
     prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, alert_on_change_only, enabled, created_at, updated_at
     FROM locations WHERE org_id = $1 ORDER BY name`,
    [orgId]
  );
}

// LocationRecord + the latest risk state in one query — replaces the N+1 pattern
// where the API loops over locations calling getLatestRiskState per row.
// org_name / org_slug are populated for the cross-org super-admin view so the
// UI can disambiguate which tenant a location belongs to.
export interface LocationWithStateRecord extends LocationRecord {
  current_state: string | null;
  state_evaluated_at: string | null;
  state_reason: any;
  nearest_flash_km: number | null;
  flashes_in_stop_radius: number | null;
  flashes_in_prepare_radius: number | null;
  data_age_sec: number | null;
  is_degraded: boolean | null;
  org_name: string | null;
  org_slug: string | null;
}

/**
 * If `orgId` is a string, returns only that org's locations (regular tenant view).
 * If `orgId` is undefined, returns all locations across all orgs (super-admin view).
 * Pass enabledOnly to filter to only enabled=true locations.
 */
export async function getLocationsWithLatestState(
  orgId: string | undefined,
  opts: { enabledOnly?: boolean } = {}
): Promise<LocationWithStateRecord[]> {
  const enabledClause = opts.enabledOnly ? 'AND l.enabled = true' : '';
  const orgFilter = orgId ? 'WHERE l.org_id = $1' : 'WHERE TRUE';
  const params = orgId ? [orgId] : [];
  return getMany<LocationWithStateRecord>(
    `SELECT
       l.id, l.org_id, l.name, l.site_type,
       ST_AsText(l.geom) AS geom, ST_AsText(l.centroid) AS centroid,
       l.timezone, l.stop_radius_km, l.prepare_radius_km,
       l.stop_flash_threshold, l.stop_window_min,
       l.prepare_flash_threshold, l.prepare_window_min,
       l.allclear_wait_min, l.persistence_alert_min, l.alert_on_change_only,
       l.enabled, l.created_at, l.updated_at,
       o.name                       AS org_name,
       o.slug                       AS org_slug,
       rs.state                     AS current_state,
       rs.evaluated_at              AS state_evaluated_at,
       rs.reason                    AS state_reason,
       rs.nearest_flash_km          AS nearest_flash_km,
       rs.flashes_in_stop_radius    AS flashes_in_stop_radius,
       rs.flashes_in_prepare_radius AS flashes_in_prepare_radius,
       rs.data_age_sec              AS data_age_sec,
       rs.is_degraded               AS is_degraded
     FROM locations l
     INNER JOIN organisations o ON o.id = l.org_id AND o.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT state, evaluated_at, reason, nearest_flash_km,
              flashes_in_stop_radius, flashes_in_prepare_radius,
              data_age_sec, is_degraded
       FROM risk_states
       WHERE location_id = l.id
       ORDER BY evaluated_at DESC
       LIMIT 1
     ) rs ON true
     ${orgFilter} ${enabledClause}
     ORDER BY o.name NULLS LAST, l.name`,
    params
  );
}

export async function getLocationById(id: string): Promise<LocationRecord | null> {
  return getOne<LocationRecord>(
    `SELECT id, org_id, name, site_type, ST_AsText(geom) AS geom, ST_AsText(centroid) AS centroid,
     timezone, stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
     prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, alert_on_change_only, enabled, created_at, updated_at
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
  alert_on_change_only?: boolean;
}): Promise<LocationRecord> {
  const result = await getOne<LocationRecord>(
    `INSERT INTO locations (
      name, site_type, geom, centroid, timezone,
      stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
      prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, alert_on_change_only, org_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
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
      locationData.alert_on_change_only ?? false,
      locationData.org_id,
    ]
  );
  if (!result) throw new Error('Failed to create location');
  return result;
}

export async function deleteLocation(id: string): Promise<boolean> {
  // Explicitly remove dependent records in case ON DELETE CASCADE is not active
  await query(`DELETE FROM alerts WHERE location_id = $1`, [id]);
  await query(`DELETE FROM risk_states WHERE location_id = $1`, [id]);
  await query(`DELETE FROM location_recipients WHERE location_id = $1`, [id]);
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
  alert_on_change_only: boolean;
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
    'allclear_wait_min', 'persistence_alert_min', 'alert_on_change_only', 'enabled'
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
     WHERE evaluated_at >= NOW() - make_interval(hours => $1)
     ORDER BY evaluated_at DESC`,
    [hours]
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
    `SELECT a.* FROM alerts a
     INNER JOIN locations l ON l.id = a.location_id
     WHERE a.acknowledged_at IS NULL
       AND a.sent_at < NOW() - make_interval(mins => $1)
       AND a.escalated = false
     ORDER BY a.sent_at ASC`,
    [olderThanMinutes]
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
  phone_verified_at: string | null;
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

export async function addLocationRecipient(record: Omit<LocationRecipientRecord, 'id' | 'phone_verified_at'>): Promise<number> {
  const result = await getOne<{ id: number }>(
    'INSERT INTO location_recipients (location_id, email, phone, active, notify_email, notify_sms, notify_whatsapp) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [record.location_id, record.email, record.phone, record.active, record.notify_email ?? true, record.notify_sms ?? false, record.notify_whatsapp ?? false]
  );
  if (!result) throw new Error('Failed to add location recipient');
  return result.id;
}

export async function updateLocationRecipient(id: string, updates: Partial<{
  email: string;
  phone: string | null;
  active: boolean;
  notify_email: boolean;
  notify_sms: boolean;
  notify_whatsapp: boolean;
  phone_verified_at: string | null;
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
  if (updates.phone_verified_at !== undefined) {
    fields.push(`phone_verified_at = $${paramIndex++}`);
    values.push(updates.phone_verified_at);
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
// Phone OTP queries — phone verification before SMS/WhatsApp dispatch
// ============================================================

export interface RecipientPhoneOtpRecord {
  id: number;
  recipient_id: number;
  phone: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
  verified_at: string | null;
  created_at: string;
}

/** Count OTPs created for this recipient since `since` (used for rate-limiting). */
export async function countRecentOtpSendsForRecipient(recipientId: number, sinceMinutes: number): Promise<number> {
  const r = await getOne<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM recipient_phone_otps
     WHERE recipient_id = $1 AND created_at >= NOW() - make_interval(mins => $2)`,
    [recipientId, sinceMinutes]
  );
  return parseInt(r?.c || '0', 10);
}

/** Returns the timestamp of the oldest OTP sent within `sinceMinutes` for this recipient,
 *  or null if no recent sends. Used to compute a retry-after window. */
export async function oldestRecentOtpSendForRecipient(recipientId: number, sinceMinutes: number): Promise<Date | null> {
  const r = await getOne<{ created_at: string }>(
    `SELECT created_at FROM recipient_phone_otps
     WHERE recipient_id = $1 AND created_at >= NOW() - make_interval(mins => $2)
     ORDER BY created_at ASC LIMIT 1`,
    [recipientId, sinceMinutes]
  );
  return r ? new Date(r.created_at) : null;
}

/** Insert a new OTP. The caller is responsible for hashing the code first. */
export async function insertPhoneOtp(recipientId: number, phone: string, codeHash: string, expiresAt: Date): Promise<number> {
  const r = await getOne<{ id: number }>(
    `INSERT INTO recipient_phone_otps (recipient_id, phone, code_hash, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [recipientId, phone, codeHash, expiresAt]
  );
  if (!r) throw new Error('Failed to insert OTP');
  return r.id;
}

/** Latest unverified OTP that is still valid for this recipient + phone. */
export async function getActivePhoneOtp(recipientId: number, phone: string): Promise<RecipientPhoneOtpRecord | null> {
  return getOne<RecipientPhoneOtpRecord>(
    `SELECT * FROM recipient_phone_otps
     WHERE recipient_id = $1 AND phone = $2 AND verified_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [recipientId, phone]
  );
}

export async function incrementPhoneOtpAttempts(otpId: number): Promise<number> {
  const r = await getOne<{ attempts: number }>(
    `UPDATE recipient_phone_otps SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
    [otpId]
  );
  return r?.attempts ?? 0;
}

export async function markPhoneOtpVerified(otpId: number): Promise<void> {
  await query(`UPDATE recipient_phone_otps SET verified_at = NOW() WHERE id = $1`, [otpId]);
}

export async function markRecipientPhoneVerified(recipientId: number): Promise<void> {
  await query(
    `UPDATE location_recipients SET phone_verified_at = NOW() WHERE id = $1`,
    [recipientId]
  );
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
// Per-org settings — overrides app_settings (which acts as platform default).
// Lookup order: org_settings(orgId, key) → app_settings(key) → null.
// ============================================================

export async function getOrgSettings(orgId: string): Promise<Record<string, string>> {
  // Merge platform defaults with this org's overrides; per-org wins on conflict.
  const rows = await getMany<{ key: string; value: string }>(
    `SELECT key, value FROM (
       SELECT key, value, 1 AS priority FROM app_settings
       UNION ALL
       SELECT key, value, 2 AS priority FROM org_settings WHERE org_id = $1
     ) merged
     ORDER BY priority`,
    [orgId]
  );
  // Later rows (priority 2 = org override) win because Object.fromEntries dedups.
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

/** Read a single key with the org→platform→null fallback. */
export async function getOrgSetting(orgId: string, key: string): Promise<string | null> {
  const r = await getOne<{ value: string }>(
    `SELECT value FROM org_settings WHERE org_id = $1 AND key = $2`,
    [orgId, key]
  );
  if (r) return r.value;
  const fallback = await getOne<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  return fallback?.value ?? null;
}

export async function setOrgSetting(orgId: string, key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO org_settings (org_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (org_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
    [orgId, key, value]
  );
}

export async function deleteOrgSetting(orgId: string, key: string): Promise<void> {
  await query('DELETE FROM org_settings WHERE org_id = $1 AND key = $2', [orgId, key]);
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
