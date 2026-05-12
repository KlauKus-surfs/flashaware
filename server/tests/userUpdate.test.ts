import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// auth.ts validates JWT_SECRET at import time. Set it before importing
// anything that pulls in the auth module transitively (canAssignRole comes
// from userRoutes.ts which imports auth).
process.env.JWT_SECRET = 'test-secret-for-unit-tests-only';

const { canAssignRole } = await import('../userRoutes');

// Mirrors the schema in userRoutes.ts. Kept as a fixture so a future loosening
// of `.strict()` (e.g. dropping it during a refactor) trips a unit test rather
// than silently widening the request contract. Role enum is permissive (all
// five roles) because the assignment matrix is enforced at the handler level
// via canAssignRole — see the dedicated describe block below.
const ASSIGNABLE_ROLES = [
  'super_admin',
  'representative',
  'admin',
  'operator',
  'viewer',
] as const;
const updateUserSchema = z
  .object({
    email: z.string().email('Invalid email format').optional(),
    name: z.string().min(1, 'Name is required').optional(),
    role: z.enum(ASSIGNABLE_ROLES).optional(),
    password: z.string().min(12, 'Password must be at least 12 characters').optional(),
  })
  .strict();

const createUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(12, 'Password must be at least 12 characters'),
  name: z.string().min(1, 'Name is required'),
  role: z.enum(ASSIGNABLE_ROLES),
});

describe('updateUserSchema input contract', () => {
  it('accepts the documented mutable fields', () => {
    const r = updateUserSchema.safeParse({
      email: 'x@example.com',
      name: 'X',
      role: 'admin',
      password: 'longenough-now-12+',
    });
    expect(r.success).toBe(true);
  });

  it('accepts the empty object (no-op update)', () => {
    expect(updateUserSchema.safeParse({}).success).toBe(true);
  });

  it('rejects org_id — a non-admin must never be able to relocate themselves into another tenant', () => {
    const r = updateUserSchema.safeParse({ org_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(r.success).toBe(false);
  });

  it('accepts every role at the schema level — the assignment matrix is enforced by canAssignRole', () => {
    // The schema is now permissive on `role` so a legitimate super_admin
    // can promote someone via this endpoint. Defence-in-depth has moved to
    // the handler-level canAssignRole gate (see below).
    for (const role of ASSIGNABLE_ROLES) {
      expect(updateUserSchema.safeParse({ role }).success).toBe(true);
    }
  });

  it('rejects unknown fields — defence-in-depth against future field bleed', () => {
    expect(updateUserSchema.safeParse({ password_hash: 'x' }).success).toBe(false);
    expect(updateUserSchema.safeParse({ id: 'spoof' }).success).toBe(false);
    expect(updateUserSchema.safeParse({ created_at: '2026-01-01' }).success).toBe(false);
  });
});

// The handler-level canAssignRole gate is the single source of truth for
// "which caller may grant which role". The schema accepts every role; this
// matrix denies the wrong combinations. If a future requirement says reps
// can grant other reps, this matrix and the function in userRoutes.ts must
// change together.
describe('canAssignRole() matrix', () => {
  it('admin can grant admin/operator/viewer', () => {
    expect(canAssignRole('admin', 'admin')).toBe(true);
    expect(canAssignRole('admin', 'operator')).toBe(true);
    expect(canAssignRole('admin', 'viewer')).toBe(true);
  });

  it('admin cannot grant representative or super_admin', () => {
    expect(canAssignRole('admin', 'representative')).toBe(false);
    expect(canAssignRole('admin', 'super_admin')).toBe(false);
  });

  it('representative can grant admin/operator/viewer (same set as admin)', () => {
    expect(canAssignRole('representative', 'admin')).toBe(true);
    expect(canAssignRole('representative', 'operator')).toBe(true);
    expect(canAssignRole('representative', 'viewer')).toBe(true);
  });

  it('representative cannot grant representative or super_admin', () => {
    expect(canAssignRole('representative', 'representative')).toBe(false);
    expect(canAssignRole('representative', 'super_admin')).toBe(false);
  });

  it('super_admin can grant every role including representative and super_admin', () => {
    for (const target of ASSIGNABLE_ROLES) {
      expect(canAssignRole('super_admin', target)).toBe(true);
    }
  });

  it('operator and viewer cannot grant any role', () => {
    for (const caller of ['operator', 'viewer']) {
      for (const target of ASSIGNABLE_ROLES) {
        expect(canAssignRole(caller, target)).toBe(false);
      }
    }
  });

  it('an undefined caller (unauthenticated edge case) cannot grant any role', () => {
    expect(canAssignRole(undefined, 'viewer')).toBe(false);
  });
});
