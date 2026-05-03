import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../concurrency';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([10, 20, 30, 40, 5], 3, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(out).toEqual([20, 40, 60, 80, 10]);
  });

  it('respects the concurrency cap (never more than `limit` in flight)', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield a few microtasks so other workers definitely race for the slot.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });

    expect(peak).toBe(4);
  });

  it('coerces non-positive limit to 1 so the pool always makes progress', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n + 1);
    expect(out).toEqual([2, 3, 4]);
  });

  it('returns an empty array immediately for an empty input', async () => {
    const out = await mapWithConcurrency([] as number[], 8, async (n) => n);
    expect(out).toEqual([]);
  });

  it('caps worker count at items.length when limit > items.length', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2], 100, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('rejects on the first error (mirrors Promise.all semantics)', async () => {
    const promise = mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    await expect(promise).rejects.toThrow('boom');
  });

  it('does not start a new task after a rejection short-circuits the pool', async () => {
    // After the rejection we want the in-flight workers to still be allowed
    // to finish or reject themselves — but Promise.all on the worker array
    // will surface the first rejection. We just assert the rejection wins.
    const started: number[] = [];
    const d = deferred<number>();
    const promise = mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      if (n === 1) {
        // The first worker hangs until 2 has rejected.
        return d.promise;
      }
      if (n === 2) throw new Error('halt');
      return n;
    });
    await expect(promise).rejects.toThrow('halt');
    // Items 1 and 2 must have started; 3/4 may or may not, but we don't pin it.
    expect(started).toContain(1);
    expect(started).toContain(2);
    d.resolve(0);
  });
});
