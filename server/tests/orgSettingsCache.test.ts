import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track every getMany call so we can assert the cache is actually
// suppressing repeats. The org-settings query is the only getMany the
// module makes, so any call here means a cache miss.
const getManyCalls: Array<{ sql: string; params: unknown[] }> = [];

vi.mock('../db', () => ({
  query: vi.fn(),
  getOne: vi.fn(),
  getMany: vi.fn(async (sql: string, params: unknown[]) => {
    getManyCalls.push({ sql, params });
    // Return a single row so getOrgSettings produces { foo: 'bar' }.
    return [{ key: 'foo', value: 'bar' }];
  }),
}));

const { getOrgSettingsCached, clearOrgSettingsCache, _orgSettingsCacheSize } = await import(
  '../queries/orgs'
);

describe('getOrgSettingsCached', () => {
  beforeEach(() => {
    getManyCalls.length = 0;
    clearOrgSettingsCache();
  });

  it('hits the DB once on cold cache, then serves from memory inside ttl', async () => {
    const a = await getOrgSettingsCached('org-1', 60_000);
    const b = await getOrgSettingsCached('org-1', 60_000);
    const c = await getOrgSettingsCached('org-1', 60_000);
    expect(a).toEqual({ foo: 'bar' });
    expect(b).toEqual({ foo: 'bar' });
    expect(c).toEqual({ foo: 'bar' });
    expect(getManyCalls).toHaveLength(1);
  });

  it('keys cache entries per org_id (no cross-tenant leakage)', async () => {
    await getOrgSettingsCached('org-A', 60_000);
    await getOrgSettingsCached('org-B', 60_000);
    await getOrgSettingsCached('org-A', 60_000);
    await getOrgSettingsCached('org-B', 60_000);
    expect(getManyCalls).toHaveLength(2); // one per distinct org, not four
    expect(_orgSettingsCacheSize()).toBe(2);
  });

  it('refetches after ttl expiry', async () => {
    await getOrgSettingsCached('org-1', 1); // 1ms ttl
    await new Promise((r) => setTimeout(r, 5));
    await getOrgSettingsCached('org-1', 1);
    expect(getManyCalls).toHaveLength(2);
  });

  it('clearOrgSettingsCache(orgId) drops only that org', async () => {
    await getOrgSettingsCached('org-A', 60_000);
    await getOrgSettingsCached('org-B', 60_000);
    expect(_orgSettingsCacheSize()).toBe(2);
    clearOrgSettingsCache('org-A');
    expect(_orgSettingsCacheSize()).toBe(1);
    // Re-read of A must miss; B must hit.
    await getOrgSettingsCached('org-A', 60_000);
    await getOrgSettingsCached('org-B', 60_000);
    expect(getManyCalls).toHaveLength(3); // 2 initial + 1 for org-A re-read
  });

  it('clearOrgSettingsCache() with no arg drops everything', async () => {
    await getOrgSettingsCached('org-A', 60_000);
    await getOrgSettingsCached('org-B', 60_000);
    await getOrgSettingsCached('org-C', 60_000);
    expect(_orgSettingsCacheSize()).toBe(3);
    clearOrgSettingsCache();
    expect(_orgSettingsCacheSize()).toBe(0);
  });
});
