import { getOne, getMany } from '../db';

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
    ],
  );
  if (!result) throw new Error('Failed to add risk state');
  return result.id;
}

export async function getLatestRiskState(locationId: string): Promise<RiskStateRecord | null> {
  return getOne<RiskStateRecord>(
    'SELECT * FROM risk_states WHERE location_id = $1 ORDER BY evaluated_at DESC LIMIT 1',
    [locationId],
  );
}

export async function getLastNonDegradedState(
  locationId: string,
): Promise<'ALL_CLEAR' | 'PREPARE' | 'STOP' | 'HOLD' | null> {
  const row = await getOne<{ state: string }>(
    `SELECT state FROM risk_states
     WHERE location_id = $1 AND state != 'DEGRADED'
     ORDER BY evaluated_at DESC LIMIT 1`,
    [locationId],
  );
  return (row?.state as 'ALL_CLEAR' | 'PREPARE' | 'STOP' | 'HOLD') ?? null;
}

export async function getRecentRiskStates(
  locationId: string,
  limit: number = 50,
): Promise<RiskStateRecord[]> {
  return getMany<RiskStateRecord>(
    'SELECT * FROM risk_states WHERE location_id = $1 ORDER BY evaluated_at DESC LIMIT $2',
    [locationId, limit],
  );
}

export async function getAllRiskStates(hours: number = 2): Promise<RiskStateRecord[]> {
  return getMany<RiskStateRecord>(
    `SELECT * FROM risk_states
     WHERE evaluated_at >= NOW() - make_interval(hours => $1)
     ORDER BY evaluated_at DESC`,
    [hours],
  );
}
