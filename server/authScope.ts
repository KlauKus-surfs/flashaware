import { AuthRequest } from './auth';
import { UUID_RE } from './validators';

// Pure tenant-scoping helpers, factored out of index.ts so they can be
// unit-tested without booting the full Express app. The two helpers here are
// the central choke-points used across REST handlers — keep them small and
// dependency-free.

/**
 * A "platform-wide" user can read and act across every tenant org.
 * super_admin AND representative both qualify. Used by every cross-org
 * choke point — `resolveOrgScope`, `canAccessLocation`, plus the
 * settings/locations/alerts handlers that previously did
 * `req.user!.role === 'super_admin'` for cross-org behaviour.
 *
 * Platform-SHAPE actions (org create/delete, role-promotion, platform
 * settings mutation) keep using `=== 'super_admin'` directly — those are
 * super_admin-only by design and `isPlatformWideUser` would broaden them
 * incorrectly.
 */
export function isPlatformWideUser(user: { role: string }): boolean {
  return user.role === 'super_admin' || user.role === 'representative';
}

/**
 * Resolve the org scope for a list endpoint:
 *   - non-platform-wide       : always their own org
 *   - platform-wide, no ?org_id=    : undefined (cross-org view)
 *   - platform-wide, ?org_id=<uuid> : that org (single-org view)
 *
 * Returns { ok: false, status, error } if a non-platform-wide user tried to
 * use ?org_id=, or the value is malformed. Callers should res.status(...).
 * json(...) and bail.
 */
export function resolveOrgScope(
  req: AuthRequest,
): { ok: true; orgId: string | undefined } | { ok: false; status: number; error: string } {
  const queryOrg = typeof req.query.org_id === 'string' ? req.query.org_id : undefined;
  if (queryOrg !== undefined) {
    if (!isPlatformWideUser(req.user!)) {
      return {
        ok: false,
        status: 403,
        error: 'org_id is only allowed for super_admin or representative',
      };
    }
    if (!UUID_RE.test(queryOrg)) {
      return { ok: false, status: 400, error: 'org_id must be a valid UUID' };
    }
    return { ok: true, orgId: queryOrg };
  }
  if (isPlatformWideUser(req.user!)) return { ok: true, orgId: undefined };
  return { ok: true, orgId: req.user!.org_id };
}

/**
 * Pure decision: can this user reach this location? Platform-wide users
 * (super_admin, representative) see every tenant; everyone else is locked
 * to their own. Caller is responsible for fetching the location row first
 * (DB side-effect) and translating a `false` into a 404 (we never reveal
 * existence to other tenants).
 */
export function canAccessLocation(
  loc: { org_id: string } | null | undefined,
  user: { role: string; org_id: string },
): boolean {
  if (!loc) return false;
  if (isPlatformWideUser(user)) return true;
  return loc.org_id === user.org_id;
}
