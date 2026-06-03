/**
 * Per-session sidebar status mark and its pure priority resolver.
 *
 * The status is computed live in App.tsx (never persisted on SessionSummary)
 * and passed down to the Sidebar keyed by bucket. This module holds only the
 * pure pieces so they can be unit-tested without dragging in the whole
 * renderer component tree.
 */

export type SessionStatus = "asking" | "running" | "unread";

/**
 * Resolve a single bucket's status from the three live sets.
 * Priority: asking > running > unread > none.
 */
export function statusForBucket(
  bucket: string,
  asking: Set<string>,
  busy: Set<string>,
  unread: Set<string>,
): SessionStatus | undefined {
  if (asking.has(bucket)) return "asking";
  if (busy.has(bucket)) return "running";
  if (unread.has(bucket)) return "unread";
  return undefined;
}
