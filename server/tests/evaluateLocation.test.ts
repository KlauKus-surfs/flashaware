import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every DB-fronting function evaluateLocation depends on. Using the
// barrel './queries' is the same path the engine imports from, so the engine
// picks up these stubs without source changes. The seam we're testing is
// exactly this freshness/spatial boundary — the place where the engine
// translates the world-state from PostGIS into a decision input — so
// mocking it is the right level of abstraction.

const mocks = {
  countFlashesInRadius: vi.fn(),
  getNearestFlashDistance: vi.fn(),
  getTimeSinceLastFlashInRadius: vi.fn(),
  getFlashTrend: vi.fn(),
  getLatestIngestionTime: vi.fn(),
  getLatestRiskState: vi.fn(),
  getLastNonDegradedState: vi.fn(),
};

vi.mock('../queries', () => ({
  countFlashesInRadius: (...a: any[]) => mocks.countFlashesInRadius(...a),
  getNearestFlashDistance: (...a: any[]) => mocks.getNearestFlashDistance(...a),
  getTimeSinceLastFlashInRadius: (...a: any[]) => mocks.getTimeSinceLastFlashInRadius(...a),
  getFlashTrend: (...a: any[]) => mocks.getFlashTrend(...a),
  getLatestIngestionTime: (...a: any[]) => mocks.getLatestIngestionTime(...a),
  getLatestRiskState: (...a: any[]) => mocks.getLatestRiskState(...a),
  getLastNonDegradedState: (...a: any[]) => mocks.getLastNonDegradedState(...a),
  // Surface the type re-exports the engine needs at module load. Tests
  // never destructure these.
  getAllLocations: vi.fn(),
  markLocationBootstrapped: vi.fn(),
  addRiskState: vi.fn(),
  getRecentAlertsForLocation: vi.fn(),
}));

vi.mock('../alertService', () => ({
  dispatchAlerts: vi.fn(),
  dispatchFeedHealthNotice: vi.fn(),
}));

vi.mock('../websocket', () => ({
  wsManager: { broadcastRiskStateChange: vi.fn(), broadcastAlertTriggered: vi.fn() },
}));

vi.mock('../db', () => ({
  parseCentroid: () => ({ lng: 28, lat: -26 }),
  query: vi.fn(),
  getOne: vi.fn(),
  getMany: vi.fn(),
}));

const { evaluateLocation } = await import('../riskEngine');

const baseLoc = {
  id: 'loc-1',
  org_id: 'org-1',
  name: 'Test Site',
  site_type: 'mine',
  lat: -26,
  lng: 28,
  stop_radius_km: 10,
  prepare_radius_km: 20,
  stop_flash_threshold: 1,
  stop_window_min: 15,
  prepare_flash_threshold: 1,
  prepare_window_min: 15,
  allclear_wait_min: 30,
  persistence_alert_min: 10,
  alert_on_change_only: false,
  enabled: true,
  bootstrapped_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getFlashTrend.mockResolvedValue({ recent: 0, previous: 0, trend: 'stable' });
  mocks.getLatestRiskState.mockResolvedValue(null);
  mocks.getLastNonDegradedState.mockResolvedValue(null);
});

