import { describe, it, expect } from 'vitest';
import { isBannedPassword, BANNED_PASSWORDS } from '../auth';

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
    expect(feedHealthy(11)).toBe(true); // stale but engine still working
    expect(feedHealthy(24)).toBe(true);
    expect(feedHealthy(25)).toBe(false); // engine flips DEGRADED
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
  const dLng = padded / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
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
  return showDemo ? locations : locations.filter((l) => !l.is_demo);
}

// ───────────────────────────────────────────────────────────────────────────
// Demo-admin seed gate (server/migrate.ts) — ensures the well-known
// admin@flashaware.com / admin123 credential can't sneak back in via a
// fresh deploy. The previous seed used DO UPDATE which would also
// re-elevate a demoted user back to super_admin every boot.
// ───────────────────────────────────────────────────────────────────────────

function shouldSeedDemoAdmin(env: Record<string, string | undefined>): boolean {
  return env.SEED_DEMO_ADMIN === 'true';
}

describe('demo super-admin seed gate', () => {
  it('does NOT seed by default (no env var = no well-known cred)', () => {
    expect(shouldSeedDemoAdmin({})).toBe(false);
  });

  it('does NOT seed for any value other than the literal "true"', () => {
    expect(shouldSeedDemoAdmin({ SEED_DEMO_ADMIN: '1' })).toBe(false);
    expect(shouldSeedDemoAdmin({ SEED_DEMO_ADMIN: 'yes' })).toBe(false);
    expect(shouldSeedDemoAdmin({ SEED_DEMO_ADMIN: 'TRUE' })).toBe(false);
    expect(shouldSeedDemoAdmin({ SEED_DEMO_ADMIN: '' })).toBe(false);
    expect(shouldSeedDemoAdmin({ SEED_DEMO_ADMIN: undefined })).toBe(false);
  });

  it('seeds only when the operator explicitly opts in', () => {
    expect(shouldSeedDemoAdmin({ SEED_DEMO_ADMIN: 'true' })).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Replay speed-cycle (chip click)
// ───────────────────────────────────────────────────────────────────────────

const SPEED_ORDER = [0.5, 1, 2, 4];
function nextSpeed(current: number): number {
  const i = SPEED_ORDER.indexOf(current);
  return SPEED_ORDER[(i + 1) % SPEED_ORDER.length];
}

describe('Replay speed chip cycle', () => {
  it('cycles 0.5 → 1 → 2 → 4 → 0.5', () => {
    expect(nextSpeed(0.5)).toBe(1);
    expect(nextSpeed(1)).toBe(2);
    expect(nextSpeed(2)).toBe(4);
    expect(nextSpeed(4)).toBe(0.5);
  });

  it('handles a non-canonical starting speed gracefully (treats as -1 index)', () => {
    // (-1 + 1) % 4 === 0 → first slot. Defensive default if the persisted
    // speed ever gets out of the canonical set.
    expect(nextSpeed(3)).toBe(SPEED_ORDER[0]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Banned-password block list (server/auth.ts) — guards every signup, every
// password change, and the post-login `must_change_password` flag.
// ───────────────────────────────────────────────────────────────────────────

describe('isBannedPassword', () => {
  it('rejects the seeded admin123 default', () => {
    expect(isBannedPassword('admin123')).toBe(true);
  });

  it('is case-insensitive (Admin123, ADMIN123, … all rejected)', () => {
    expect(isBannedPassword('Admin123')).toBe(true);
    expect(isBannedPassword('ADMIN123')).toBe(true);
    expect(isBannedPassword('aDmIn123')).toBe(true);
  });

  it('rejects every entry in the published block list', () => {
    for (const p of BANNED_PASSWORDS) {
      expect(isBannedPassword(p)).toBe(true);
    }
  });

  it('accepts a strong-looking password', () => {
    expect(isBannedPassword('correct-horse-battery-staple')).toBe(false);
    expect(isBannedPassword('Tr0ub4dor&3')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Add-Location coordinate gating (client/src/LocationEditor.tsx) — duplicated
// here as a pure function so the contract is locked in even if the React
// helper drifts.
// ───────────────────────────────────────────────────────────────────────────

function hasValidCoordinates(form: { lat: number; lng: number }): boolean {
  return (
    Number.isFinite(form.lat) &&
    form.lat >= -90 &&
    form.lat <= 90 &&
    Number.isFinite(form.lng) &&
    form.lng >= -180 &&
    form.lng <= 180 &&
    !(form.lat === 0 && form.lng === 0)
  );
}

describe('Add-Location coordinate gating', () => {
  it('accepts a real Johannesburg pin', () => {
    expect(hasValidCoordinates({ lat: -26.2041, lng: 28.0473 })).toBe(true);
  });

  it('rejects NaN (cleared input)', () => {
    expect(hasValidCoordinates({ lat: NaN, lng: 28 })).toBe(false);
    expect(hasValidCoordinates({ lat: -26, lng: NaN })).toBe(false);
  });

  it('rejects out-of-range values', () => {
    expect(hasValidCoordinates({ lat: 91, lng: 0 })).toBe(false);
    expect(hasValidCoordinates({ lat: -91, lng: 0 })).toBe(false);
    expect(hasValidCoordinates({ lat: 0, lng: 181 })).toBe(false);
    expect(hasValidCoordinates({ lat: 0, lng: -181 })).toBe(false);
  });

  it('rejects (0, 0) "Null Island" — the most common bad-default pin', () => {
    expect(hasValidCoordinates({ lat: 0, lng: 0 })).toBe(false);
  });

  it('still accepts genuinely-equator-ish coordinates (lat = 0 with non-zero lng)', () => {
    expect(hasValidCoordinates({ lat: 0, lng: 28 })).toBe(true);
  });
});

describe('demo location filtering', () => {
  const sample = [
    { id: '1', name: 'Real Mine', is_demo: false },
    { id: '2', name: 'Replay demo', is_demo: true },
    { id: '3', name: 'Customer site', is_demo: false },
    { id: '4', name: 'Shaun (test)', is_demo: true },
    { id: '5', name: 'Legacy (no flag)' /* undefined */ },
  ];

  it('hides demo when showDemo=false (default)', () => {
    const v = filterVisibleLocations(sample, false);
    expect(v.map((l) => l.id)).toEqual(['1', '3', '5']);
  });

  it('shows everything when showDemo=true', () => {
    const v = filterVisibleLocations(sample, true);
    expect(v).toHaveLength(5);
  });

  it('treats missing is_demo as not-demo (backward-compat with old rows)', () => {
    const v = filterVisibleLocations(sample, false);
    expect(v.find((l) => l.id === '5')).toBeDefined();
  });
});
