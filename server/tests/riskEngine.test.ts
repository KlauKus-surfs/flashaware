import { describe, it, expect } from 'vitest';
import { decideRiskState, RiskDecisionInputs, RiskState } from '../riskEngine';

// Reasonable defaults for a generic "golf course" style location.
const baseInputs: RiskDecisionInputs = {
  stop_radius_km: 10,
  prepare_radius_km: 20,
  stop_flash_threshold: 1,
  stop_window_min: 15,
  prepare_flash_threshold: 1,
  prepare_window_min: 15,
  allclear_wait_min: 30,
  effectivePriorState: 'ALL_CLEAR',
  isDegraded: false,
  stopFlashes: 0,
  prepareFlashes: 0,
  nearestFlashKm: null,
  trend: 'stable',
  timeSinceLastFlashMin: null,
};

function withInputs(overrides: Partial<RiskDecisionInputs>): RiskDecisionInputs {
  return { ...baseInputs, ...overrides };
}

describe('decideRiskState — STOP transitions', () => {
  it('escalates to STOP when stop-radius flash count meets threshold', () => {
    const r = decideRiskState(withInputs({ stopFlashes: 1 }));
    expect(r.newState).toBe('STOP');
    expect(r.reason).toMatch(/1 flash\(es\) within 10 km/);
  });

  it('escalates to STOP on proximity even with zero flashes counted', () => {
    // proximityKm = max(1, 10*0.5) = 5; nearestFlash at 4km is inside.
    const r = decideRiskState(withInputs({ stopFlashes: 0, nearestFlashKm: 4 }));
    expect(r.newState).toBe('STOP');
    expect(r.reason).toMatch(/proximity threshold/);
  });

  it('does not escalate on proximity at or above the threshold', () => {
    // 5km proximity threshold (10*0.5). nearestFlashKm=5 is NOT < 5.
    const r = decideRiskState(withInputs({ stopFlashes: 0, nearestFlashKm: 5 }));
    expect(r.newState).toBe('ALL_CLEAR');
  });

  it('proximity threshold is floored at 1 km for very small radii', () => {
    // stop_radius_km=1 → 1*0.5=0.5, floored to 1.
    const r = decideRiskState(withInputs({ stop_radius_km: 1, nearestFlashKm: 0.9 }));
    expect(r.newState).toBe('STOP');
  });

  it('proximity threshold scales with large radii', () => {
    // stop_radius_km=50 → 25 km proximity. A 6km flash should STOP a 50km-radius site.
    const r = decideRiskState(withInputs({ stop_radius_km: 50, nearestFlashKm: 6 }));
    expect(r.newState).toBe('STOP');
  });
});

describe('decideRiskState — PREPARE / HOLD transitions', () => {
  it('enters PREPARE when prepare flashes meet threshold from ALL_CLEAR', () => {
    const r = decideRiskState(withInputs({
      effectivePriorState: 'ALL_CLEAR',
      prepareFlashes: 1,
    }));
    expect(r.newState).toBe('PREPARE');
  });

  it('enters HOLD instead of PREPARE if descending from STOP', () => {
    const r = decideRiskState(withInputs({
      effectivePriorState: 'STOP',
      prepareFlashes: 1,
    }));
    expect(r.newState).toBe('HOLD');
    expect(r.reason).toMatch(/STOP conditions no longer met but threat persists/);
  });

  it('stays in HOLD when descending from HOLD with prepare-radius flashes', () => {
    const r = decideRiskState(withInputs({
      effectivePriorState: 'HOLD',
      prepareFlashes: 1,
    }));
    expect(r.newState).toBe('HOLD');
  });
});

