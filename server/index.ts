import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { createServer } from 'http';
import rateLimit from 'express-rate-limit';
import { authenticate, requireRole, login, loginRateLimit, AuthRequest } from './auth';
import {
  setAuthCookies,
  clearAuthCookies,
  generateCsrfToken,
  CSRF_COOKIE,
  requireCsrf,
} from './authCookie';
import { startRiskEngine } from './riskEngine';
import { checkEscalations, getNotifierCapabilities, validateNotifierConfig } from './alertService';
import {
  getLatestIngestionTime,
  getAllRiskStates,
  updateAlertStatus,
  getCollectorHeartbeat,
} from './queries';
import { hasCredentials, startLiveIngestion } from './eumetsatService';
import { logger } from './logger';
import { wsManager } from './websocket';
import userRoutes from './userRoutes';
import orgRoutes from './orgRoutes';
import recipientRoutes from './recipientRoutes';
import settingsRoutes from './settingsRoutes';
import alertRoutes from './alertRoutes';
import statusRoutes from './statusRoutes';
import platformRoutes from './platformRoutes';
import locationRoutes from './locationRoutes';
import publicAckRoutes from './publicAckRoutes';
import { runMigrations } from './migrate';
import { startLeaderElection, releaseLeaderLock } from './leader';
import { logAudit } from './audit';
import { requestIdMiddleware } from './middleware/requestId';
import twilioPkg from 'twilio';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const app = express();
const server = createServer(app);
const PORT = parseInt(process.env.SERVER_PORT || '4000');

// Background job handles, cleared on shutdown so the process can exit cleanly.
let escalationInterval: ReturnType<typeof setInterval> | null = null;
let retentionInterval: ReturnType<typeof setInterval> | null = null;

// Trust Fly.io's reverse proxy so rate limiting uses real client IPs
app.set('trust proxy', 1);

// WebSocket initialisation is now awaited inside the runMigrations() chain
// below — wsManager.initialize is async because it may attach a Redis
// adapter for multi-machine fan-out (when REDIS_URL is set), and we want
// the adapter live before the HTTP server starts accepting connections.

// Rate limiting for all API endpoints
const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per window
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// CORS posture is fail-closed in production. With `credentials: true` and
// `origin: true`, the previous default echoed back any Origin header the
// browser sent, effectively a wildcard CORS — combined with cookie/credential
// support that is a same-site-bypass primitive. Production deploys must set
// CORS_ORIGIN explicitly to the SPA's origin (e.g. https://flashaware.com).
// In development we keep `origin: true` for local-host convenience.
const corsOrigin = process.env.CORS_ORIGIN?.trim();
if (process.env.NODE_ENV === 'production' && !corsOrigin) {
  throw new Error(
    'CORS_ORIGIN must be set in production. Refusing to start with permissive CORS + credentials:true.',
  );
}
// CORS_ORIGIN can be a comma-separated list — split it so each origin is
// matched exactly. cors.origin accepts string | string[] | RegExp | function.
const allowedOrigins = corsOrigin
  ? corsOrigin
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  : true;
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);
app.use(express.json());
// Cookie parser — populates req.cookies for the httpOnly auth cookie path
// (see server/authCookie.ts). Mounted after CORS so the credentials path
// is established before we try to read cookies off it.
app.use(cookieParser());
// Request-ID context: must run before any handler that logs, so every log
// line in the chain auto-correlates via AsyncLocalStorage. Mounted after
// CORS / json so the trust-proxy + body-parsing happen first.
app.use(requestIdMiddleware);
app.use(apiRateLimit);
// CSRF for cookie-authenticated mutating requests. Mounted globally and
// applied only to non-GET/HEAD/OPTIONS verbs; the helper inside is also a
// no-op when the request authenticates via Bearer header (test runners,
// programmatic clients) — only browser-cookie sessions are protected. The
// /api/auth/login itself is excluded because there's no session yet.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // Endpoints that issue cookies or run before login is established — these
  // legitimately can't carry a CSRF token because the browser doesn't have
  // one yet. Webhooks (Twilio status callbacks) are signed independently
  // and don't use the cookie.
  if (
    req.path === '/api/auth/login' ||
    req.path === '/api/auth/logout' ||
    req.path === '/api/auth/csrf' ||
    req.path.startsWith('/api/webhooks/') ||
    req.path.startsWith('/api/ack/by-token/') // public ack — token IS the auth
  ) {
    return next();
  }
  requireCsrf(req, res, next);
});

