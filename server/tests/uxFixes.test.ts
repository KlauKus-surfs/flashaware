import { describe, it, expect } from 'vitest';

// Pure-logic regression tests for the second UX-pass round. We extract the
// rules into pure functions so we can assert their contracts without
// spinning up the API. The actual endpoints / components glue these into
// the request-response cycle.

// ───────────────────────────────────────────────────────────────────────────
// Feed tier classification (server/index.ts /api/health)
// ───────────────────────────────────────────────────────────────────────────

type FeedTier = 'healthy' | 'lagging' | 'stale' | 'unknown';
function classifyFeedTier(dataAgeMin: number | null): FeedTier {
  if (dataAgeMin === null) return 'unknown';
  if (dataAgeMin <= 3) return 'healthy';
  if (dataAgeMin <= 10) return 'lagging';
  return 'stale';
}

describe('feed tier classification', () => {
  it('null age → unknown', () => {
    expect(classifyFeedTier(null)).toBe('unknown');
  });

  it('0–3 min → healthy', () => {
    expect(classifyFeedTier(0)).toBe('healthy');
    expect(classifyFeedTier(1)).toBe('healthy');
    expect(classifyFeedTier(3)).toBe('healthy');
  });

  it('4–10 min → lagging (the gap that previously read as "Healthy")', () => {
    expect(classifyFeedTier(4)).toBe('lagging');
    expect(classifyFeedTier(7)).toBe('lagging');
    expect(classifyFeedTier(10)).toBe('lagging');
  });

  it('11+ min → stale (the user-reported case at 11 min)', () => {
    expect(classifyFeedTier(11)).toBe('stale');
    expect(classifyFeedTier(24)).toBe('stale');
  });

  it('feedHealthy stays decoupled — < 25 means engine still evaluates', () => {
    // Even at 'stale', the engine tolerates up to 25 min before DEGRADED.
    // feedHealthy = dataAgeMin < 25; feedTier is the UI-facing tiered field.
    const feedHealthy = (m: number) => m < 25;
    expect(feedHealthy(11)).toBe(true);   // stale but engine still working
    expect(feedHealthy(24)).toBe(true);
    expect(feedHealthy(25)).toBe(false);  // engine flips DEGRADED
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Bulk-ack input validation (server/index.ts /api/ack/bulk)
// ───────────────────────────────────────────────────────────────────────────

interface BulkAckValidationResult {
  ok: boolean;
  status?: number;
  error?: string;
  numericIds?: number[];
}
function validateBulkAckInput(body: any): BulkAckValidationResult {
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (!ids || ids.length === 0) {
    return { ok: false, status: 400, error: 'ids must be a non-empty array' };
  }
  if (ids.length > 500) {
    return { ok: false, status: 400, error: 'Cannot acknowledge more than 500 alerts at once' };
  }
  const numericIds = ids
    .map((v: unknown) => parseInt(String(v), 10))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  if (numericIds.length === 0) {
    return { ok: false, status: 400, error: 'No valid alert ids' };
  }
  return { ok: true, numericIds };
}

describe('bulk-ack input validation', () => {
  it('rejects missing body', () => {
    expect(validateBulkAckInput(null).ok).toBe(false);
    expect(validateBulkAckInput({}).status).toBe(400);
    expect(validateBulkAckInput({ ids: null }).ok).toBe(false);
  });

  it('rejects empty array', () => {
    const r = validateBulkAckInput({ ids: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-empty/);
  });

  it('rejects > 500 ids (DoS guard)', () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    const r = validateBulkAckInput({ ids });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/500/);
  });

  it('accepts numeric strings (form-style ids)', () => {
    const r = validateBulkAckInput({ ids: ['1', '2', '3'] });
    expect(r.ok).toBe(true);
    expect(r.numericIds).toEqual([1, 2, 3]);
  });

  it('drops non-positive / non-numeric without failing the whole request', () => {
    const r = validateBulkAckInput({ ids: [1, 'abc', -5, 0, 7] });
    expect(r.ok).toBe(true);
    expect(r.numericIds).toEqual([1, 7]);
  });

  it('rejects when every id is invalid', () => {
    const r = validateBulkAckInput({ ids: ['abc', null, -1, 0] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No valid/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Pre-save guards (LocationEditor)
// ───────────────────────────────────────────────────────────────────────────

const STOP_RADIUS_WARNING_THRESHOLD_KM = 3;
function shouldWarnNarrowStopRadius(stopRadiusKm: number, isDemo: boolean): boolean {
  return !isDemo && stopRadiusKm > 0 && stopRadiusKm < STOP_RADIUS_WARNING_THRESHOLD_KM;
}
function shouldWarnNoRecipients(armed: boolean, hasRecipients: boolean, isDemo: boolean): boolean {
  return armed && !hasRecipients && !isDemo;
}

describe('pre-save guards in LocationEditor', () => {
  it('warns on STOP radius < 3 km for non-demo locations', () => {
    expect(shouldWarnNarrowStopRadius(1, false)).toBe(true);
    expect(shouldWarnNarrowStopRadius(2, false)).toBe(true);
    expect(shouldWarnNarrowStopRadius(2.99, false)).toBe(true);
  });

  it('does not warn at the threshold or above', () => {
    expect(shouldWarnNarrowStopRadius(3, false)).toBe(false);
    expect(shouldWarnNarrowStopRadius(10, false)).toBe(false);
  });

  it('does not warn for demo locations (calibration / power-user use case)', () => {
    expect(shouldWarnNarrowStopRadius(1, true)).toBe(false);
  });

  it('does not warn on zero/negative (separate validation rule)', () => {
    expect(shouldWarnNarrowStopRadius(0, false)).toBe(false);
    expect(shouldWarnNarrowStopRadius(-1, false)).toBe(false);
  });

  it('warns on no-recipients armed save', () => {
    expect(shouldWarnNoRecipients(true, false, false)).toBe(true);
  });

  it('skips the warning when disabled, has recipients, or is demo', () => {
    expect(shouldWarnNoRecipients(false, false, false)).toBe(false);
    expect(shouldWarnNoRecipients(true, true, false)).toBe(false);
    expect(shouldWarnNoRecipients(true, false, true)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Acknowledgement state rules (AlertHistory + bulk select)
// ───────────────────────────────────────────────────────────────────────────

const ACKABLE_STATES = ['STOP', 'HOLD', 'PREPARE', 'DEGRADED'];
function requiresAck(state: string | null | undefined) {
  return state ? ACKABLE_STATES.includes(state) : false;
}

describe('acknowledgeable risk states', () => {
  it('STOP / HOLD / PREPARE / DEGRADED all require explicit ack', () => {
    expect(requiresAck('STOP')).toBe(true);
    expect(requiresAck('HOLD')).toBe(true);
    expect(requiresAck('PREPARE')).toBe(true);
    expect(requiresAck('DEGRADED')).toBe(true);
  });

  it('ALL_CLEAR is the only non-ackable risk state (clearing is implicit)', () => {
    expect(requiresAck('ALL_CLEAR')).toBe(false);
  });

  it('null / unknown states are not ackable (defensive)', () => {
    expect(requiresAck(null)).toBe(false);
    expect(requiresAck(undefined)).toBe(false);
    expect(requiresAck('')).toBe(false);
    expect(requiresAck('MAINTENANCE')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Replay map fitBounds geometry
// ───────────────────────────────────────────────────────────────────────────

function radiusToBoundingBox(lat: number, lng: number, radiusKm: number) {
  const padded = radiusKm * 1.1;
  const dLat = padded / 111;
  const dLng = padded / (111 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
  return [
    [lat - dLat, lng - dLng] as [number, number],
    [lat + dLat, lng + dLng] as [number, number],
  ];
}

describe('Replay fitBounds geometry', () => {
  it('produces a wider bounding box for a 150 km radius than 10 km', () => {
    const [sw10, ne10] = radiusToBoundingBox(-26, 28, 10);
    const [sw150, ne150] = radiusToBoundingBox(-26, 28, 150);
    const span10 = ne10[0] - sw10[0];
    const span150 = ne150[0] - sw150[0];
    expect(span150).toBeGreaterThan(span10 * 10); // proportional to radius
  });

  it('compensates longitude for high latitudes', () => {
    // At 60° lat, longitude degree is ~half a kilometre's worth of equator.
    const [sw, ne] = radiusToBoundingBox(60, 0, 100);
    const lngSpan = ne[1] - sw[1];
    const latSpan = ne[0] - sw[0];
    expect(lngSpan).toBeGreaterThan(latSpan); // wider in degrees because cos(60°) ≈ 0.5
  });

  it('handles equator without dividing by zero', () => {
    const [sw, ne] = radiusToBoundingBox(0, 0, 50);
    expect(Number.isFinite(sw[0])).toBe(true);
    expect(Number.isFinite(ne[1])).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Demo data filtering (Dashboard)
// ───────────────────────────────────────────────────────────────────────────

function filterVisibleLocations<T extends { is_demo?: boolean }>(
  locations: T[],
  showDemo: boolean,
): T[] {
  return showDemo ? locations : locations.filter(l => !l.is_demo);
}

describe('demo location filtering', () => {
  const sample = [
    { id: '1', name: 'Real Mine',         is_demo: false },
    { id: '2', name: 'Replay demo',       is_demo: true  },
    { id: '3', name: 'Customer site',     is_demo: false },
    { id: '4', name: 'Shaun (test)',      is_demo: true  },
    { id: '5', name: 'Legacy (no flag)' /* undefined */  },
  ];

  it('hides demo when showDemo=false (default)', () => {
    const v = filterVisibleLocations(sample, false);
    expect(v.map(l => l.id)).toEqual(['1', '3', '5']);
  });

  it('shows everything when showDemo=true', () => {
    const v = filterVisibleLocations(sample, true);
    expect(v).toHaveLength(5);
  });

  it('treats missing is_demo as not-demo (backward-compat with old rows)', () => {
    const v = filterVisibleLocations(sample, false);
    expect(v.find(l => l.id === '5')).toBeDefined();
  });
});
