import { query, getMany } from '../db';

export async function getAppSettings(): Promise<Record<string, string>> {
  const rows = await getMany<{ key: string; value: string }>('SELECT key, value FROM app_settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value],
  );
}

// API-ingester heartbeat — written by server/eumetsatService.ts on every
// cycle (the in-process ingester gated behind the leader advisory lock). The
// two timestamps answer different questions:
//
//   * lastSuccessAt: when did the ingester last reach EUMETSAT cleanly?
//     Stale → ingester is alive but failing (auth/network).
//   * lastAttemptAt: when did the ingester last try at all?
//     Stale → ingester process is dead/wedged. Crash before next attempt
//     means lastAttemptAt and lastSuccessAt diverge.
//
// Distinct from getLatestIngestionTime() which reads MAX(flash_time_utc)
// from flash_events: that one is zero during quiet weather even when the
// ingester is perfectly healthy.
//
// Storage keys are `api_ingester_*` to disambiguate from the historical
// Python `collector_*` keys (a dev-only collector that used to share the
// same row and clobber observability when run locally). The fallback chain
// `api_ingester_* → collector_*` keeps the dashboard chip lit during the
// first deploy after the rename and on dev machines that still run the
// Python collector. Once the API has written its first heartbeat the
// fallback never fires.
export interface CollectorHeartbeat {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  successLagMinutes: number | null;
  attemptLagMinutes: number | null;
}

export async function getCollectorHeartbeat(): Promise<CollectorHeartbeat> {
  const rows = await getMany<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings
     WHERE key IN (
       'api_ingester_last_success_at', 'api_ingester_last_attempt_at',
       'collector_last_success_at',    'collector_last_attempt_at'
     )`,
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const lastSuccessAt =
    map['api_ingester_last_success_at'] ?? map['collector_last_success_at'] ?? null;
  const lastAttemptAt =
    map['api_ingester_last_attempt_at'] ?? map['collector_last_attempt_at'] ?? null;
  const ageMin = (iso: string | null) =>
    iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 60000) : null;
  return {
    lastSuccessAt,
    lastAttemptAt,
    successLagMinutes: ageMin(lastSuccessAt),
    attemptLagMinutes: ageMin(lastAttemptAt),
  };
}
