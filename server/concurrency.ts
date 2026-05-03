// Bounded async map. Runs `fn` over `items` with at most `limit` promises in
// flight at any moment. Used by alertService.dispatchAlerts to parallelise
// per-recipient fan-out without opening hundreds of SMTP/HTTP connections at
// the start of a STOP alert.
//
// Semantics:
//   * Order of results matches order of items (like Promise.all).
//   * Resolves to an array; rejects on the first error (mirrors Promise.all).
//     Callers that want per-item error isolation should wrap `fn` in
//     try/catch and return a result/Error union — that's the pattern used in
//     alertService, where each channel writes its own row whether it
//     succeeded or failed.
//   * `limit <= 0` is treated as 1 to avoid an empty pool that would never
//     start any work.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workerCount = Math.min(safeLimit, items.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
