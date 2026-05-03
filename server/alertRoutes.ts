import { Router, Response } from 'express';
import { authenticate, requireRole, AuthRequest } from './auth';
import { resolveOrgScope } from './authScope';
import { logger } from './logger';
import { logAudit } from './audit';

const router = Router();

// -- Alerts list (filtered, paginated) --
router.get(
  '/api/alerts',
  authenticate,
  requireRole('viewer'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { location_id, limit, offset, state, acked, since, until } = req.query;
      const lim = parseInt(limit as string) || 100;
      const off = parseInt(offset as string) || 0;

      // Enrich with location name + org name and risk state. super_admin sees
      // alerts across all orgs by default, or one org via ?org_id=. Everyone
      // else is locked to their own org and forbidden from passing ?org_id=.
      const scope = resolveOrgScope(req);
      if (!scope.ok) return res.status(scope.status).json({ error: scope.error });

      const { query: dbQuery } = await import('./db');
      const conditions: string[] = [];
      const params: any[] = [lim, off];
      if (scope.orgId !== undefined) {
        conditions.push(`l.org_id = $${params.length + 1}`);
        params.push(scope.orgId);
      }
      if (location_id) {
        conditions.push(`a.location_id = $${params.length + 1}`);
        params.push(location_id);
      }
      if (typeof state === 'string' && state.length > 0 && state !== 'all') {
        conditions.push(`rs.state = $${params.length + 1}`);
        params.push(state);
      }
      if (acked === 'unacked') {
        conditions.push(`a.acknowledged_at IS NULL`);
      } else if (acked === 'acked') {
        conditions.push(`a.acknowledged_at IS NOT NULL`);
      }
      if (typeof since === 'string' && since.length > 0) {
        const sinceIso = new Date(since).toISOString();
        conditions.push(`a.sent_at >= $${params.length + 1}`);
        params.push(sinceIso);
      }
      if (typeof until === 'string' && until.length > 0) {
        const untilIso = new Date(until).toISOString();
        conditions.push(`a.sent_at <= $${params.length + 1}`);
        params.push(untilIso);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await dbQuery(
        `SELECT
           a.*,
           l.name AS location_name,
           o.name AS org_name,
           o.slug AS org_slug,
           rs.state,
           rs.reason AS state_reason
         FROM alerts a
         INNER JOIN locations l ON l.id = a.location_id
         LEFT JOIN organisations o ON o.id = l.org_id
         LEFT JOIN risk_states rs ON rs.id = a.state_id
         ${whereClause}
         ORDER BY a.sent_at DESC NULLS LAST
         LIMIT $1 OFFSET $2`,
        params,
      );

      res.json(result.rows);
    } catch (error) {
      logger.error('Failed to get alerts', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to get alerts' });
    }
  },
);

// -- Bulk ack — backfill after handover/recovery --
// Each id is verified against the caller's org before update so a non-super
// can't slip a foreign-org alert id into the array. Super_admin (cross-org by
// design) skips the org check.
router.post(
  '/api/ack/bulk',
  authenticate,
  requireRole('operator'),
  async (req: AuthRequest, res: Response) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
      if (!ids || ids.length === 0) {
        return res.status(400).json({ error: 'ids must be a non-empty array' });
      }
      if (ids.length > 500) {
        return res.status(400).json({ error: 'Cannot acknowledge more than 500 alerts at once' });
      }
      const numericIds = ids
        .map((v: unknown) => parseInt(String(v), 10))
        .filter((n: number) => Number.isFinite(n) && n > 0);
      if (numericIds.length === 0) {
        return res.status(400).json({ error: 'No valid alert ids' });
      }

      const { query: dbQuery } = await import('./db');
      const isSuper = req.user!.role === 'super_admin';
      // RETURN the affected alert's org_id alongside the id so the audit
      // trail can record per-alert tenant context. The previous form
      // collapsed multi-org bulk-acks (only possible for super_admin) into a
      // single audit row with `target_id: 'bulk:N'` — making it impossible
      // to filter the trail by tenant later. One audit row per alert is
      // verbose but recoverable; one row covering N tenants is not.
      const sql = isSuper
        ? `UPDATE alerts a SET acknowledged_at = NOW(), acknowledged_by = $1
           FROM locations l
           WHERE a.id = ANY($2::bigint[]) AND a.acknowledged_at IS NULL
             AND a.location_id = l.id
           RETURNING a.id, a.location_id, l.org_id`
        : `UPDATE alerts a SET acknowledged_at = NOW(), acknowledged_by = $1
           FROM locations l
           WHERE a.id = ANY($2::bigint[]) AND a.acknowledged_at IS NULL
             AND a.location_id = l.id AND l.org_id = $3
           RETURNING a.id, a.location_id, l.org_id`;
      const params = isSuper
        ? [req.user!.email, numericIds]
        : [req.user!.email, numericIds, req.user!.org_id];
      const r = await dbQuery(sql, params);
      const ackedCount = r.rowCount ?? 0;

      if (ackedCount > 0) {
        logger.info('Bulk alert ack', {
          ackedCount,
          requested: numericIds.length,
          by: req.user?.email,
        });
        // One audit row per acknowledged alert. logAudit is best-effort and
        // swallows its own errors (audit.ts) so a partial failure doesn't
        // unwind the ack itself. Awaiting in series keeps the trail in
        // chronological order — the volume cap (500 ids) is small enough
        // that serial inserts are fine.
        for (const row of r.rows as Array<{ id: number; location_id: string; org_id: string }>) {
          await logAudit({
            req,
            action: 'alert.ack',
            target_type: 'alert',
            target_id: String(row.id),
            target_org_id: row.org_id,
            after: { via: 'bulk' },
          });
        }
      }
      res.json({ acked: ackedCount, requested: numericIds.length });
    } catch (error) {
      logger.error('Bulk ack failed', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to acknowledge alerts' });
    }
  },
);