// Initialize in-memory data (users + locations always; mock flashes only if no live credentials)
const liveMode = hasCredentials();
logger.info(`Initializing data (${liveMode ? 'LIVE EUMETSAT' : 'mock'} mode)...`);

// ============================================================
// Public endpoints
// ============================================================

// Liveness probe — the process is up and the event loop is responsive
// enough to answer. No DB call, no I/O, no allocations beyond the response.
// This is the route Fly.io's machine health check should hit: if the answer
// stops coming back, the machine genuinely needs a restart. Tying the
// liveness check to a DB ping (the historical /api/health behaviour) means
// a Postgres blip restarts the API process unnecessarily — which then
// has to reconnect, re-run migrations, and re-elect the leader.
app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

// Readiness probe — the process can serve traffic right now. We need the
// DB pool to be reachable; without it nothing useful happens. Returns 503
// if the ping fails, so a future load balancer in front of multiple
// machines can pull this instance out of rotation without restarting it.
app.get('/api/health/ready', async (_req, res) => {
  try {
    const { query: dbQuery } = await import('./db');
    await dbQuery('SELECT 1');
    res.json({ status: 'ok', db: true });
  } catch (err) {
    logger.warn('Readiness check failed', { error: (err as Error).message });
    res.status(503).json({ status: 'not_ready', db: false });
  }
});

// Operator-facing enriched health view. Powers the dashboard "system
// status" chip — tolerates DB enrichment failure (returns ok with a
// reduced payload), keeps `db` and `feedHealthy` flags compatible with
// existing clients. Do NOT use this for orchestrator probes; use /live
// or /ready instead.
//
// The body is cached for HEALTH_CACHE_TTL_MS so a multi-machine fleet polling
// the dashboard doesn't slam Postgres with COUNT(*) queries every second.
// Errors are intentionally NOT cached: a transient DB blip should clear
// immediately rather than being pinned to "down" for 10s.
const HEALTH_CACHE_TTL_MS = 10_000;
let healthCache: { body: Record<string, unknown>; expiresAt: number } | null = null;

