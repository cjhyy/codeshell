/**
 * Retry classification — which errors trigger an automatic retry of the
 * streaming LLM call?
 *
 * Stream-idle timeouts are retried — the upstream may have just recovered.
 * User-initiated aborts (AbortError) are never retried — the user explicitly
 * asked for the work to stop.
 *
 * Other transient errors (5xx, 429, ECONNRESET) are out of scope for this
 * iteration; add them here as they become observed.
 */

import { StreamIdleTimeoutError } from "./stream-watchdog.js";

export function isRetryable(err: unknown): boolean {
  if (err instanceof StreamIdleTimeoutError) return true;
  return false;
}
