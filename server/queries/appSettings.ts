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

// Collector heartbeat — written by the Python ingestion service every cycle
// (see ingestion/collector.py → update_collector_heartbeat). The two timestamps
// answer different questions:
//
//   * lastSuccessAt: when did the collector last reach EUMETSAT cleanly?
//     Stale → collector is alive but failing (auth/network).
//   * lastAttemptAt: when did the collector last try at all?
//     Stale → collector process is dead/wedged. Crash before next attempt
//     means lastAttemptAt and lastSuccessAt diverge.
//
// Distinct from getLatestIngestionTime() which reads MAX(flash_time_utc)
// from flash_events: that one is zero during quiet weather even when the
// collector is perfectly healthy.
export interface CollectorHeartbeat {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  successLagMinutes: number | null;
  attemptLagMinutes: number | null;
}

export async function getCollectorHeartbeat(): Promise<CollectorHeartbeat> {
  const rows = await getMany<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings
     WHERE key IN ('collector_last_success_at', 'collector_last_attempt_at')`,
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const lastSuccessAt = map['collector_last_success_at'] ?? null;
  const lastAttemptAt = map['collector_last_attempt_at'] ?? null;
  const ageMin = (iso: string | null) =>
    iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 60000) : null;
  return {
    lastSuccessAt,
    lastAttemptAt,
    successLagMinutes: ageMin(lastSuccessAt),
    attemptLagMinutes: ageMin(lastAttemptAt),
  };
}
