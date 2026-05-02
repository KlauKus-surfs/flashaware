import { query, getOne, getMany } from '../db';

// Per-state opt-in. Missing keys default to true at the dispatch gate.
export type NotifyStates = Partial<
  Record<'STOP' | 'PREPARE' | 'HOLD' | 'ALL_CLEAR' | 'DEGRADED', boolean>
>;

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
  notify_states: NotifyStates;
}

// Soft-delete enforcement: getAllLocations already excludes locations whose
// org has deleted_at set; recipient lookups need the same join so a
// soft-deleted org's recipients aren't returned mid-grace-window.
export async function getLocationRecipients(
  locationId: string,
): Promise<LocationRecipientRecord[]> {
  return getMany<LocationRecipientRecord>(
    `SELECT lr.*
       FROM location_recipients lr
       JOIN locations l       ON l.id = lr.location_id
       JOIN organisations o   ON o.id = l.org_id AND o.deleted_at IS NULL
      WHERE lr.location_id = $1 AND lr.active = true`,
    [locationId],
  );
}

export async function getLocationRecipientById(
  id: string,
): Promise<LocationRecipientRecord | null> {
  return getOne<LocationRecipientRecord>(
    `SELECT lr.*
       FROM location_recipients lr
       JOIN locations l       ON l.id = lr.location_id
       JOIN organisations o   ON o.id = l.org_id AND o.deleted_at IS NULL
      WHERE lr.id = $1`,
    [id],
  );
}

export async function addLocationRecipient(
  record: Omit<LocationRecipientRecord, 'id' | 'phone_verified_at' | 'notify_states'> & {
    notify_states?: NotifyStates;
  },
): Promise<number> {
  // notify_states is optional; the column DEFAULT covers the common case where
  // the caller doesn't specify (all five states enabled).
  if (record.notify_states !== undefined) {
    const result = await getOne<{ id: number }>(
      'INSERT INTO location_recipients (location_id, email, phone, active, notify_email, notify_sms, notify_whatsapp, notify_states) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [
        record.location_id,
        record.email,
        record.phone,
        record.active,
        record.notify_email ?? true,
        record.notify_sms ?? false,
        record.notify_whatsapp ?? false,
        JSON.stringify(record.notify_states),
      ],
    );
    if (!result) throw new Error('Failed to add location recipient');
    return result.id;
  }
  const result = await getOne<{ id: number }>(
    'INSERT INTO location_recipients (location_id, email, phone, active, notify_email, notify_sms, notify_whatsapp) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [
      record.location_id,
      record.email,
      record.phone,
      record.active,
      record.notify_email ?? true,
      record.notify_sms ?? false,
      record.notify_whatsapp ?? false,
    ],
  );
  if (!result) throw new Error('Failed to add location recipient');
  return result.id;
}

export async function updateLocationRecipient(
  id: string,
  updates: Partial<{
    email: string;
    phone: string | null;
    active: boolean;
    notify_email: boolean;
    notify_sms: boolean;
    notify_whatsapp: boolean;
    phone_verified_at: string | null;
    notify_states: NotifyStates;
  }>,
): Promise<LocationRecipientRecord | null> {
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
  if (updates.notify_states !== undefined) {
    fields.push(`notify_states = $${paramIndex++}`);
    values.push(JSON.stringify(updates.notify_states));
  }

  if (fields.length === 0) return null;

  values.push(id);
  const result = await getOne<LocationRecipientRecord>(
    `UPDATE location_recipients SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );
  return result;
}

/**
 * Pure helper: should this recipient receive an alert for this state?
 * Missing keys default to true so a partial map (or NULL from old rows) is
 * fail-open — safer to over-notify than to silently swallow a STOP.
 */
export function shouldNotifyForState(
  notifyStates: NotifyStates | null | undefined,
  state: string,
): boolean {
  if (!notifyStates) return true;
  const v = notifyStates[state as keyof NotifyStates];
  return v !== false;
}

export async function deleteLocationRecipient(id: string): Promise<boolean> {
  const result = await query('DELETE FROM location_recipients WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}
