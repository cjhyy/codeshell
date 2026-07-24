/**
 * Minimal bounded-concurrency map: run `fn` over `items` with at most `limit`
 * promises in flight at once, returning results in input order. No external
 * dependency — the repo has no shared p-limit/p-map helper to reuse.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: effectiveLimit }, () => worker()));
  return results;
}
