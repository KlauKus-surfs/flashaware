import { query, getOne, getMany } from '../db';

// Per-org settings — overrides app_settings (which acts as platform default).
// Lookup order: org_settings(orgId, key) → app_settings(key) → null.

export async function getOrgSettings(orgId: string): Promise<Record<string, string>> {
  // Merge platform defaults with this org's overrides; per-org wins on conflict.
  const rows = await getMany<{ key: string; value: string }>(
    `SELECT key, value FROM (
       SELECT key, value, 1 AS priority FROM app_settings
       UNION ALL
       SELECT key, value, 2 AS priority FROM org_settings WHERE org_id = $1
     ) merged
     ORDER BY priority`,
    [orgId],
  );
  // Later rows (priority 2 = org override) win because Object.fromEntries dedups.
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Read a single key with the org→platform→null fallback. */
export async function getOrgSetting(orgId: string, key: string): Promise<string | null> {
  const r = await getOne<{ value: string }>(
    `SELECT value FROM org_settings WHERE org_id = $1 AND key = $2`,
    [orgId, key],
  );
  if (r) return r.value;
  const fallback = await getOne<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [key],
  );
  return fallback?.value ?? null;
}

export async function setOrgSetting(orgId: string, key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO org_settings (org_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (org_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
    [orgId, key, value],
  );
}

export async function deleteOrgSetting(orgId: string, key: string): Promise<void> {
  await query('DELETE FROM org_settings WHERE org_id = $1 AND key = $2', [orgId, key]);
}

// ============================================================
// Org helpers for escalation / alert routing
// ============================================================

export async function getOrgAdminEmails(orgId: string): Promise<string[]> {
  const rows = await getMany<{ email: string }>(
    `SELECT email FROM users WHERE org_id = $1 AND role IN ('admin', 'super_admin')`,
    [orgId],
  );
  return rows.map((r) => r.email);
}

export async function getOrgIdForLocation(locationId: string): Promise<string | null> {
  const row = await getOne<{ org_id: string }>('SELECT org_id FROM locations WHERE id = $1', [
    locationId,
  ]);
  return row?.org_id ?? null;
}