// -- Undo single ack — powers the "Undo" affordance in the ack toast --
router.post(
  '/api/ack/:alertId/undo',
  authenticate,
  requireRole('operator'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { alertId } = req.params;
      const numericId = parseInt(alertId, 10);
      if (!Number.isFinite(numericId) || numericId <= 0) {
        return res.status(400).json({ error: 'Invalid alert id' });
      }
      const { query: dbQuery } = await import('./db');
      const isSuper = req.user!.role === 'super_admin';
      // Always join to locations so we can return the alert's true org_id
      // for the audit row. Previously super_admin's audit row recorded
      // target_org_id: null even when the alert was unambiguously in one
      // tenant, which made the trail filter-by-org incomplete.
      const sql = isSuper
        ? `UPDATE alerts a SET acknowledged_at = NULL, acknowledged_by = NULL
           FROM locations l
           WHERE a.id = $1 AND a.acknowledged_at IS NOT NULL
             AND a.location_id = l.id
           RETURNING a.id, a.location_id, l.org_id`
        : `UPDATE alerts a SET acknowledged_at = NULL, acknowledged_by = NULL
           FROM locations l
           WHERE a.id = $1 AND a.acknowledged_at IS NOT NULL
             AND a.location_id = l.id AND l.org_id = $2
           RETURNING a.id, a.location_id, l.org_id`;
      const params = isSuper ? [numericId] : [numericId, req.user!.org_id];
      const r = await dbQuery(sql, params);
      if ((r.rowCount ?? 0) === 0) {
        return res.status(404).json({ error: 'Alert not found, not acked, or out of scope' });
      }
      const targetOrgId = (r.rows[0] as { org_id: string }).org_id;
      logger.info('Alert ack undone', { alertId: numericId, by: req.user?.email });
      await logAudit({
        req,
        action: 'alert.ack', // re-uses the ack action — surfaces as a paired entry
        target_type: 'alert',
        target_id: alertId,
        target_org_id: targetOrgId,
        after: { undone: true },
      });
      res.json({ ok: true });
    } catch (error) {
      logger.error('Ack undo failed', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to undo acknowledge' });
    }
  },
);

// -- Single ack --
router.post(
  '/api/ack/:alertId',
  authenticate,
  requireRole('operator'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { alertId } = req.params;
      const numericId = parseInt(alertId, 10);
      if (!Number.isFinite(numericId) || numericId <= 0) {
        return res.status(400).json({ error: 'Invalid alert id' });
      }

      // Same org-scoping shape as /api/ack/bulk and /undo — non-super must
      // own the alert via location.org_id join, otherwise an operator in
      // org A could ack a foreign-org alert id and slip a cross-tenant
      // audit row in under their own org. Always RETURN org_id so the
      // audit row records the true tenant even for super_admin actions.
      const { query: dbQuery } = await import('./db');
      const isSuper = req.user!.role === 'super_admin';
      const sql = isSuper
        ? `UPDATE alerts a SET acknowledged_at = NOW(), acknowledged_by = $1
           FROM locations l
           WHERE a.id = $2 AND a.acknowledged_at IS NULL
             AND a.location_id = l.id
           RETURNING a.id, a.location_id, l.org_id`
        : `UPDATE alerts a SET acknowledged_at = NOW(), acknowledged_by = $1
           FROM locations l
           WHERE a.id = $2 AND a.acknowledged_at IS NULL
             AND a.location_id = l.id AND l.org_id = $3
           RETURNING a.id, a.location_id, l.org_id`;
      const params = isSuper
        ? [req.user!.email, numericId]
        : [req.user!.email, numericId, req.user!.org_id];
      const r = await dbQuery(sql, params);

      if ((r.rowCount ?? 0) === 0) {
        return res.status(404).json({ error: 'Alert not found, already acked, or out of scope' });
      }

      const targetOrgId = (r.rows[0] as { org_id: string }).org_id;
      logger.info('Alert acknowledged', { alertId, acknowledgedBy: req.user!.email });
      await logAudit({
        req,
        action: 'alert.ack',
        target_type: 'alert',
        target_id: alertId,
        target_org_id: targetOrgId,
      });

      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to acknowledge alert', {
        error: (error as Error).message,
        alertId: req.params.alertId,
        acknowledgedBy: req.user?.email,
      });
      res.status(500).json({ error: 'Failed to acknowledge alert' });
    }
  },
);

export default router;
