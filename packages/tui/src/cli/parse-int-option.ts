/**
 * Parse a CLI option as a positive base-10 integer, throwing a clear error on
 * invalid input. Replaces bare `parseInt(opts.x)` calls that silently yielded
 * NaN (and even accepted "5abc") — review-2026-05-30.
 */
export function parsePositiveInt(raw: string, label: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(raw)} — expected a positive integer.`);
  }
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(raw)} — expected a positive integer.`);
  }
  return n;
}
