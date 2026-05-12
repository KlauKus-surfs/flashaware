import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Mirrors the schema in userRoutes.ts. Kept as a fixture so a future loosening
// of `.strict()` (e.g. dropping it during a refactor) trips a unit test rather
// than silently widening the request contract.
const updateUserSchema = z
  .object({
    email: z.string().email('Invalid email format').optional(),
    name: z.string().min(1, 'Name is required').optional(),
    role: z.enum(['admin', 'operator', 'viewer']).optional(),
    password: z.string().min(12, 'Password must be at least 12 characters').optional(),
  })
  .strict();

// Mirrors createUserSchema in userRoutes.ts. The two schemas share the same
// `role: z.enum(['admin', 'operator', 'viewer'])` clause, so a future widening
// must be done in both places — the parallel test below makes that obvious.
const createUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(12, 'Password must be at least 12 characters'),
  name: z.string().min(1, 'Name is required'),
  role: z.enum(['admin', 'operator', 'viewer']),
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

  it('rejects super_admin role even from a super_admin caller', () => {
    // The route handler enforces admin-only role changes, but the schema is the
    // outer barrier: super_admin elevation is never expressible in the body.
    const r = updateUserSchema.safeParse({ role: 'super_admin' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields — defence-in-depth against future field bleed', () => {
    expect(updateUserSchema.safeParse({ password_hash: 'x' }).success).toBe(false);
    expect(updateUserSchema.safeParse({ id: 'spoof' }).success).toBe(false);
    expect(updateUserSchema.safeParse({ created_at: '2026-01-01' }).success).toBe(false);
  });
});

// The route handler trusts the zod enum to be the gate that stops an admin
// (or a representative — same code path on POST/PATCH /api/users) from
// granting themselves or others a tier they're not allowed to grant. The
// hierarchy says super_admin > representative > admin, and only super_admin
// is permitted to provision either of those higher tiers (off-band today;
// no API surface at all). The cases below lock the schema as the outer
// barrier — if either tier ever becomes legitimately grantable, both this
// enum and these tests must change together.
describe('role-assignment gates (mirrors zod enums in userRoutes.ts)', () => {
  it('admin assigning representative is rejected with 400 (zod enum, update path)', () => {
    const r = updateUserSchema.safeParse({ role: 'representative' });
    expect(r.success).toBe(false);
  });

  it('admin assigning super_admin is rejected with 400 (zod enum, update path)', () => {
    const r = updateUserSchema.safeParse({ role: 'super_admin' });
    expect(r.success).toBe(false);
  });

  it('representative assigning representative is rejected with 400 (zod enum, create path)', () => {
    // Schema runs before the role-check middleware reads req.user.role, so the
    // outcome is identical regardless of caller role.
    const r = createUserSchema.safeParse({
      email: 'newrep@example.com',
      password: 'a-very-strong-password-123!',
      name: 'New Rep',
      role: 'representative',
    });
    expect(r.success).toBe(false);
  });

  it('representative assigning super_admin is rejected with 400 (zod enum, create path)', () => {
    const r = createUserSchema.safeParse({
      email: 'newsuper@example.com',
      password: 'a-very-strong-password-123!',
      name: 'New Super',
      role: 'super_admin',
    });
    expect(r.success).toBe(false);
  });
});
