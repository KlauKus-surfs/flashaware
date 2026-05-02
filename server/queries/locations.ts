import { query, getOne, getMany } from '../db';

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
  is_demo: boolean;
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
      `SELECT l.id, l.org_id, l.name, l.site_type, ST_AsText(l.geom) AS geom, ST_AsText(l.centroid) AS centroid,
       l.timezone, l.stop_radius_km, l.prepare_radius_km, l.stop_flash_threshold, l.stop_window_min,
       l.prepare_flash_threshold, l.prepare_window_min, l.allclear_wait_min, l.persistence_alert_min,
       l.alert_on_change_only, l.is_demo, l.enabled, l.created_at, l.updated_at
       FROM locations l
       INNER JOIN organisations o ON o.id = l.org_id AND o.deleted_at IS NULL
       WHERE l.enabled = true AND l.org_id = $1
       ORDER BY l.name`,
      [orgId],
    );
  }
  return getMany<LocationRecord>(
    `SELECT l.id, l.org_id, l.name, l.site_type, ST_AsText(l.geom) AS geom, ST_AsText(l.centroid) AS centroid,
     l.timezone, l.stop_radius_km, l.prepare_radius_km, l.stop_flash_threshold, l.stop_window_min,
     l.prepare_flash_threshold, l.prepare_window_min, l.allclear_wait_min, l.persistence_alert_min,
     l.alert_on_change_only, l.is_demo, l.enabled, l.created_at, l.updated_at
     FROM locations l
     INNER JOIN organisations o ON o.id = l.org_id AND o.deleted_at IS NULL
     WHERE l.enabled = true
     ORDER BY l.name`,
  );
}

export async function getAllLocationsAdmin(orgId: string): Promise<LocationRecord[]> {
  return getMany<LocationRecord>(
    `SELECT id, name, site_type, ST_AsText(geom) AS geom, ST_AsText(centroid) AS centroid,
     timezone, stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
     prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, alert_on_change_only, is_demo, enabled, created_at, updated_at
     FROM locations WHERE org_id = $1 ORDER BY name`,
    [orgId],
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
  // Joined: how many recipients on this location are active. Drives the
  // "no recipients configured" warning on dashboard cards and editor — an
  // armed location with 0 active recipients fires alerts that go nowhere.
  active_recipient_count: number;
}

/**
 * If `orgId` is a string, returns only that org's locations (regular tenant view).
 * If `orgId` is undefined, returns all locations across all orgs (super-admin view).
 * Pass enabledOnly to filter to only enabled=true locations.
 */
export async function getLocationsWithLatestState(
  orgId: string | undefined,
  opts: { enabledOnly?: boolean } = {},
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
       rs.is_degraded               AS is_degraded,
       COALESCE(rc.n, 0)::int       AS active_recipient_count
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
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS n
       FROM location_recipients
       WHERE location_id = l.id AND active = true
     ) rc ON true
     ${orgFilter} ${enabledClause}
     ORDER BY o.name NULLS LAST, l.name`,
    params,
  );
}

export async function getLocationById(id: string): Promise<LocationRecord | null> {
  return getOne<LocationRecord>(
    `SELECT id, org_id, name, site_type, ST_AsText(geom) AS geom, ST_AsText(centroid) AS centroid,
     timezone, stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
     prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, alert_on_change_only, is_demo, enabled, created_at, updated_at
     FROM locations WHERE id = $1`,
    [id],
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
  is_demo?: boolean;
}): Promise<LocationRecord> {
  const result = await getOne<LocationRecord>(
    `INSERT INTO locations (
      name, site_type, geom, centroid, timezone,
      stop_radius_km, prepare_radius_km, stop_flash_threshold, stop_window_min,
      prepare_flash_threshold, prepare_window_min, allclear_wait_min, persistence_alert_min, alert_on_change_only, is_demo, org_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
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
      locationData.is_demo ?? false,
      locationData.org_id,
    ],
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

export async function updateLocation(
  id: string,
  updates: Partial<{
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
    is_demo: boolean;
    enabled: boolean;
  }>,
): Promise<LocationRecord | null> {
  const fields = [];
  const values = [];
  let paramIndex = 1;

  // Add all updatable fields
  const updateableFields = [
    'name',
    'site_type',
    'geom',
    'centroid',
    'timezone',
    'stop_radius_km',
    'prepare_radius_km',
    'stop_flash_threshold',
    'stop_window_min',
    'prepare_flash_threshold',
    'prepare_window_min',
    'allclear_wait_min',
    'persistence_alert_min',
    'alert_on_change_only',
    'is_demo',
    'enabled',
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
    values,
  );
  return result;
}
