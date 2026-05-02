import { query, getOne, getMany } from '../db';

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
  // One-tap ack via tokenised URL embedded in the delivered message.
  // NULL on the leading `recipient: 'system'` audit row (not delivered to
  // anyone, no URL needed) and on legacy rows pre-dating this column.
  // Optional on the TypeScript type so existing addAlert call sites in
  // alertService.ts continue to compile without changes; the SQL layer
  // coerces undefined → NULL via the `?? null` fallback in addAlert.
  // Paired field: ack_token_expires_at is NULL whenever ack_token is NULL.
  ack_token?: string | null;
  ack_token_expires_at?: string | null;
}

export async function addAlert(record: Omit<AlertRecord, 'id'>): Promise<number> {
  const result = await getOne<{ id: number }>(
    `INSERT INTO alerts (
      location_id, state_id, alert_type, recipient, sent_at, delivered_at,
      acknowledged_at, acknowledged_by, escalated, error, twilio_sid,
      ack_token, ack_token_expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
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
      record.ack_token ?? null,
      record.ack_token_expires_at ?? null,
    ],
  );
  if (!result) throw new Error('Failed to add alert');
  return result.id;
}

export async function updateAlertStatus(
  twilioSid: string,
  status: string,
  error: string | null,
): Promise<void> {
  const delivered = status === 'delivered' || status === 'read';
  const failed = status === 'failed' || status === 'undelivered';
  await query(
    `UPDATE alerts SET
      delivered_at = CASE WHEN $2 THEN NOW() ELSE delivered_at END,
      error        = CASE WHEN $3 THEN $4 ELSE error END
    WHERE twilio_sid = $1`,
    [twilioSid, delivered, failed, error],
  );
}

export async function acknowledgeAlert(alertId: number, acknowledgedBy: string): Promise<boolean> {
  const result = await query(
    'UPDATE alerts SET acknowledged_at = NOW(), acknowledged_by = $1 WHERE id = $2 AND acknowledged_at IS NULL',
    [acknowledgedBy, alertId],
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

export async function getRecentAlertsForLocation(
  locationId: string,
  withinMinutes: number,
): Promise<AlertRecord[]> {
  return getMany<AlertRecord>(
    `SELECT * FROM alerts
     WHERE location_id = $1
       AND sent_at >= NOW() - ($2 || ' minutes')::interval
     ORDER BY sent_at DESC`,
    [locationId, withinMinutes.toString()],
  );
}

export async function getUnacknowledgedAlerts(
  olderThanMinutes: number = 5,
): Promise<AlertRecord[]> {
  return getMany<AlertRecord>(
    `SELECT a.* FROM alerts a
     INNER JOIN locations l ON l.id = a.location_id
     WHERE a.acknowledged_at IS NULL
       AND a.sent_at < NOW() - make_interval(mins => $1)
       AND a.escalated = false
     ORDER BY a.sent_at ASC`,
    [olderThanMinutes],
  );
}

export async function escalateAlert(alertId: number): Promise<boolean> {
  const result = await query('UPDATE alerts SET escalated = true WHERE id = $1', [alertId]);
  return (result.rowCount ?? 0) > 0;
}
