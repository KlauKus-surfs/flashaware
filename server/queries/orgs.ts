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

// Tiny TTL cache for getOrgSettings. The settings UNION query runs on every
// alert dispatch, every escalation cycle, and every feed-health notice — at
// scale the same org_id may be looked up dozens of times in a few seconds
// during a stormy tick. Default TTL is 10s; tune via ORG_SETTINGS_CACHE_TTL_MS.
//
// Trade-off: an admin who toggles a setting (email_enabled, escalation_delay)
// sees the change after up to ttlMs instead of immediately. 10s is well
// inside human reaction time and the settings UI re-reads after save anyway.
// Settings mutations should call clearOrgSettingsCache(orgId) to invalidate
// proactively — see settingsRoutes.ts.
const orgSettingsCache = new Map<string, { value: Record<string, string>; expiresAt: number }>();
const ORG_SETTINGS_CACHE_TTL_MS = parseInt(
  process.env.ORG_SETTINGS_CACHE_TTL_MS || '10000',
  10,
);

export async function getOrgSettingsCached(
  orgId: string,
  ttlMs: number = ORG_SETTINGS_CACHE_TTL_MS,
): Promise<Record<string, string>> {
  const now = Date.now();
  const hit = orgSettingsCache.get(orgId);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await getOrgSettings(orgId);
  orgSettingsCache.set(orgId, { value, expiresAt: now + ttlMs });
  return value;
}

export function clearOrgSettingsCache(orgId?: string): void {
  if (orgId === undefined) orgSettingsCache.clear();
  else orgSettingsCache.delete(orgId);
}

// Test-only inspection of cache state. Not exported through the queries
// barrel so production code doesn't accidentally depend on it.
export function _orgSettingsCacheSize(): number {
  return orgSettingsCache.size;
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
