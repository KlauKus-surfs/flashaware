import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';

// Mock JWT_SECRET before importing auth (auth.ts validates it at import time).
process.env.JWT_SECRET = 'test-secret-for-unit-tests-only';

vi.mock('../queries', () => ({
  findUserByEmail: vi.fn(),
}));

vi.mock('../db', () => ({
  getOne: vi.fn(),
}));

// Re-import after mocks are in place.
const { login } = await import('../auth');
const { findUserByEmail } = await import('../queries');
const { getOne } = await import('../db');

describe('login() org_name enrichment', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns org_name on the AuthUser when the org row has a name', async () => {
    const password = 'hunter2';
    const password_hash = await bcrypt.hash(password, 10);

    (findUserByEmail as any).mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      name: 'Alice',
      role: 'admin',
      org_id: 'org-1',
      password_hash,
    });
    (getOne as any).mockResolvedValue({ name: 'Acme Corp', deleted_at: null });

    const result = await login('a@b.com', password);
    expect(result).not.toBeNull();
    expect(result!.user.org_name).toBe('Acme Corp');
    expect(result!.user.org_id).toBe('org-1');
    expect(result!.token).toBeTypeOf('string');
  });

  it('still rejects login when the org is soft-deleted (org_name change does not regress this gate)', async () => {
    const password = 'hunter2';
    const password_hash = await bcrypt.hash(password, 10);

    (findUserByEmail as any).mockResolvedValue({
      id: 'user-2',
      email: 'a@b.com',
      name: 'Alice',
      role: 'admin',
      org_id: 'org-1',
      password_hash,
    });
    (getOne as any).mockResolvedValue({ name: 'Acme Corp', deleted_at: '2025-01-01T00:00:00Z' });

    const result = await login('a@b.com', password);
    expect(result).toBeNull();
  });

  it('returns null when the user does not exist', async () => {
    (findUserByEmail as any).mockResolvedValue(null);
    const result = await login('nobody@b.com', 'whatever');
    expect(result).toBeNull();
  });
});
