import { Router, Response } from 'express';
import { getOne } from './db';
import { logger } from './logger';

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
      [req.params.token]
    );
    if (!row) return res.status(404).json({ error: 'invalid' });

    const expired = !!(row.ack_token_expires_at && new Date(row.ack_token_expires_at) < new Date());

    res.json({
      state:          row.state,
      locationName:   row.location_name,
      reason:         row.reason?.reason ?? null,
      expired,
      alreadyAckedAt: row.acknowledged_at,
      alreadyAckedBy: row.acknowledged_by,
      recipient:      row.recipient,
    });
  } catch (err) {
    logger.error('public ack GET failed', { error: (err as Error).message });
    res.status(500).json({ error: 'lookup failed' });
  }
});

export default router;