describe('decideRiskState — ALL_CLEAR / hysteresis', () => {
  it('clears immediately from ALL_CLEAR when there are no flashes', () => {
    const r = decideRiskState(withInputs({ effectivePriorState: 'ALL_CLEAR' }));
    expect(r.newState).toBe('ALL_CLEAR');
  });

  it('honours allclear_wait_min when descending from STOP — stays HOLD if too soon', () => {
    const r = decideRiskState(withInputs({
      effectivePriorState: 'STOP',
      timeSinceLastFlashMin: 10, // < 30 min wait
      allclear_wait_min: 30,
    }));
    expect(r.newState).toBe('HOLD');
    expect(r.reason).toMatch(/20 min remaining/);
  });

  it('clears once allclear_wait_min has elapsed since last flash', () => {
    const r = decideRiskState(withInputs({
      effectivePriorState: 'STOP',
      timeSinceLastFlashMin: 30,
      allclear_wait_min: 30,
    }));
    expect(r.newState).toBe('ALL_CLEAR');
  });

  it('clears immediately if no flash history exists in stop radius (timeSince=null, not degraded)', () => {
    const r = decideRiskState(withInputs({
      effectivePriorState: 'STOP',
      timeSinceLastFlashMin: null,
      isDegraded: false,
    }));
    expect(r.newState).toBe('ALL_CLEAR');
  });

  it('does NOT clear when degraded, even with no recent flashes', () => {
    const r = decideRiskState(withInputs({
      effectivePriorState: 'STOP',
      timeSinceLastFlashMin: null,
      isDegraded: true,
    }));
    expect(r.newState).toBe('HOLD');
  });

  it('descending from PREPARE during wait window stays in PREPARE (not HOLD)', () => {
    const r = decideRiskState(withInputs({
      effectivePriorState: 'PREPARE',
      timeSinceLastFlashMin: 5,
      allclear_wait_min: 30,
    }));
    expect(r.newState).toBe('PREPARE');
    expect(r.reason).toMatch(/Stay alert/);
  });

  it('descending from STOP/HOLD during wait window stays in HOLD', () => {
    const r1 = decideRiskState(withInputs({
      effectivePriorState: 'STOP',
      timeSinceLastFlashMin: 5,
    }));
    expect(r1.newState).toBe('HOLD');
    expect(r1.reason).toMatch(/Stay sheltered/);

    const r2 = decideRiskState(withInputs({
      effectivePriorState: 'HOLD',
      timeSinceLastFlashMin: 5,
    }));
    expect(r2.newState).toBe('HOLD');
  });
});

describe('decideRiskState — full cycle ALL_CLEAR → PREPARE → STOP → HOLD → ALL_CLEAR', () => {
  it('walks the canonical state path', () => {
    let prior: RiskState | null = null; // cold start

    // 1. From cold: prepare flashes appear. With prior=null (no STOP/HOLD), → PREPARE.
    const s1 = decideRiskState(withInputs({ effectivePriorState: prior, prepareFlashes: 1 }));
    expect(s1.newState).toBe('PREPARE');
    prior = s1.newState;

    // 2. Storm intensifies, flash hits stop radius → STOP.
    const s2 = decideRiskState(withInputs({ effectivePriorState: prior, stopFlashes: 1, prepareFlashes: 2 }));
    expect(s2.newState).toBe('STOP');
    prior = s2.newState;

    // 3. STOP conditions clear but prepare radius still active → HOLD.
    const s3 = decideRiskState(withInputs({ effectivePriorState: prior, stopFlashes: 0, prepareFlashes: 1 }));
    expect(s3.newState).toBe('HOLD');
    prior = s3.newState;

    // 4. All flashes gone, but wait period not yet met → still HOLD.
    const s4 = decideRiskState(withInputs({
      effectivePriorState: prior,
      stopFlashes: 0,
      prepareFlashes: 0,
      timeSinceLastFlashMin: 10,
      allclear_wait_min: 30,
    }));
    expect(s4.newState).toBe('HOLD');
    prior = s4.newState;

    // 5. Wait period elapsed → ALL_CLEAR.
    const s5 = decideRiskState(withInputs({
      effectivePriorState: prior,
      stopFlashes: 0,
      prepareFlashes: 0,
      timeSinceLastFlashMin: 31,
      allclear_wait_min: 30,
    }));
    expect(s5.newState).toBe('ALL_CLEAR');
  });
});

describe('decideRiskState — non-default thresholds', () => {
  it('respects custom stop_flash_threshold > 1', () => {
    // threshold=3 means 2 flashes still does not escalate from ALL_CLEAR.
    const r = decideRiskState(withInputs({
      stop_flash_threshold: 3,
      stopFlashes: 2,
      // and no proximity flash either:
      nearestFlashKm: 100,
    }));
    expect(r.newState).not.toBe('STOP');
  });

  it('respects custom allclear_wait_min', () => {
    const r = decideRiskState(withInputs({
      effectivePriorState: 'STOP',
      timeSinceLastFlashMin: 20,
      allclear_wait_min: 60, // 40 min remaining
    }));
    expect(r.newState).toBe('HOLD');
    expect(r.reason).toMatch(/40 min remaining/);
  });
});
