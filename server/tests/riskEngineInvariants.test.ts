import { describe, it, expect } from 'vitest';
import { decideRiskState, RiskDecisionInputs, RiskState } from '../riskEngine';

// ---------------------------------------------------------------------------
// Safety invariants for the risk decision function.
//
// These are *property-style* tests: the engine should never violate them no
// matter how the inputs are combined. They exist to catch the failure modes
// flagged in the 2026-05 audit:
//   * "ALL CLEAR with stale data" — feed health must always block clearing.
//   * "STOP/HOLD → ALL CLEAR via null short-circuit" — descending from a
//     restricted state must always go through HOLD/PREPARE wait.
//   * "Feed just recovered" — refusing to honour a no-records short-circuit
//     when we couldn't observe the airspace during the outage.
//
// Each test enumerates a small space of inputs and asserts the invariant
// holds across all of them. The space is small enough to run exhaustively in
// unit-test time (low ms); larger spaces would belong in fast-check.
// ---------------------------------------------------------------------------

const RADII = [1, 5, 10, 50] as const;
const PRIOR_STATES: (RiskState | null)[] = ['ALL_CLEAR', 'PREPARE', 'STOP', 'HOLD', null];

function inputsWith(overrides: Partial<RiskDecisionInputs>): RiskDecisionInputs {
  return {
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
    ...overrides,
  };
}

describe('Invariant: ALL_CLEAR is never issued while the feed is DEGRADED', () => {
  it('holds across every prior state and every flash configuration', () => {
    for (const prior of PRIOR_STATES) {
      for (const stop of [0, 1, 5]) {
        for (const prep of [0, 1, 5]) {
          for (const nearest of [null, 0.5, 5, 50]) {
            for (const tslm of [null, 0, 15, 30, 60]) {
              const r = decideRiskState(
                inputsWith({
                  isDegraded: true,
                  effectivePriorState: prior,
                  stopFlashes: stop,
                  prepareFlashes: prep,
                  nearestFlashKm: nearest,
                  timeSinceLastFlashMin: tslm,
                }),
              );
              // The risk engine evaluates this branch in evaluateLocation
              // (the wrapper) which short-circuits to DEGRADED before
              // calling decideRiskState. decideRiskState itself only
              // refuses to *clear* under degraded; an upstream-already-
              // STOP'd location can still see STOP through it.
              if (stop === 0 && (nearest === null || nearest >= 5) && prep === 0) {
                // No flash signal — clearing branch. Must NOT clear while
                // degraded.
                expect(r.newState).not.toBe('ALL_CLEAR');
              }
            }
          }
        }
      }
    }
  });
});

describe('Invariant: descending from STOP/HOLD/PREPARE never skips the wait', () => {
  it('refuses ALL_CLEAR until allclear_wait_min has elapsed', () => {
    for (const prior of ['STOP', 'HOLD', 'PREPARE'] as const) {
      // No flash signals, varying timeSinceLastFlash from 0 up to wait.
      for (let tslm = 0; tslm < 30; tslm++) {
        const r = decideRiskState(
          inputsWith({
            effectivePriorState: prior,
            allclear_wait_min: 30,
            timeSinceLastFlashMin: tslm,
            stopFlashes: 0,
            prepareFlashes: 0,
            nearestFlashKm: null,
          }),
        );
        expect(r.newState, `prior=${prior} tslm=${tslm} should not be ALL_CLEAR`).not.toBe(
          'ALL_CLEAR',
        );
      }
    }
  });

  it('clears at exactly the threshold and beyond', () => {
    for (const prior of ['STOP', 'HOLD', 'PREPARE'] as const) {
      for (const tslm of [30, 31, 60, 600]) {
        const r = decideRiskState(
          inputsWith({
            effectivePriorState: prior,
            allclear_wait_min: 30,
            timeSinceLastFlashMin: tslm,
          }),
        );
        expect(r.newState, `prior=${prior} tslm=${tslm} should be ALL_CLEAR`).toBe('ALL_CLEAR');
      }
    }
  });
});

describe('Invariant: feedJustRecovered blocks the no-records ALL_CLEAR shortcut', () => {
  it('forces HOLD/PREPARE while the flag is true, regardless of prior STOP/HOLD/PREPARE', () => {
    for (const prior of ['STOP', 'HOLD'] as const) {
      const r = decideRiskState(
        inputsWith({
          effectivePriorState: prior,
          isDegraded: false,
          feedJustRecovered: true,
          timeSinceLastFlashMin: null,
        }),
      );
      expect(r.newState).toBe('HOLD');
      expect(r.reason).toMatch(/Feed just recovered/);
    }
    const r = decideRiskState(
      inputsWith({
        effectivePriorState: 'PREPARE',
        feedJustRecovered: true,
        timeSinceLastFlashMin: null,
      }),
    );
    expect(r.newState).toBe('PREPARE');
    expect(r.reason).toMatch(/Feed just recovered/);
  });

  it('still allows the no-records shortcut once the flag is unset (next ticks)', () => {
    // After a full observation window, the engine's wrapper has already
    // confirmed quiet airspace and timeSinceLastFlashMin will be non-null
    // and ≥ allclear_wait_min — but if it remains null because no flashes
    // ever entered the radius post-recovery, the standard shortcut applies.
    const r = decideRiskState(
      inputsWith({
        effectivePriorState: 'STOP',
        isDegraded: false,
        feedJustRecovered: false,
        timeSinceLastFlashMin: null,
      }),
    );
    expect(r.newState).toBe('ALL_CLEAR');
  });
});

describe('Invariant: STOP escalation always wins over PREPARE/HOLD/ALL_CLEAR signals', () => {
  it('any flash configuration that meets STOP criteria yields STOP regardless of prior', () => {
    for (const prior of PRIOR_STATES) {
      for (const radius of RADII) {
        const proximityKm = Math.max(1, radius * 0.5);
        // Configuration that should always STOP: meets flash threshold OR
        // has a proximity flash strictly inside the threshold.
        const r1 = decideRiskState(
          inputsWith({
            stop_radius_km: radius,
            stop_flash_threshold: 1,
            stopFlashes: 1,
            effectivePriorState: prior,
          }),
        );
        expect(r1.newState).toBe('STOP');

        const r2 = decideRiskState(
          inputsWith({
            stop_radius_km: radius,
            nearestFlashKm: proximityKm - 0.001,
            effectivePriorState: prior,
          }),
        );
        expect(r2.newState).toBe('STOP');
      }
    }
  });
});

describe('Invariant: timeSinceLastFlashMin === allclear_wait_min is the boundary', () => {
  it('value exactly at threshold clears; just below stays in HOLD', () => {
    const equal = decideRiskState(
      inputsWith({
        effectivePriorState: 'STOP',
        allclear_wait_min: 30,
        timeSinceLastFlashMin: 30,
      }),
    );
    expect(equal.newState).toBe('ALL_CLEAR');

    const below = decideRiskState(
      inputsWith({
        effectivePriorState: 'STOP',
        allclear_wait_min: 30,
        timeSinceLastFlashMin: 29.99,
      }),
    );
    expect(below.newState).toBe('HOLD');
  });
});
