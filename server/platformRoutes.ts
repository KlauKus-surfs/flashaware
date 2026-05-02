import { Router, Response } from 'express';
import { authenticate, requireRole, AuthRequest } from './auth';
import { resolveOrgScope } from './authScope';
import { getAuditRows } from './audit';
import { logger } from './logger';

const router = Router();

// -- Platform overview (super_admin only) — high-level health for the operator --
router.get(
  '/api/platform/overview',
  authenticate,
  requireRole('super_admin'),
  async (_req: AuthRequest, res: Response) => {
    try {
      const { query: dbQuery } = await import('./db');
      const { amLeader } = await import('./leader');

      // Single round-trip with sub-selects to avoid sequential round-trips.
      const r = await dbQuery(`
        SELECT
          (SELECT COUNT(*)::int FROM organisations WHERE deleted_at IS NULL)                                    AS active_org_count,
          (SELECT COUNT(*)::int FROM organisations WHERE deleted_at IS NOT NULL)                                AS soft_deleted_org_count,
          (SELECT COUNT(*)::int FROM users u INNER JOIN organisations o ON o.id = u.org_id AND o.deleted_at IS NULL) AS active_user_count,
          (SELECT COUNT(*)::int FROM locations l INNER JOIN organisations o ON o.id = l.org_id AND o.deleted_at IS NULL)                          AS total_location_count,
          (SELECT COUNT(*)::int FROM locations l INNER JOIN organisations o ON o.id = l.org_id AND o.deleted_at IS NULL WHERE l.enabled = true)   AS active_location_count,
          (SELECT COUNT(*)::int FROM alerts WHERE sent_at >= NOW() - interval '24 hours')                       AS alerts_last_24h,
          (SELECT COUNT(*)::int FROM alerts WHERE sent_at >= NOW() - interval '24 hours' AND acknowledged_at IS NULL) AS unacked_last_24h,
          (SELECT COUNT(*)::int FROM alerts WHERE sent_at >= NOW() - interval '24 hours' AND escalated = true)  AS escalated_last_24h,
          (SELECT MAX(product_time_end) FROM ingestion_log WHERE qc_status != 'ERROR')                          AS last_ingestion,
          (SELECT COUNT(*)::int FROM flash_events WHERE flash_time_utc >= NOW() - interval '1 hour')            AS flashes_last_hour
      `);
      const row = r.rows[0];

      // Per-org alert counts (top 10 by 24h alert volume).
      const perOrg = await dbQuery(`
        SELECT
          o.id, o.name, o.slug,
          COUNT(DISTINCT l.id) FILTER (WHERE l.enabled = true)::int     AS active_locations,
          COUNT(DISTINCT a.id) FILTER (WHERE a.sent_at >= NOW() - interval '24 hours')::int AS alerts_24h,
          COUNT(DISTINCT a.id) FILTER (WHERE a.sent_at >= NOW() - interval '24 hours' AND a.escalated = true)::int AS escalated_24h
        FROM organisations o
        LEFT JOIN locations l ON l.org_id = o.id
        LEFT JOIN alerts a    ON a.location_id = l.id
        WHERE o.deleted_at IS NULL
        GROUP BY o.id
        ORDER BY alerts_24h DESC, o.name
        LIMIT 10
      `);

      const attention = await dbQuery(`
        SELECT
          o.id, o.name, o.slug,
          COUNT(DISTINCT a.id) FILTER (WHERE a.acknowledged_at IS NULL AND a.sent_at >= NOW() - interval '24 hours')::int AS unacked_24h,
          COUNT(DISTINCT a.id) FILTER (WHERE a.escalated = true AND a.sent_at >= NOW() - interval '24 hours')::int        AS escalated_24h
        FROM organisations o
        LEFT JOIN locations l ON l.org_id = o.id
        LEFT JOIN alerts a    ON a.location_id = l.id
        WHERE o.deleted_at IS NULL
        GROUP BY o.id
        HAVING
          COUNT(DISTINCT a.id) FILTER (WHERE a.acknowledged_at IS NULL AND a.sent_at >= NOW() - interval '24 hours') >= 5
          OR COUNT(DISTINCT a.id) FILTER (WHERE a.escalated = true AND a.sent_at >= NOW() - interval '24 hours') > 0
        ORDER BY unacked_24h DESC, escalated_24h DESC
      `);

      const lastIngestion = row.last_ingestion ? new Date(row.last_ingestion) : null;
      const dataAgeMin = lastIngestion
        ? Math.floor((Date.now() - lastIngestion.getTime()) / 60_000)
        : null;

      res.json({
        orgs: { active: row.active_org_count, soft_deleted: row.soft_deleted_org_count },
        users: { active: row.active_user_count },
        locations: { total: row.total_location_count, active: row.active_location_count },
        alerts_24h: {
          total: row.alerts_last_24h,
          unacked: row.unacked_last_24h,
          escalated: row.escalated_last_24h,
        },
        ingestion: {
          last_ingestion: row.last_ingestion,
          data_age_minutes: dataAgeMin,
          feed_healthy: dataAgeMin !== null && dataAgeMin < 25,
          flashes_last_hour: row.flashes_last_hour,
        },
        leader: {
          am_i_leader: amLeader(),
          machine_id: process.env.FLY_MACHINE_ID || null,
          region: process.env.FLY_REGION || null,
        },
        top_orgs_by_alerts: perOrg.rows,
        needs_attention: attention.rows,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to build platform overview', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to build platform overview' });
    }
  },
);

