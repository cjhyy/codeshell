/**
 * Minimal memoize with a custom cache-key resolver — same shape as
 * lodash's `memoize(fn, resolver)` for the call sites that need to
 * derive the cache key from arguments + side-channel state (e.g.
 * "user home + installed-plugins mtime"). Kept in-tree to drop the
 * lodash-es dependency from the core package.
 *
 * The returned function exposes `.cache` matching the subset of
 * lodash's MapCache API the existing call sites use (`.clear()`).
 * Cache lives for the lifetime of the returned function. Not LRU —
 * call sites cache scan results keyed by a string that changes when
 * external state changes, so unbounded growth is bounded by the
 * cardinality of that key.
 */
export interface MemoizedFn<Args extends readonly unknown[], R> {
  (...args: Args): R;
  cache: Map<string, R>;
}

export function memoize<Args extends readonly unknown[], R>(
  fn: (...args: Args) => R,
  resolver: (...args: Args) => string,
): MemoizedFn<Args, R> {
  const cache = new Map<string, R>();
  const memoized = ((...args: Args): R => {
    const key = resolver(...args);
    const hit = cache.get(key);
    if (hit !== undefined || cache.has(key)) return hit as R;
    const result = fn(...args);
    cache.set(key, result);
    return result;
  }) as MemoizedFn<Args, R>;
  memoized.cache = cache;
  return memoized;
}
