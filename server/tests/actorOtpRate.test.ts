import { describe, it, expect, beforeEach } from 'vitest';

import { checkActorOtpRate, _resetActorOtpRateForTests } from '../otpService';

// Per-actor OTP rate limit. Defence-in-depth alongside the per-recipient cap
// in the DB. Window is 1h, ceiling is 30 sends.

const ACTOR = 'actor-A';

describe('checkActorOtpRate', () => {
  beforeEach(() => {
    _resetActorOtpRateForTests();
  });

  it('allows the first call', () => {
    expect(checkActorOtpRate(ACTOR)).toEqual({ ok: true });
  });

  it('counts each call independently per actor', () => {
    for (let i = 0; i < 30; i++) checkActorOtpRate(ACTOR);
    expect(checkActorOtpRate('actor-B')).toEqual({ ok: true });
  });

  it('blocks at the 31st call within the window', () => {
    for (let i = 0; i < 30; i++) {
      const r = checkActorOtpRate(ACTOR);
      expect(r.ok).toBe(true);
    }
    const blocked = checkActorOtpRate(ACTOR);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retry_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
