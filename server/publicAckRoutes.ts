import { Router, Response } from 'express';
import { getOne, query } from './db';
import { logger } from './logger';
import { logAudit } from './audit';
import { getLocationById } from './queries';

const router = Router();

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
    const row = await getOne<AckLookupRow>(
      `SELECT a.acknowledged_at, a.acknowledged_by,
              a.ack_token_expires_at, a.recipient,
              rs.state, rs.reason,
              l.name AS location_name
         FROM alerts a
         LEFT JOIN risk_states rs ON rs.id = a.state_id
         LEFT JOIN locations l    ON l.id = a.location_id
        WHERE a.ack_token = $1`,
      [req.params.token],
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
      recipient: row.recipient,
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
  try {
    const seed = await getOne<AckSeed>(
      `SELECT state_id, location_id, recipient, ack_token_expires_at
         FROM alerts
        WHERE ack_token = $1`,
      [token],
    );
    if (!seed) return res.status(404).json({ error: 'invalid' });

    const expired = seed.ack_token_expires_at && new Date(seed.ack_token_expires_at) < new Date();
    if (expired) return res.status(410).json({ error: 'expired' });

    // Per-event ack: same state_id + same location_id (belt-and-braces),
    // only rows that are still unacked. Idempotent on retry.
    const r = await query(
      `UPDATE alerts a
          SET acknowledged_at = NOW(),
              acknowledged_by = $1
        WHERE a.state_id = $2
          AND a.location_id = $3
          AND a.acknowledged_at IS NULL
       RETURNING a.id`,
      [`recipient:${seed.recipient}`, seed.state_id, seed.location_id],
    );

    const ackedCount = r.rowCount ?? 0;
    if (ackedCount === 0) {
      // Token was valid but every row was already acked.
      return res.json({ acked: 0, alreadyAcked: true });
    }

    // Audit is best-effort: logAudit swallows its own errors (see audit.ts).
    // We intentionally do NOT wrap the UPDATE + audit in a transaction —
    // a failed audit row should never roll back a successful ack.
    const loc = await getLocationById(seed.location_id);
    await logAudit({
      req,
      actor: { id: null, email: `recipient:${seed.recipient}`, role: 'recipient' },
      action: 'alert.ack',
      target_type: 'alert',
      target_id: `token:${token.slice(0, 8)}…`,
      target_org_id: loc?.org_id ?? null,
      after: { acked_count: ackedCount, via: 'token-link' },
    });

    res.json({ acked: ackedCount });
  } catch (err) {
    logger.error('public ack POST failed', {
      error: (err as Error).message,
      token: token.slice(0, 8),
    });
    res.status(500).json({ error: 'ack failed' });
  }
});

export default router;
