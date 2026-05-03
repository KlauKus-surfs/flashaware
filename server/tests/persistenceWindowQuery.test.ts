import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every SQL string passed to db.getMany. We don't need a real DB —
// the regression we're locking in is "the persistence-alert query MUST
// exclude the system row", which is a property of the SQL string itself.
const getManyCalls: Array<{ sql: string; params: unknown[] }> = [];

vi.mock('../db', () => ({
  query: vi.fn(),
  getOne: vi.fn(),
  getMany: vi.fn(async (sql: string, params: unknown[]) => {
    getManyCalls.push({ sql, params });
    return [];
  }),
}));

const { getRecentAlertsForLocation } = await import('../queries/alerts');

describe('getRecentAlertsForLocation', () => {
  beforeEach(() => {
    getManyCalls.length = 0;
  });

  it("excludes the system audit row from the persistence window", async () => {
    // Regression for the bug where dispatchAlerts writes a recipient='system'
    // / alert_type='system' row unconditionally — including for locations
    // with zero recipients — and the engine then sees "we sent something
    // recently" and silently suppresses the next persistence-alert tick.
    await getRecentAlertsForLocation('loc-uuid', 10);

    expect(getManyCalls).toHaveLength(1);
    const { sql, params } = getManyCalls[0];
    expect(sql).toMatch(/alert_type\s*<>\s*'system'/);
    expect(sql).toMatch(/location_id\s*=\s*\$1/);
    expect(sql).toMatch(/sent_at\s*>=\s*NOW\(\)/);
    expect(params).toEqual(['loc-uuid', '10']);
  });

  it('passes the minutes argument as a string for the interval cast', async () => {
    await getRecentAlertsForLocation('loc', 5);
    expect(getManyCalls[0].params).toEqual(['loc', '5']);
  });
});
