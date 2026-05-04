import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getOne, query } from './db';
import { logger } from './logger';
import { logAudit } from './audit';
import { getLocationById } from './queries';
import { hashAckToken } from './ackToken';

const router = Router();

// Per-IP limiter for the unauthenticated ack endpoints. The token has 192
// bits of entropy so brute-forcing the keyspace isn't realistic, but the
// GET response is also an oracle (state, location name, masked recipient),
// and the global apiRateLimit (1000/15min) is too loose for an
// unauthenticated surface. Tight cap here, separate from the global one.
const publicAckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60, // 60 requests / 15 min / IP — enough for retries, not for scanning
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many ack requests, please slow down' },
  handler: (req, res) => {
    logger.warn('Public ack rate limit exceeded', { ip: req.ip, path: req.path });
    res.status(429).json({ error: 'Too many ack requests, please slow down' });
  },
});

router.use('/api/ack/by-token/:token', publicAckLimiter);

// "alice@example.com" → "a***@example.com". Mirrors the client's maskEmail
// helper so the GET response can never leak a recipient's full address to
// scanners / safelinks / browser prefetch that fetch the URL ahead of the
// human. The actual recipient already has the address in their inbox; we
// don't need to echo it back.
function maskEmail(value: string): string {
  if (!value) return value;
  const at = value.indexOf('@');
  if (at <= 0) return value;
  return `${value.charAt(0)}***${value.slice(at)}`;
}

interface AckLookupRow {
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  ack_token_expires_at: string | null;
  recipient: string;
  state: string | null;
  reason: { reason?: string } | null;
  location_name: string | null;
}

/**
 * GET /api/ack/by-token/:token — read-only validation.
 *
 * Safe for email scanners, Outlook safelinks, browser prefetch, and
 * WhatsApp Business catalog crawlers. Visiting this URL never
 * acknowledges anything — the destructive verb lives on POST below.
 */
router.get('/api/ack/by-token/:token', async (req, res: Response) => {
  try {
    // alerts.ack_token stores the SHA-256 of the plaintext token. The
    // recipient sent us the plaintext via the URL; hash it before lookup.
    // A read-only DB compromise therefore can't surface live tokens.
    const tokenHash = hashAckToken(req.params.token);
    const row = await getOne<AckLookupRow>(
      `SELECT a.acknowledged_at, a.acknowledged_by,
              a.ack_token_expires_at, a.recipient,
              rs.state, rs.reason,
              l.name AS location_name
         FROM alerts a
         LEFT JOIN risk_states rs ON rs.id = a.state_id
         LEFT JOIN locations l    ON l.id = a.location_id
        WHERE a.ack_token = $1`,
      [tokenHash],
    );
    if (!row) return res.status(404).json({ error: 'invalid' });

    const expired = !!(row.ack_token_expires_at && new Date(row.ack_token_expires_at) < new Date());

    res.json({
      state: row.state,
      locationName: row.location_name,
      reason: row.reason?.reason ?? null,
      expired,
      alreadyAckedAt: row.acknowledged_at,
      alreadyAckedBy: row.acknowledged_by,
      // Mask the recipient address. The legitimate recipient already knows
      // their own email; masking only affects link-scanners / preview bots
      // that prefetch the URL out-of-band. Client maskEmail is idempotent
      // on already-masked input, so re-masking on the SPA is harmless.
      recipient: maskEmail(row.recipient),
    });
  } catch (err) {
    logger.error('public ack GET failed', { error: (err as Error).message });
    res.status(500).json({ error: 'lookup failed' });
  }
});

interface AckSeed {
  state_id: number;
  location_id: string;
  recipient: string;
  ack_token_expires_at: string | null;
}

/**
 * POST /api/ack/by-token/:token — destructive, idempotent, per-event scope.
 *
 * Acknowledges every alert row that shares the seed token's `state_id` and
 * is still unacked, in a single UPDATE. Idempotent because of the
 * `WHERE acknowledged_at IS NULL` guard — a second click is a no-op and
 * returns `alreadyAcked: true`.
 *
 * Records an audit row with `actor_role: 'recipient'` so super-admins can
 * filter `actor_email LIKE 'recipient:%'` to see all link-acks.
 */
