import { describe, it, expect } from 'vitest';

// Pure-logic regression tests for management UI behaviour. Originally lived in
// server/test-mgmt-changes.ts as a hand-rolled runner. The DB-integration half
// of that file moved to server/scripts/integration-smoke.ts (manual run).

interface UserStub { id: string; name: string; }

function navigateEditUser(
  currentIndex: number,
  direction: 'prev' | 'next',
  list: UserStub[]
): { index: number; user: UserStub } | null {
  const newIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
  if (newIndex < 0 || newIndex >= list.length) return null;
  return { index: newIndex, user: list[newIndex] };
}

const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

function canDeleteOrg(id: string): { allowed: boolean; reason?: string } {
  if (id === DEFAULT_ORG_ID) {
    return { allowed: false, reason: 'The default FlashAware organisation cannot be deleted' };
  }
  return { allowed: true };
}

function isDeleteConfirmed(typedName: string, orgName: string): boolean {
  return typedName === orgName;
}

describe('user prev/next navigation', () => {
  const users: UserStub[] = [
    { id: 'u1', name: 'Alice' },
    { id: 'u2', name: 'Bob' },
    { id: 'u3', name: 'Carol' },
  ];

  it('returns null when going prev from the first user', () => {
    expect(navigateEditUser(0, 'prev', users)).toBeNull();
  });

  it('moves forward through the list', () => {
    expect(navigateEditUser(0, 'next', users)).toEqual({ index: 1, user: users[1] });
    expect(navigateEditUser(1, 'next', users)).toEqual({ index: 2, user: users[2] });
  });

  it('returns null when going next from the last user', () => {
    expect(navigateEditUser(2, 'next', users)).toBeNull();
  });

  it('moves backward through the list', () => {
    expect(navigateEditUser(2, 'prev', users)).toEqual({ index: 1, user: users[1] });
    expect(navigateEditUser(1, 'prev', users)).toEqual({ index: 0, user: users[0] });
  });

  it('blocks both directions on a single-user list', () => {
    const single: UserStub[] = [{ id: 'u1', name: 'Solo' }];
    expect(navigateEditUser(0, 'prev', single)).toBeNull();
    expect(navigateEditUser(0, 'next', single)).toBeNull();
  });
});

describe('default org protection', () => {
  it('blocks deletion of the default org', () => {
    const r = canDeleteOrg(DEFAULT_ORG_ID);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/default FlashAware/);
  });

  it('allows deletion of any other org', () => {
    expect(canDeleteOrg('aaaaaaaa-0000-0000-0000-000000000002').allowed).toBe(true);
    expect(canDeleteOrg('12345678-1234-1234-1234-123456789abc').allowed).toBe(true);
  });
});

describe('delete-org confirmation dialog', () => {
  it('confirms only on exact name match', () => {
    expect(isDeleteConfirmed('Test Org', 'Test Org')).toBe(true);
    expect(isDeleteConfirmed('test org', 'Test Org')).toBe(false);
    expect(isDeleteConfirmed('Test', 'Test Org')).toBe(false);
    expect(isDeleteConfirmed('', 'Test Org')).toBe(false);
    expect(isDeleteConfirmed('Test Org ', 'Test Org')).toBe(false);
  });
});
