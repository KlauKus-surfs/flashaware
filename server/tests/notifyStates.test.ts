import { describe, it, expect } from 'vitest';
import { shouldNotifyForState } from '../queries';

describe('shouldNotifyForState', () => {
  it('defaults to true for null / undefined / empty notify_states (fail-open)', () => {
    expect(shouldNotifyForState(null, 'STOP')).toBe(true);
    expect(shouldNotifyForState(undefined, 'STOP')).toBe(true);
    expect(shouldNotifyForState({}, 'STOP')).toBe(true);
  });

  it('returns true when the state is explicitly enabled', () => {
    expect(shouldNotifyForState({ STOP: true }, 'STOP')).toBe(true);
    expect(shouldNotifyForState({ STOP: true, PREPARE: false }, 'STOP')).toBe(true);
  });

  it('returns false when the state is explicitly disabled', () => {
    expect(shouldNotifyForState({ STOP: false }, 'STOP')).toBe(false);
    expect(shouldNotifyForState({ STOP: false, PREPARE: true }, 'STOP')).toBe(false);
  });

  it('treats missing keys in a partial map as enabled', () => {
    // Partial map: only PREPARE specified, STOP key is absent → should still notify on STOP.
    // Rationale: missing should never silently swallow a STOP alert.
    expect(shouldNotifyForState({ PREPARE: false }, 'STOP')).toBe(true);
  });

  it('handles all five canonical states', () => {
    const all = { STOP: true, PREPARE: true, HOLD: true, ALL_CLEAR: true, DEGRADED: true };
    expect(shouldNotifyForState(all, 'STOP')).toBe(true);
    expect(shouldNotifyForState(all, 'PREPARE')).toBe(true);
    expect(shouldNotifyForState(all, 'HOLD')).toBe(true);
    expect(shouldNotifyForState(all, 'ALL_CLEAR')).toBe(true);
    expect(shouldNotifyForState(all, 'DEGRADED')).toBe(true);
  });

  it('returns true for unknown state strings (fail-open)', () => {
    // An unfamiliar state code (e.g. a future addition) defaults to notifying
    // — better to over-deliver than to silently drop an unrecognised STOP-like state.
    expect(shouldNotifyForState({ STOP: false }, 'CRITICAL')).toBe(true);
  });
});
