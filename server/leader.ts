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
const POLL_INTERVAL_MS = 30_000;

let leaderClient: PoolClient | null = null;
let onElected: (() => void | Promise<void>) | null = null;
let onDemoted: (() => void | Promise<void>) | null = null;
let isLeader = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let stopped = false;

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

function startPolling() {
  if (pollTimer || stopped) return;
  pollTimer = setInterval(async () => {
    if (await tryAcquire()) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (onElected) await onElected();
      monitorLock();
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Start trying to become leader. When (or if) this machine wins the election,
 * `onElectedFn` runs the leader-only jobs. If the leader connection later
 * errors, `onDemotedFn` is invoked so the caller can stop those jobs, and the
 * election loop resumes — the process keeps serving HTTP/WS as a follower.
 *
 * Previous behaviour was `process.exit(1)` on lock loss, which dropped every
 * connected dashboard and interrupted any in-flight HTTP request just to let
 * Fly restart us. Demoting in place is strictly more available.
 */
export async function startLeaderElection(
  onElectedFn: () => void | Promise<void>,
  onDemotedFn?: () => void | Promise<void>,
): Promise<void> {
  onElected = onElectedFn;
  onDemoted = onDemotedFn ?? null;

  if (await tryAcquire()) {
    await onElected();
    monitorLock();
    return;
  }

  logger.info('Another machine holds the leader lock — standing by as follower');
  startPolling();
}

function monitorLock() {
  if (!leaderClient) return;
  leaderClient.on('error', async (err) => {
    logger.error('Leader client errored — demoting to follower', { error: err.message });
    await demoteLocked();
    startPolling();
  });
}

// Internal demotion — drop in-process leader state and run the caller's
// stop-jobs hook. Tolerates being called on a client that's already gone.
async function demoteLocked(): Promise<void> {
  const client = leaderClient;
  leaderClient = null;
  isLeader = false;
  if (onDemoted) {
    try { await onDemoted(); }
    catch (e) { logger.warn('onDemoted hook threw', { error: (e as Error).message }); }
  }
  if (client) {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]); }
    catch { /* connection may already be dead */ }
    try { client.release(true); } catch { /* ignore */ }
  }
}

export async function releaseLeaderLock(): Promise<void> {
  stopped = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (!leaderClient) return;
  try {
    await leaderClient.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_KEY]);
    logger.info('Released leader advisory lock');
  } catch (err) {
    logger.warn('Failed to release advisory lock cleanly', { error: (err as Error).message });
  } finally {
    try { leaderClient.release(); } catch { /* ignore */ }
    leaderClient = null;
    isLeader = false;
  }
}

export function amLeader(): boolean {
  return isLeader;
}
