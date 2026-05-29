/**
 * Shared stop-reason helpers.
 *
 * Providers report "the response was cut off at the output-token cap" with
 * different finish/stop-reason strings:
 *   - OpenAI / OpenAI-compat:  finish_reason "length"
 *   - Anthropic:               stop_reason  "max_tokens"
 *
 * The turn loop uses this to decide whether to run a max-output
 * continuation, so the check must accept both spellings.
 */

const TRUNCATED_STOP_REASONS: ReadonlySet<string> = new Set([
  "length", // OpenAI / OpenAI-compatible
  "max_tokens", // Anthropic
]);

/** True when the stop reason indicates the model hit its output-token cap. */
export function isTruncatedStop(stopReason: string | undefined): boolean {
  if (!stopReason) return false;
  return TRUNCATED_STOP_REASONS.has(stopReason);
}