router.post('/api/ack/by-token/:token', async (req, res: Response) => {
  const token = req.params.token;
  // Hash up-front so both the happy path and the catch handler can log a
  // hash-prefix instead of the plaintext token. hashAckToken is sha256 over
  // a string and cannot itself throw for any well-formed string input, so
  // putting it outside the try is safe.
  const tokenHash = hashAckToken(token);
  try {
    const seed = await getOne<AckSeed>(
      `SELECT state_id, location_id, recipient, ack_token_expires_at
         FROM alerts
        WHERE ack_token = $1`,
      [tokenHash],
    );
    if (!seed) return res.status(404).json({ error: 'invalid' });

    const expired = seed.ack_token_expires_at && new Date(seed.ack_token_expires_at) < new Date();
    if (expired) return res.status(410).json({ error: 'expired' });

    // Per-event ack: same state_id + same location_id (belt-and-braces),
    // only rows that are still unacked. Idempotent on retry. RETURNING
    // includes acknowledged_at so the client can display the server-
    // authoritative timestamp instead of the device's clock — the audit
    // log is keyed off NOW() inside this UPDATE, so any client-side
    // formatSAST(new Date()) on the AckPage would diverge by the
    // request round-trip plus device clock skew.
    // Revoke the ack token on first use. After the UPDATE, ack_token is
    // cleared on every sibling row in this event so:
    //   * the GET oracle stops returning state/recipient for the token
    //   * a stolen forwarded URL cannot be replayed (POST will 404)
    // Idempotency is preserved: the WHERE acknowledged_at IS NULL guard
    // means a second click finds zero unacked rows and returns the
    // "already acked" panel built from the prior-ack lookup below.
    const r = await query(
      `UPDATE alerts a
          SET acknowledged_at = NOW(),
              acknowledged_by = $1,
              ack_token = NULL,
              ack_token_expires_at = NULL
        WHERE a.state_id = $2
          AND a.location_id = $3
          AND a.acknowledged_at IS NULL
       RETURNING a.id, a.acknowledged_at`,
      [`recipient:${seed.recipient}`, seed.state_id, seed.location_id],
    );

    const ackedCount = r.rowCount ?? 0;
    const acknowledgedAt = (r.rows[0]?.acknowledged_at as string | undefined) ?? null;
    if (ackedCount === 0) {
      // Token was valid but every row was already acked. Surface the prior
      // acknowledgement timestamp/actor so the client can render the same
      // "already acked" panel as the GET path. Header lets non-browser
      // callers (curl, monitoring) distinguish a fresh ack from a no-op
      // without inspecting the JSON body.
      const prior = await getOne<{
        acknowledged_at: string | null;
        acknowledged_by: string | null;
      }>(
        `SELECT acknowledged_at, acknowledged_by
           FROM alerts
          WHERE state_id = $1 AND location_id = $2 AND acknowledged_at IS NOT NULL
          ORDER BY acknowledged_at ASC LIMIT 1`,
        [seed.state_id, seed.location_id],
      );
      res.setHeader('X-Ack-State', 'already-acked');
      return res.json({
        acked: 0,
        alreadyAcked: true,
        alreadyAckedAt: prior?.acknowledged_at ?? null,
        alreadyAckedBy: prior?.acknowledged_by ?? null,
      });
    }
    res.setHeader('X-Ack-State', 'fresh');

    // Audit is best-effort: logAudit swallows its own errors (see audit.ts).
    // We intentionally do NOT wrap the UPDATE + audit in a transaction —
    // a failed audit row should never roll back a successful ack.
    const loc = await getLocationById(seed.location_id);
    await logAudit({
      req,
      actor: { id: null, email: `recipient:${seed.recipient}`, role: 'recipient' },
      action: 'alert.ack',
      target_type: 'alert',
      // Audit identifier MUST be derived from the hash, not the plaintext
      // token. The eight-char plaintext slice was a partial-token leak into
      // the audit log — readable by every super-admin reviewing audit
      // activity. The hash prefix is one-way and still distinguishable per
      // event, so it's adequate for log correlation.
      target_id: `tokenhash:${tokenHash.slice(0, 12)}…`,
      target_org_id: loc?.org_id ?? null,
      after: { acked_count: ackedCount, via: 'token-link' },
    });

    res.json({ acked: ackedCount, alreadyAcked: false, acknowledgedAt });
  } catch (err) {
    logger.error('public ack POST failed', {
      error: (err as Error).message,
      // Plaintext slice removed — log lines are also a leak surface. The
      // hash is computed before the try block, so it's always safe to log.
      tokenHash: `${tokenHash.slice(0, 12)}…`,
    });
    res.status(500).json({ error: 'ack failed' });
  }
});

export default router;
