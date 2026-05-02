import { query } from '../db';

// NOTE: data retention lives in startLeaderJobs/runRetention in index.ts —
// it's gated behind the leader advisory lock, transactional, and writes a
// checkpoint row to app_settings. The previous duplicate `pruneOldData` here
// was dead code with template-literal interval strings; deleted 2026-05.

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}
