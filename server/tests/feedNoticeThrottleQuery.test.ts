import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every SQL string passed to db.getOne. Locks in the shape of the
// throttle query so a future refactor can't accidentally widen it (e.g.
// drop the org_id JOIN and start querying across tenants).
const getOneCalls: Array<{ sql: string; params: unknown[] }> = [];

vi.mock('../db', () => ({
  query: vi.fn(),
  getMany: vi.fn(),
  getOne: vi.fn(async (sql: string, params: unknown[]) => {
    getOneCalls.push({ sql, params });
    return null;
  }),
}));

const { hasRecentOrgFeedNotice } = await import('../queries/alerts');

describe('hasRecentOrgFeedNotice', () => {
  beforeEach(() => {
    getOneCalls.length = 0;
  });

  it('joins through locations to scope by org_id', async () => {
    // Regression for the spec: the alerts table has no org_id column;
    // org_id must be derived via locations. Without the JOIN the throttle
    // would key on (alert_type) globally and silence every other tenant
    // after the first one's outage.
    await hasRecentOrgFeedNotice('org-uuid', 'feed-degraded', 60);

    expect(getOneCalls).toHaveLength(1);
    const { sql, params } = getOneCalls[0];
    expect(sql).toMatch(/INNER JOIN locations l/i);
    expect(sql).toMatch(/l\.org_id\s*=\s*\$1/);
    expect(sql).toMatch(/a\.alert_type\s*=\s*\$2/);
    expect(sql).toMatch(/sent_at\s*>=\s*NOW\(\)/);
    expect(params).toEqual(['org-uuid', 'feed-degraded', '60']);
  });

  it('returns false when no row matches', async () => {
    const out = await hasRecentOrgFeedNotice('org', 'feed-recovered', 30);
    expect(out).toBe(false);
  });

  it('passes feed-recovered alert_type through unchanged', async () => {
    await hasRecentOrgFeedNotice('org', 'feed-recovered', 30);
    expect(getOneCalls[0].params).toEqual(['org', 'feed-recovered', '30']);
  });
});