describe('evaluateLocation: feed-freshness seam', () => {
  it('returns DEGRADED when the pre-fetched ingestion is null', async () => {
    const result = await evaluateLocation(baseLoc, null, new Date('2026-05-03T10:00:00Z'));
    expect(result.newState).toBe('DEGRADED');
    expect(result.isDegraded).toBe(true);
    // Spatial queries must not run when DEGRADED — pure observability win
    // (no wasted PostGIS work) and a guard against a partially-valid
    // configuration ever leaking flash counts into a DEGRADED tick.
    expect(mocks.countFlashesInRadius).not.toHaveBeenCalled();
  });

  it('returns DEGRADED when ingestion is older than 25 min', async () => {
    const now = new Date('2026-05-03T10:00:00Z');
    const stale = new Date(now.getTime() - 26 * 60 * 1000);
    const result = await evaluateLocation(baseLoc, stale, now);
    expect(result.newState).toBe('DEGRADED');
    expect(result.dataAgeSec).toBe(26 * 60);
  });

  it('passes through to spatial queries when ingestion is fresh', async () => {
    const now = new Date('2026-05-03T10:00:00Z');
    const fresh = new Date(now.getTime() - 60 * 1000);
    mocks.countFlashesInRadius.mockResolvedValue(0);
    mocks.getNearestFlashDistance.mockResolvedValue(null);

    const result = await evaluateLocation(baseLoc, fresh, now);
    expect(result.isDegraded).toBe(false);
    expect(result.newState).toBe('ALL_CLEAR');
    // Critical: every spatial query must have been called with the SAME
    // tickNow we passed in. Without this, the engine would call NOW() at
    // PostgreSQL execution time and the freshness math would diverge from
    // the spatial math by however long the per-tick loop has run.
    const passedNow = mocks.countFlashesInRadius.mock.calls[0][3];
    expect(passedNow).toBe(now);
    expect(mocks.getNearestFlashDistance.mock.calls[0][2]).toBe(now);
    expect(mocks.getFlashTrend.mock.calls[0][2]).toBe(now);
  });
});

describe('evaluateLocation: feedJustRecovered handoff', () => {
  it('marks feedJustRecovered when previous tick was DEGRADED but freshness now passes', async () => {
    const now = new Date('2026-05-03T10:00:00Z');
    const fresh = new Date(now.getTime() - 60 * 1000);
    mocks.countFlashesInRadius.mockResolvedValue(0);
    mocks.getNearestFlashDistance.mockResolvedValue(null);
    mocks.getLatestRiskState.mockResolvedValue({ state: 'DEGRADED' });
    mocks.getLastNonDegradedState.mockResolvedValue('STOP');
    mocks.getTimeSinceLastFlashInRadius.mockResolvedValue(null); // no records in lookback

    const result = await evaluateLocation(baseLoc, fresh, now);
    // Without the feedJustRecovered guard this would clear immediately
    // (timeSinceLastFlashMin === null && !isDegraded → ALL_CLEAR). With
    // the guard, the engine MUST stay in HOLD pending a full observation
    // window.
    expect(result.newState).toBe('HOLD');
    expect(result.reason).toMatch(/Feed just recovered/);
  });

  it('honours the standard null shortcut on later ticks (currentState != DEGRADED)', async () => {
    const now = new Date('2026-05-03T10:00:00Z');
    const fresh = new Date(now.getTime() - 60 * 1000);
    mocks.countFlashesInRadius.mockResolvedValue(0);
    mocks.getNearestFlashDistance.mockResolvedValue(null);
    mocks.getLatestRiskState.mockResolvedValue({ state: 'STOP' });
    // No flash history in radius — clearing path.
    mocks.getTimeSinceLastFlashInRadius.mockResolvedValue(null);

    const result = await evaluateLocation(baseLoc, fresh, now);
    expect(result.newState).toBe('ALL_CLEAR');
  });
});

describe('evaluateLocation: ALL_CLEAR-with-stale-data invariant', () => {
  it('never produces ALL_CLEAR when the ingestion timestamp is older than the threshold', async () => {
    const now = new Date('2026-05-03T10:00:00Z');
    // STALE_DATA_THRESHOLD_MIN is 25; the boundary is exclusive (>25 min ago
    // is degraded, exactly 25 min is fresh). Use 26+ to land firmly past the
    // threshold without coupling the test to the boundary's inclusivity.
    const ages = [26, 30, 60, 600]; // minutes — all degraded
    for (const ageMin of ages) {
      const ingested = new Date(now.getTime() - ageMin * 60 * 1000);
      mocks.getLatestRiskState.mockResolvedValueOnce({ state: 'STOP' });
      const result = await evaluateLocation(baseLoc, ingested, now);
      expect(result.newState, `ageMin=${ageMin} produced ${result.newState}`).not.toBe('ALL_CLEAR');
    }
  });
});
