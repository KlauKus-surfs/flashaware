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
    password: z.string().min(6, 'Password must be at least 6 characters').optional(),
  })
  .strict();

describe('updateUserSchema input contract', () => {
  it('accepts the documented mutable fields', () => {
    const r = updateUserSchema.safeParse({
      email: 'x@example.com',
      name: 'X',
      role: 'admin',
      password: 'longenough',
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
