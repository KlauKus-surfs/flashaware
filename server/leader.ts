import { PoolClient } from 'pg';
import { pool } from './db';
import { logger } from './logger';

// Single-leader election via Postgres advisory locks.
//
// Fly.io may run multiple machines. Background jobs (risk engine, EUMETSAT
// ingestion, escalation checks, retention) must run on exactly one machine or
// we get duplicate alerts and double-billed Twilio sends. We hold a
// session-scoped advisory lock on a dedicated client and only run leader-only
// jobs while we hold it.

// Arbitrary 64-bit signed int. Keep stable across deploys.
const LEADER_LOCK_KEY = '562912340987654321';

let leaderClient: PoolClient | null = null;
let onElected: (() => void | Promise<void>) | null = null;
let isLeader = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function tryAcquire(): Promise<boolean> {
  if (leaderClient) return isLeader;
  const client = await pool.connect();
  try {
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LEADER_LOCK_KEY]);
    if (r.rows[0]?.got === true) {
      leaderClient = client;
      isLeader = true;
      logger.info('Acquired leader advisory lock — this machine will run background jobs');
      return true;
    }
    client.release();
    return false;
  } catch (err) {
    client.release();
    logger.warn('Advisory lock acquire failed', { error: (err as Error).message });
    return false;
  }
}

/**
 * Start trying to become leader. When (or if) this machine wins the election,
 * `onElectedFn` is invoked exactly once. If we lose the lock later (the
 * dedicated client errors out) the process exits so Fly restarts it.
 */
export async function startLeaderElection(onElectedFn: () => void | Promise<void>): Promise<void> {
  onElected = onElectedFn;

  if (await tryAcquire()) {
    await onElected();
    monitorLock();
    return;
  }

  logger.info('Another machine holds the leader lock — standing by as follower');
  pollTimer = setInterval(async () => {
    if (await tryAcquire()) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (onElected) await onElected();
      monitorLock();
    }
  }, 30_000);
}

function monitorLock() {
  if (!leaderClient) return;
  leaderClient.on('error', (err) => {
    logger.error('Leader client errored — dropping leadership and exiting', { error: err.message });
    process.exit(1);
  });
}

export async function releaseLeaderLock(): Promise<void> {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (!leaderClient) return;
  try {
    await leaderClient.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
    logger.info('Released leader advisory lock');
  } catch (err) {
    logger.warn('Failed to release advisory lock cleanly', { error: (err as Error).message });
  } finally {
    try { leaderClient.release(); } catch (_) { /* ignore */ }
    leaderClient = null;
    isLeader = false;
  }
}

export function amLeader(): boolean {
  return isLeader;
}
