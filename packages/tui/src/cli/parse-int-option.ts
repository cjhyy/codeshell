import { InvalidArgumentError } from "commander";

/**
 * Parse a CLI option as a positive base-10 integer, throwing a clear error on
 * invalid input. Replaces bare `parseInt(opts.x)` calls that silently yielded
 * NaN (and even accepted "5abc") — review-2026-05-30.
 *
 * Throws commander's InvalidArgumentError so that, when used as an option
 * argParser, commander prints a clean "error: option '--x <n>' argument ..."
 * message and exits 1 instead of surfacing an uncaught stack trace.
 */
export function parsePositiveInt(raw: string, label: string): number {
  const trimmed = raw.trim();
  const n = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError(`Invalid ${label}: ${JSON.stringify(raw)} — expected a positive integer.`);
  }
  return n;
}

/** Commander argParser for a positive-int option (validates at parse time). */
export function positiveIntOption(label: string): (raw: string) => number {
  return (raw: string) => parsePositiveInt(raw, label);
}