async function computeHealth(): Promise<Record<string, unknown>> {
  const { query: dbQuery } = await import('./db');
  await dbQuery('SELECT 1');

  // Best-effort enrichment (non-blocking, won't fail health check).
  let extra: Record<string, unknown> = {};
  try {
    const { query: dbQuery2 } = await import('./db');
    // locationCount is a global count across every active tenant — the
    // previous form scoped it to the default FlashAware org which made
    // the dashboard chip read low for any operator browsing /api/health
    // from a non-default tenant. Health enrichment is platform-wide, so
    // the count should be too.
    const [latestProduct, locationCountRow, recentRiskStates, flashCountRow, collectorHb] =
      await Promise.all([
        getLatestIngestionTime(),
        dbQuery2(
          `SELECT COUNT(*)::int AS n FROM locations l
           INNER JOIN organisations o ON o.id = l.org_id AND o.deleted_at IS NULL`,
        ),
        getAllRiskStates(1),
        dbQuery2(
          `SELECT COUNT(*)::int AS n FROM flash_events WHERE flash_time_utc >= NOW() - interval '1 hour'`,
        ),
        getCollectorHeartbeat(),
      ]);
    const dataAgeMin = latestProduct
      ? Math.floor((Date.now() - latestProduct.getTime()) / 60000)
      : null;
    // Tiered feed status — see riskEngine for the matching DEGRADED threshold.
    // ≤12 healthy / ≤20 lagging / >20 stale, calibrated to MTG-LI's 10-min
    // product cadence so the chip doesn't flip stale on every routine cycle.
    let feedTier: 'healthy' | 'lagging' | 'stale' | 'unknown';
    if (dataAgeMin === null) feedTier = 'unknown';
    else if (dataAgeMin <= 12) feedTier = 'healthy';
    else if (dataAgeMin <= 20) feedTier = 'lagging';
    else feedTier = 'stale';
    const auditRowsLast24h = await dbQuery2(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE created_at >= NOW() - INTERVAL '24 hours'`,
    )
      .then((r) => r.rows[0]?.n ?? 0)
      .catch(() => 0);
    extra = {
      lastIngestion: latestProduct?.toISOString() || null,
      dataAgeMinutes: dataAgeMin,
      // feedHealthy keeps its historical meaning: "the risk engine can still
      // determine risk" (< 25 min stale before the engine flips DEGRADED).
      feedHealthy: dataAgeMin !== null && dataAgeMin < 25,
      feedTier,
      collector: collectorHb,
      locationCount: locationCountRow.rows[0]?.n ?? 0,
      recentEvaluations: recentRiskStates.length,
      flashCount: flashCountRow.rows[0]?.n ?? 0,
      websocketConnections: wsManager.getStats().connectedClients,
      notifiers: getNotifierCapabilities(),
      auditRowsLast24h,
    };
  } catch (err) {
    // Enrichment is best-effort: the DB ping above is the real health
    // signal. We still log so a degraded-but-up DB is visible in alerts.
    logger.warn('Health check enrichment failed', { error: (err as Error).message });
  }

  return {
    status: 'ok',
    db: true,
    mode: hasCredentials() ? 'live-eumetsat' : 'in-memory-mock',
    serverTime: new Date().toISOString(),
    ...extra,
  };
}

app.get('/api/health', async (_req, res) => {
  try {
    const now = Date.now();
    if (healthCache && healthCache.expiresAt > now) {
      // Serve cached body, but always update serverTime so consumers can
      // tell when this snapshot was last refreshed (cache hit vs cache miss).
      res.setHeader('X-Health-Cache', 'hit');
      res.json({ ...healthCache.body, serverTime: new Date().toISOString() });
      return;
    }
    const body = await computeHealth();
    healthCache = { body, expiresAt: now + HEALTH_CACHE_TTL_MS };
    res.setHeader('X-Health-Cache', 'miss');
    res.json(body);
  } catch (error) {
    // Don't cache errors — a transient blip should clear immediately.
    healthCache = null;
    logger.error('Health check failed', { error: (error as Error).message });
    res.status(500).json({
      status: 'error',
      error: 'Health check failed',
      db: false,
    });
  }
});

app.get('/api/health/feed', async (_req, res) => {
  try {
    const { query: dbQuery } = await import('./db');
    await dbQuery('SELECT 1');
    const latestProduct = await getLatestIngestionTime();
    const dataAgeMin = latestProduct
      ? Math.floor((Date.now() - latestProduct.getTime()) / 60000)
      : null;
    const feedHealthy = dataAgeMin !== null && dataAgeMin < 25;
    const status = feedHealthy ? 'ok' : 'degraded';
    res.status(feedHealthy ? 200 : 503).json({
      status,
      feedHealthy,
      dataAgeMinutes: dataAgeMin,
      lastIngestion: latestProduct?.toISOString() || null,
      threshold_min: 25,
    });
  } catch (error) {
    // Public endpoint — log the detail, return a stable string to the client.
    logger.warn('Feed health check failed', { error: (error as Error).message });
    res.status(503).json({
      status: 'error',
      feedHealthy: false,
      error: 'Feed health check unavailable',
    });
  }
});

// Twilio sends signed status callbacks. Without signature verification the
// endpoint will accept any POST that names a known MessageSid — an attacker
// could mark every pending SMS as "delivered" or "undelivered" and ruin our
// escalation logic. Verify X-Twilio-Signature against the configured Auth
// Token; reject anything that doesn't match. In dev (no TWILIO_AUTH_TOKEN
// set) we log a warning and accept, so local testing without a Twilio
// account isn't blocked.
function verifyTwilioSignature(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('Twilio webhook received but TWILIO_AUTH_TOKEN not configured — rejecting');
      res.status(503).json({ error: 'Webhook signing not configured' });
      return;
    }
    logger.warn('Twilio webhook accepted unsigned (dev mode, TWILIO_AUTH_TOKEN unset)');
    return next();
  }
  const signature = req.header('x-twilio-signature');
  if (!signature) {
    logger.warn('Twilio webhook rejected — missing X-Twilio-Signature', { ip: req.ip });
    res.status(403).json({ error: 'Missing signature' });
    return;
  }
  // Reconstruct the full URL Twilio used to configure the webhook. Fly sits
  // behind a TLS-terminating LB, so trust X-Forwarded-Proto/Host (Express's
  // `trust proxy` is already set above).
  const proto = req.header('x-forwarded-proto') ?? req.protocol;
  const host = req.header('x-forwarded-host') ?? req.get('host') ?? '';
  const url = `${proto}://${host}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, unknown>;
  const valid = twilioPkg.validateRequest(authToken, signature, url, params);
  if (!valid) {
    logger.warn('Twilio webhook rejected — invalid signature', { ip: req.ip, url });
    res.status(403).json({ error: 'Invalid signature' });
    return;
  }
  next();
}

app.post(
  '/api/webhooks/twilio-status',
  express.urlencoded({ extended: false }),
  verifyTwilioSignature,
  async (req, res) => {
    try {
      const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body;
      if (MessageSid && MessageStatus) {
        const error = ErrorCode ? `${ErrorCode}${ErrorMessage ? ': ' + ErrorMessage : ''}` : null;
        await updateAlertStatus(MessageSid, MessageStatus, error);
        logger.info('Twilio status callback', { MessageSid, MessageStatus, ErrorCode });
      }
      res.sendStatus(204);
    } catch (err) {
      logger.error('Twilio status webhook error', { error: (err as Error).message });
      res.sendStatus(500);
    }
  },
);

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const result = await login(email, password);
  if (!result) {
    // Audit failed login so attempts are visible alongside successful ones in
    // the same place admins look. target_id is the attempted email (the user
    // may not exist); actor is the email itself, since there is no
    // authenticated principal yet.
    await logAudit({
      req,
      actor: { id: null, email: typeof email === 'string' ? email : 'unknown', role: 'anonymous' },
      action: 'user.login_failed',
      target_type: 'user',
      target_id: typeof email === 'string' ? email : null,
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  await logAudit({
    req,
    actor: { id: result.user.id, email: result.user.email, role: result.user.role },
    action: 'user.login',
    target_type: 'user',
    target_id: result.user.id,
    target_org_id: result.user.org_id,
  });

  // Issue the httpOnly auth cookie + the CSRF cookie. Browsers should use
  // these from now on; the response body still carries the JWT for legacy
  // / programmatic callers (tests, mobile, server-to-server). The SPA is
  // expected to drop the body token and rely on the cookie.
  const csrf = generateCsrfToken();
  setAuthCookies(res, result.token, csrf);
  res.json({ ...result, csrfToken: csrf });
});

// Issue (or refresh) just the CSRF token without re-issuing the auth cookie.
// Used by the SPA on app mount: the auth cookie is httpOnly so JS can't
// confirm it's still valid, but a successful /api/auth/csrf call against an
// authenticated session returns a fresh CSRF token AND tells the SPA the
// session is still good. Anonymous calls return 401.
app.get('/api/auth/csrf', authenticate, (req, res) => {
  const csrf = generateCsrfToken();
  // We re-set ONLY the CSRF cookie; the auth cookie already exists and is
  // not refreshed here (no JWT roll). The token is also returned in the
  // JSON body so the SPA doesn't have to read document.cookie.
  res.cookie(CSRF_COOKIE, csrf, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
    path: '/',
  });
  res.json({ csrfToken: csrf });
});

app.post('/api/auth/logout', (req, res) => {
  // Stateless logout: drop both cookies. No DB call — JWT revocation is
  // out of scope for this round (tracked under "auth-cache invalidation
  // across machines" in TASKS.md). Browsers stop sending the cookie; any
  // copy of the JWT outside the browser stays valid until expiry.
  clearAuthCookies(res);
  res.status(204).end();
});

// ============================================================
// Protected endpoints
// ============================================================

// Public — no authentication. Tokenised one-tap ack from delivered messages.
app.use(publicAckRoutes);

// -- Users --
app.use('/api/users', userRoutes);

// -- Organisations & Invites --
app.use('/api/orgs', orgRoutes);

// -- Locations CRUD — extracted to locationRoutes.ts --
app.use(locationRoutes);

// -- Settings (per-org + platform) + Test Email — extracted to settingsRoutes.ts --
app.use(settingsRoutes);

// -- Location Recipients (CRUD + OTP + Test) — extracted to recipientRoutes.ts --
app.use(recipientRoutes);

// -- Platform overview + audit + onboarding — extracted to platformRoutes.ts --
app.use(platformRoutes);

// -- Status + Flashes + Replay (read-only viewer) — extracted to statusRoutes.ts --
app.use(statusRoutes);

// -- Alerts list + ack (single, bulk, undo) — extracted to alertRoutes.ts --
app.use(alertRoutes);

// ============================================================
// Serve React frontend in production (static files from client build)
// ============================================================
const clientDistPath = path.resolve(__dirname, '..', 'client', 'dist');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(clientDistPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// ============================================================
// Graceful shutdown
// ============================================================

const gracefulShutdown = (signal: string) => {
  logger.info(`Received ${signal}, starting graceful shutdown`);

  // Stop background jobs first so they can't fire mid-shutdown
  stopLeaderJobs().catch(() => {
    /* best effort */
  });

  server.close(() => {
    logger.info('HTTP server closed');

    // Close WebSocket server
    wsManager.shutdown();

    // Release advisory lock if we held it
    releaseLeaderLock().catch(() => {
      /* ignore */
    });

    // Close database connections
    const { pool } = require('./db');
    pool.end(() => {
      logger.info('Database pool closed');
      process.exit(0);
    });
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================================
// Start server + risk engine
// ============================================================

// Stop all leader-only background work. Called from gracefulShutdown and from
// startLeaderElection's onDemoted hook (when the leader's PG connection drops
// and we revert to follower instead of process.exit(1)).
async function stopLeaderJobs(): Promise<void> {
  if (escalationInterval) {
    clearInterval(escalationInterval);
    escalationInterval = null;
  }
  if (retentionInterval) {
    clearInterval(retentionInterval);
    retentionInterval = null;
  }
  try {
    const { stopRiskEngine } = require('./riskEngine');
    stopRiskEngine();
  } catch {
    /* not started */
  }
  try {
    const { stopLiveIngestion } = require('./eumetsatService');
    if (typeof stopLiveIngestion === 'function') stopLiveIngestion();
  } catch {
    /* not started */
  }
  try {
    const { stopFlashSimulation } = require('./dev/mockData');
    if (typeof stopFlashSimulation === 'function') stopFlashSimulation();
  } catch {
    /* not started; in production builds dev/mockData may be excluded entirely */
  }
  logger.info('Leader-only jobs stopped (demoted or shutting down)');
}

// Leader-only background work. Runs on whichever machine wins the advisory lock.
async function startLeaderJobs(): Promise<void> {
  const riskIntervalSec = parseInt(process.env.RISK_ENGINE_INTERVAL_SEC || '60');
  startRiskEngine(riskIntervalSec);

  if (liveMode) {
    const ingestionIntervalSec = parseInt(process.env.INGESTION_INTERVAL_SEC || '120');
    const started = await startLiveIngestion(ingestionIntervalSec);
    if (!started) {
      logger.warn('Live ingestion failed, falling back to simulation');
      // startFlashSimulation lives in ./dev/mockData. Earlier this required
      // from './eumetsatService' which didn't export it — silently undefined,
      // and any actual fallback would have thrown at the call site.
      const { startFlashSimulation } = require('./dev/mockData');
      startFlashSimulation(15000);
    }
  } else {
    logger.warn('EUMETSAT credentials not set — using simulated flash data');
    logger.info('Set EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET in .env for live data');
    const { startFlashSimulation } = require('./dev/mockData');
    startFlashSimulation(15000);
  }

  // Check for unacknowledged alerts every 2 minutes
  escalationInterval = setInterval(async () => {
    await checkEscalations();
  }, 120_000);

  // Data retention: purge old rows every 6 hours
  const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || '30');
  const orgGraceDays = parseInt(process.env.ORG_HARD_DELETE_DAYS || '30');
  // POPIA-friendly window: scrub PII from alerts that are old enough to no
  // longer be operationally useful but still kept for audit. Keeps state/time
  // for compliance, removes the email/phone/twilio_sid identifying tuple.
  const piiScrubDays = parseInt(process.env.ALERT_PII_SCRUB_DAYS || '7');
  // Audit log has its own floor independent of DATA_RETENTION_DAYS. The
  // audit table records who took which action — alert acknowledgements,
  // role/permission changes, location edits, recipient changes. Two
  // reasons it can't be tuned below 90 days:
  //   1. Incident reconstruction. STOP/PREPARE state changes can drive
  //      operational decisions (closing a mine shaft, evacuating a site).
  //      If a regulator or insurer asks "who acked the 14:32 alert at
  //      Rustenburg three months ago?" we have to answer.
  //   2. POPIA / compliance. The audit log is the trail of *processing*
  //      activities (vs. the alerts table which holds PII). Scrubbing
  //      it too aggressively removes the legal-basis evidence for the
  //      alerts we sent.
  // If you need to lower this floor, do it deliberately: change the
  // constant, document the regulatory basis, and note the change in
  // docs/OPERATIONS.md → Audit log retention. Don't tune it down to
  // shrink DB size — flash_events + risk_states dominate row count.
  const auditRetentionDays = Math.max(retentionDays, 90);
  const runRetention = async () => {
    // All-or-nothing. Without a transaction, a mid-loop crash leaves the DB
    // in a half-purged state — flash_events deleted, risk_states still around
    // — and the next run (6h later) re-deletes the same time window without
    // ever realising the previous run failed. The transaction means either
    // every DELETE/UPDATE commits together or none of them do, so the next
    // run has a coherent starting point.
    const { pool } = await import('./db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r1 = await client.query(
        `DELETE FROM flash_events WHERE flash_time_utc < NOW() - ($1 || ' days')::interval`,
        [retentionDays.toString()],
      );
      const r2 = await client.query(
        `DELETE FROM risk_states WHERE evaluated_at < NOW() - ($1 || ' days')::interval`,
        [retentionDays.toString()],
      );
      const r3a = await client.query(
        `UPDATE alerts
            SET recipient = 'redacted',
                twilio_sid = NULL,
                error = NULL
          WHERE sent_at < NOW() - ($1 || ' days')::interval
            AND recipient IS DISTINCT FROM 'redacted'`,
        [piiScrubDays.toString()],
      );
      const r3 = await client.query(
        `DELETE FROM alerts WHERE sent_at < NOW() - ($1 || ' days')::interval`,
        [retentionDays.toString()],
      );
      const r4 = await client.query(
        `DELETE FROM organisations
         WHERE deleted_at IS NOT NULL
           AND deleted_at < NOW() - ($1 || ' days')::interval`,
        [orgGraceDays.toString()],
      );
      const r5 = await client.query(
        `DELETE FROM audit_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [auditRetentionDays.toString()],
      );
      // Checkpoint marker. Surfaced in /api/health so an operator can spot a
      // retention job that has silently stopped running.
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('retention_last_completed_at', NOW()::text, NOW())
         ON CONFLICT (key) DO UPDATE SET value = NOW()::text, updated_at = NOW()`,
      );
      await client.query('COMMIT');
      logger.info(
        `Data retention: removed ${r1.rowCount} flash_events, ${r2.rowCount} risk_states, ` +
          `${r3.rowCount} alerts (scrubbed PII on ${r3a.rowCount}), ${r4.rowCount} expired orgs, ` +
          `${r5.rowCount} audit rows`,
      );
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      logger.warn({ err }, 'Data retention job failed — rolled back');
    } finally {
      client.release();
    }
  };
  // First run on boot, then every 6 hours. runRetention has internal try/catch
  // and rolls back on failure, so unhandled rejections cannot escape — but
  // explicitly mark as void so the linter knows we don't intend to wait.
  void runRetention();
  retentionInterval = setInterval(() => void runRetention(), 6 * 60 * 60 * 1000);
}

// Run DB migrations, then attach websockets, then start listening.
// Order matters: clients connecting on the first tick after listen()
// should find both schema and adapter ready.
runMigrations()
  .then(() => wsManager.initialize(server))
  .then(() =>
    server
      .listen(PORT, async () => {
        const modeLabel = liveMode ? 'LIVE EUMETSAT' : 'IN-MEMORY MOCK';

        logger.info(`⚡ FlashAware API running on http://localhost:${PORT}`);
        logger.info(`   Health check: http://localhost:${PORT}/api/health`);
        logger.info(`   Mode: ${modeLabel}`);

        // Surface missing notifier config at boot so a misconfigured deploy is
        // visible in the logs immediately rather than at first STOP.
        validateNotifierConfig(logger);

        // Background jobs are gated behind a Postgres advisory lock so only one
        // machine in the fleet runs them. The HTTP API + websocket runs on every
        // machine regardless. If we lose leadership later (PG connection drops),
        // stopLeaderJobs runs and election polling resumes — the process stays up.
        startLeaderElection(startLeaderJobs, stopLeaderJobs).catch((err: Error) => {
          logger.error('Leader election failed', { error: err.message });
        });
      })
      .on('error', (err: Error) => {
        logger.error('Server failed to start (listen error)', { error: err.message });
        process.exit(1);
      }),
  )
  .catch((err: Error) => {
    logger.error({ err }, 'Startup migration failed — exiting');
    process.exit(1);
  });

export default app;
