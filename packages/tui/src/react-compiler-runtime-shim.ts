/**
 * Shim for react/compiler-runtime.
 * The React Compiler uses `c(size)` to allocate a per-component
 * memoization cache (array of slots). This shim provides a
 * no-memoization fallback — every render gets a fresh array.
 */
const EMPTY = Symbol("empty");

export function c(size: number): any[] {
  const cache = new Array(size);
  for (let i = 0; i < size; i++) {
    cache[i] = EMPTY;
  }
  return cache;
}
