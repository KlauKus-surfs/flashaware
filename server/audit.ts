import { query } from './db';
import { logger } from './logger';
import { AuthRequest } from './auth';

// Centralised audit log. Every mutation funnels through logAudit() so we have a
// durable "who did what to whom" trail. Reads (including super_admin
// cross-org browsing) are intentionally NOT logged here — too noisy. If that
// changes later, add a separate table or sample these.

// Action vocabulary. Keep stable: existing rows reference these strings.
export type AuditAction =
  | 'location.create'
  | 'location.update'
  | 'location.delete'
  | 'recipient.create'
  | 'recipient.update'
  | 'recipient.delete'
  | 'recipient.otp_send'
  | 'recipient.phone_verify'
  | 'settings.update'
  | 'platform_settings.update'
  | 'org.create'
  | 'org.delete'
  | 'org.restore'
  | 'invite.create'
  | 'invite.use'
  | 'invite.revoke'
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'user.password_reset'
  | 'user.password_reset_request'
  | 'user.password_reset_complete'
  | 'user.login'
  | 'user.login_failed'
  | 'alert.ack'
  | 'alert.test_email'
  | 'alert.test_send';

export type AuditTargetType =
  | 'location'
  | 'recipient'
  | 'org'
  | 'user'
  | 'invite'
  | 'settings'
  | 'platform_settings'
  | 'alert';

export interface LogAuditOpts {
  req?: AuthRequest;
  // Override actor when there's no authenticated request yet (e.g. login
  // success: req.user is set after auth, so this is rarely needed).
  actor?: { id: string | null; email: string; role: string };
  action: AuditAction;
  target_type: AuditTargetType;
  target_id?: string | number | null;
  target_org_id?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

// Audit-write failure counter. Increments on every swallowed insert error so
// /api/health can surface "audit subsystem broken" without us having to scrape
// logs. Reset to 0 after a successful insert: a single transient blip
// shouldn't show up forever. Best-effort exposure — health enrichment reads
// it; if anyone wants to alert on it they can.
let auditWriteFailures = 0;
let auditWritesSinceFailure = 0;
export function getAuditFailureStats(): {
  consecutiveFailures: number;
  successesSinceLastFailure: number;
} {
  return {
    consecutiveFailures: auditWriteFailures,
    successesSinceLastFailure: auditWritesSinceFailure,
  };
}

/**
 * Insert one audit row. Best-effort: if logging fails we swallow the error
 * so the underlying mutation doesn't roll back. Failures are surfaced in the
 * server log so we notice if audit insertion goes broken.
 */
export async function logAudit(opts: LogAuditOpts): Promise<void> {
  try {
    const actor =
      opts.actor ??
      (opts.req?.user
        ? { id: opts.req.user.id, email: opts.req.user.email, role: opts.req.user.role }
        : { id: null, email: 'system', role: 'system' });

    const ip = opts.req?.ip ?? null;
    const ua = opts.req?.get?.('User-Agent') ?? null;

    await query(
      `INSERT INTO audit_log
        (actor_user_id, actor_email, actor_role, action, target_type, target_id,
         target_org_id, "before", "after", ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        actor.id,
        actor.email,
        actor.role,
        opts.action,
        opts.target_type,
        opts.target_id !== undefined && opts.target_id !== null ? String(opts.target_id) : null,
        opts.target_org_id ?? null,
        opts.before ? JSON.stringify(opts.before) : null,
        opts.after ? JSON.stringify(opts.after) : null,
        ip,
        ua,
      ],
    );
    auditWriteFailures = 0;
    auditWritesSinceFailure++;
  } catch (err) {
    auditWriteFailures++;
    auditWritesSinceFailure = 0;
    logger.error('Audit log insert failed', {
      action: opts.action,
      target_type: opts.target_type,
      target_id: opts.target_id,
      consecutiveFailures: auditWriteFailures,
      error: (err as Error).message,
    });
  }
}

export interface AuditQueryFilters {
  org_id?: string; // when set, restrict to this org (or NULL targets if include_global)
  actor_user_id?: string;
  actor_email?: string; // case-insensitive substring match
  action?: string; // exact match
  action_prefix?: string; // matches LIKE 'prefix%'
  target_type?: string;
  target_id?: string; // exact match
  since?: string; // ISO timestamp
  until?: string; // ISO timestamp
  limit?: number;
  offset?: number;
}

export interface AuditRow {
  id: number;
  actor_user_id: string | null;
  actor_email: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string | null;
  target_org_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  // Joined for display:
  org_name?: string | null;
}

/**
 * Read audit rows with optional filtering. Caller is responsible for
 * authorisation (super_admin sees all; admin should pass org_id = their org).
 */
export async function getAuditRows(filters: AuditQueryFilters): Promise<AuditRow[]> {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.org_id) {
    conditions.push(`a.target_org_id = $${params.length + 1}`);
    params.push(filters.org_id);
  }
  if (filters.actor_user_id) {
    conditions.push(`a.actor_user_id = $${params.length + 1}`);
    params.push(filters.actor_user_id);
  }
  if (filters.actor_email) {
    conditions.push(`a.actor_email ILIKE $${params.length + 1}`);
    params.push(`%${filters.actor_email}%`);
  }
  if (filters.action) {
    conditions.push(`a.action = $${params.length + 1}`);
    params.push(filters.action);
  } else if (filters.action_prefix) {
    conditions.push(`a.action LIKE $${params.length + 1}`);
    params.push(filters.action_prefix + '%');
  }
  if (filters.target_type) {
    conditions.push(`a.target_type = $${params.length + 1}`);
    params.push(filters.target_type);
  }
  if (filters.target_id) {
    conditions.push(`a.target_id = $${params.length + 1}`);
    params.push(filters.target_id);
  }
  if (filters.since) {
    conditions.push(`a.created_at >= $${params.length + 1}`);
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push(`a.created_at <= $${params.length + 1}`);
    params.push(filters.until);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const result = await query(
    `SELECT a.*, o.name AS org_name
     FROM audit_log a
     LEFT JOIN organisations o ON o.id = a.target_org_id
     ${whereClause}
     ORDER BY a.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return result.rows;
}