// -- Audit log (admin sees own org; super_admin sees all or filtered by ?org_id=) --
router.get(
  '/api/audit',
  authenticate,
  requireRole('admin'),
  async (req: AuthRequest, res: Response) => {
    try {
      const scope = resolveOrgScope(req);
      if (!scope.ok) return res.status(scope.status).json({ error: scope.error });

      const rows = await getAuditRows({
        org_id: scope.orgId,
        action: typeof req.query.action === 'string' ? req.query.action : undefined,
        action_prefix:
          typeof req.query.action_prefix === 'string' ? req.query.action_prefix : undefined,
        target_type: typeof req.query.target_type === 'string' ? req.query.target_type : undefined,
        target_id: typeof req.query.target_id === 'string' ? req.query.target_id : undefined,
        actor_user_id:
          typeof req.query.actor_user_id === 'string' ? req.query.actor_user_id : undefined,
        actor_email: typeof req.query.actor_email === 'string' ? req.query.actor_email : undefined,
        since: typeof req.query.since === 'string' ? req.query.since : undefined,
        until: typeof req.query.until === 'string' ? req.query.until : undefined,
        limit: parseInt(req.query.limit as string) || 100,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(rows);
    } catch (error) {
      logger.error('Failed to read audit log', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to read audit log' });
    }
  },
);

// -- Onboarding state -- drives the Dashboard SetupChecklist so a freshly-
// invited admin sees a path forward instead of an empty dashboard.
router.get(
  '/api/onboarding/state',
  authenticate,
  requireRole('viewer'),
  async (req: AuthRequest, res: Response) => {
    try {
      const scope = resolveOrgScope(req);
      if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
      // For super_admin with no scope set we can't compute "are we onboarded yet"
      // because there's no single org. Use their own org as the answer.
      const orgId = scope.orgId ?? req.user!.org_id;
      const { query } = await import('./db');
      const r = await query(
        `SELECT
           (SELECT COUNT(*)::int FROM locations WHERE org_id = $1)                                                 AS location_count,
           (SELECT COUNT(*)::int FROM location_recipients lr
              INNER JOIN locations l ON l.id = lr.location_id
              WHERE l.org_id = $1)                                                                                  AS recipient_count,
           (SELECT COUNT(*)::int FROM location_recipients lr
              INNER JOIN locations l ON l.id = lr.location_id
              WHERE l.org_id = $1 AND lr.phone_verified_at IS NOT NULL)                                             AS verified_recipient_count`,
        [orgId],
      );
      const row = r.rows[0];
      res.json({
        hasLocation: row.location_count > 0,
        hasRecipient: row.recipient_count > 0,
        hasVerifiedPhone: row.verified_recipient_count > 0,
      });
    } catch (error) {
      logger.error('Failed to get onboarding state', { error: (error as Error).message });
      res.status(500).json({ error: 'Failed to get onboarding state' });
    }
  },
);

export default router;
