import { describe, it, expect, vi } from 'vitest';

// auth.ts validates JWT_SECRET at import time, so set it before importing the
// module under test (matching the convention used in authLogin.test.ts).
process.env.JWT_SECRET = 'test-secret-for-unit-tests-only';

const { resolveOrgScope, canAccessLocation } = await import('../authScope');
const { requireRole } = await import('../auth');

// Minimal stand-in for an Express AuthRequest. Only the fields these helpers
// actually read are populated — keeping the stub small means a regression that
// adds a new dependency on req surfaces as a test-side type/runtime error.
function makeReq(opts: {
  role: 'super_admin' | 'representative' | 'admin' | 'operator' | 'viewer';
  org_id?: string;
  query?: Record<string, string>;
}): any {
  return {
    user: {
      id: 'u-1',
      email: 'test@example.com',
      name: 'Test User',
      role: opts.role,
      org_id: opts.org_id ?? 'caller-org',
    },
    query: opts.query ?? {},
    ip: '127.0.0.1',
    get: () => undefined,
  };
}

describe('resolveOrgScope()', () => {
  it('locks a non-super to their own org when no ?org_id= is provided', () => {
    const result = resolveOrgScope(makeReq({ role: 'admin', org_id: 'org-A' }));
    expect(result).toEqual({ ok: true, orgId: 'org-A' });
  });

  it('returns undefined orgId for super_admin without ?org_id= (cross-org view)', () => {
    const result = resolveOrgScope(makeReq({ role: 'super_admin' }));
    expect(result).toEqual({ ok: true, orgId: undefined });
  });

  it('honours ?org_id= for super_admin when the UUID is well-formed', () => {
    const otherOrg = '11111111-2222-3333-4444-555555555555';
    const result = resolveOrgScope(
      makeReq({
        role: 'super_admin',
        query: { org_id: otherOrg },
      }),
    );
    expect(result).toEqual({ ok: true, orgId: otherOrg });
  });

  it('rejects ?org_id= from a non-super with 403 (no silent re-route to own org)', () => {
    const otherOrg = '11111111-2222-3333-4444-555555555555';
    const result = resolveOrgScope(
      makeReq({
        role: 'admin',
        org_id: 'org-A',
        query: { org_id: otherOrg },
      }),
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'org_id is only allowed for super_admin or representative',
    });
  });

  it('rejects malformed ?org_id= even from super_admin with 400', () => {
    const result = resolveOrgScope(
      makeReq({
        role: 'super_admin',
        query: { org_id: 'not-a-uuid' },
      }),
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'org_id must be a valid UUID',
    });
  });

  it('also rejects ?org_id= from operator and viewer (full non-super coverage)', () => {
    for (const role of ['operator', 'viewer'] as const) {
      const result = resolveOrgScope(
        makeReq({
          role,
          org_id: 'org-A',
          query: { org_id: '11111111-2222-3333-4444-555555555555' },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(403);
    }
  });
});

describe('canAccessLocation()', () => {
  const sameOrg = { org_id: 'org-A' };
  const otherOrg = { org_id: 'org-B' };
  const adminA = { role: 'admin', org_id: 'org-A' };
  const viewerA = { role: 'viewer', org_id: 'org-A' };
  const superAny = { role: 'super_admin', org_id: 'org-S' };

  it('returns true when the location belongs to the caller’s own org', () => {
    expect(canAccessLocation(sameOrg, adminA)).toBe(true);
    expect(canAccessLocation(sameOrg, viewerA)).toBe(true);
  });

  it('returns false when the location belongs to a different org', () => {
    expect(canAccessLocation(otherOrg, adminA)).toBe(false);
    expect(canAccessLocation(otherOrg, viewerA)).toBe(false);
  });

  it('returns true for super_admin regardless of location org', () => {
    expect(canAccessLocation(sameOrg, superAny)).toBe(true);
    expect(canAccessLocation(otherOrg, superAny)).toBe(true);
  });

  it('returns false for a missing location row (so callers can 404 cleanly)', () => {
    expect(canAccessLocation(null, adminA)).toBe(false);
    expect(canAccessLocation(undefined, adminA)).toBe(false);
    // super_admin still can't see what doesn't exist
    expect(canAccessLocation(null, superAny)).toBe(false);
  });
});

describe('requireRole() hierarchy', () => {
  // The hierarchy from auth.ts:211 — super_admin=4 > admin=3 > operator=2 > viewer=1.
  // Each test case is "user role" → can they pass requireRole(target)?
  type Role = 'super_admin' | 'admin' | 'operator' | 'viewer';

  function runMiddleware(userRole: Role | undefined, requiredRole: string) {
    const req: any = userRole
      ? {
          user: { id: 'u-1', email: 'x@y.z', role: userRole, org_id: 'org-1' },
          ip: '127.0.0.1',
          get: () => undefined,
        }
      : { ip: '127.0.0.1', get: () => undefined };
    let statusCode: number | undefined;
    let body: any;
    const res: any = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(payload: any) {
        body = payload;
        return res;
      },
    };
    const next = vi.fn();
    requireRole(requiredRole)(req, res, next);
    return { statusCode, body, nextCalled: next.mock.calls.length === 1 };
  }

  it('rejects an unauthenticated request with 401', () => {
    const r = runMiddleware(undefined, 'viewer');
    expect(r.statusCode).toBe(401);
    expect(r.body).toEqual({ error: 'Not authenticated' });
    expect(r.nextCalled).toBe(false);
  });

  const cases: Array<[Role, string, 'pass' | 'block']> = [
    // viewer-only gate
    ['viewer', 'viewer', 'pass'],
    ['operator', 'viewer', 'pass'],
    ['admin', 'viewer', 'pass'],
    ['super_admin', 'viewer', 'pass'],
    // operator-only gate
    ['viewer', 'operator', 'block'],
    ['operator', 'operator', 'pass'],
    ['admin', 'operator', 'pass'],
    ['super_admin', 'operator', 'pass'],
    // admin-only gate
    ['viewer', 'admin', 'block'],
    ['operator', 'admin', 'block'],
    ['admin', 'admin', 'pass'],
    ['super_admin', 'admin', 'pass'],
    // super_admin-only gate
    ['viewer', 'super_admin', 'block'],
    ['operator', 'super_admin', 'block'],
    ['admin', 'super_admin', 'block'],
    ['super_admin', 'super_admin', 'pass'],
  ];

  for (const [userRole, requiredRole, outcome] of cases) {
    it(`${userRole} on requireRole('${requiredRole}') ${outcome === 'pass' ? 'passes' : 'is blocked with 403'}`, () => {
      const r = runMiddleware(userRole, requiredRole);
      if (outcome === 'pass') {
        expect(r.nextCalled).toBe(true);
        expect(r.statusCode).toBeUndefined();
      } else {
        expect(r.nextCalled).toBe(false);
        expect(r.statusCode).toBe(403);
        expect(r.body).toEqual({ error: 'Insufficient permissions' });
      }
    });
  }
});
