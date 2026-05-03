import { describe, it, expect } from 'vitest';
import { POLL_INTERVAL_BASE_MS, POLL_INTERVAL_JITTER_MS } from '../leader';

// Locks in the failover characteristics. If someone bumps these back to the
// old 30s+5s without justifying it in a follow-up, this test goes red and
// forces a conversation. The numeric ceiling here is a deliberate floor on
// "how long can the fleet go without a leader after a crash".
describe('leader-election poll cadence', () => {
  it('keeps base interval at or below 10s for fast failover', () => {
    // Tight enough that the worst-case engine-tick gap (60s) isn't
    // dominated by the leader-election lag. If you raise this, also raise
    // the engine tick budget commentary in riskEngine.ts.
    expect(POLL_INTERVAL_BASE_MS).toBeLessThanOrEqual(10_000);
    expect(POLL_INTERVAL_BASE_MS).toBeGreaterThanOrEqual(1_000);
  });

  it('keeps jitter window non-zero so concurrent followers drift apart', () => {
    expect(POLL_INTERVAL_JITTER_MS).toBeGreaterThan(0);
    // But not so wide that worst-case wakeup is dominated by jitter.
    expect(POLL_INTERVAL_JITTER_MS).toBeLessThanOrEqual(POLL_INTERVAL_BASE_MS);
  });

  it('worst-case failover gap is under 12 seconds', () => {
    // Convenience assertion: spell out the SLA so a future tweak that
    // breaches it is loud, not silent.
    expect(POLL_INTERVAL_BASE_MS + POLL_INTERVAL_JITTER_MS).toBeLessThan(12_000);
  });
});
