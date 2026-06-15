/**
 * Pure routing logic for the Stop button — which conversation gets cancelled.
 *
 * The composer Stop button belongs to the conversation the user is VIEWING: its
 * visibility is driven by `busy = busyKeys.has(activeBucket)`. So with no
 * explicit override, Stop must target `activeBucket`. The global
 * `runningBucket` ref (last conversation to send) is only a last-resort hint for
 * the edge case where there is no active bucket at all — it must NOT take
 * precedence over the active one, or pressing Stop while viewing one of two
 * concurrent conversations would abort the wrong one.
 *
 * Priority:
 *   1. explicit override (callers that know exactly which bucket to stop).
 *   2. activeBucket (the viewed conversation — the Stop button's owner).
 *   3. runningBucket (soft fallback when nothing is active).
 *   4. null — nothing resolvable.
 */
export function resolveStopBucket(
  override: string | undefined,
  activeBucket: string | null,
  runningBucket: string | null,
): string | null {
  return override ?? activeBucket ?? runningBucket ?? null;
}
