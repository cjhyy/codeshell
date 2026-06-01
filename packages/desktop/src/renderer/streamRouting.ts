/**
 * Pure routing logic for incoming agent stream events.
 *
 * An event carries the engine `sessionId`; the renderer must map it to a UI
 * "bucket" (`repoKey::uiSessionId`) to dispatch into the right tab. The live
 * `engineToBucket` table is the fast path, but it lives in renderer memory and
 * is wiped on every remount (refresh / HMR / crash recovery). When it misses,
 * we reverse-look-up the engine sessionId in the on-disk session indices
 * (loaded from localStorage, so they survive a remount) instead of dropping
 * the event. This is what keeps a resumed worker's output flowing into the UI
 * after the renderer reloads — without it, App.tsx silently dropped the events.
 */
import type { SessionIndex } from "./transcripts";

/** Build a bucket key from a repo key and UI session id. Mirrors App.bucketKey. */
function bucketKey(repoKey: string, uiSessionId: string): string {
  return `${repoKey}::${uiSessionId}`;
}

/**
 * Resolve the bucket for an event's engine sessionId.
 *
 * Priority:
 *   1. Live route table (fast path, populated on send / session_started).
 *   2. Reverse lookup in session indices by engineSessionId (survives remount).
 *   3. The soft runningBucket hint (legacy / pre-bind events with empty id).
 *   4. null — genuinely unknown; the caller drops the event.
 */
export function resolveBucket(
  sessionId: string,
  engineToBucket: Map<string, string>,
  sessionIndices: Record<string, SessionIndex>,
  runningBucket: string | null,
): string | null {
  if (sessionId) {
    const fromTable = engineToBucket.get(sessionId);
    if (fromTable) return fromTable;

    for (const [repoKey, index] of Object.entries(sessionIndices)) {
      for (const s of index.sessions) {
        if (s.engineSessionId === sessionId) {
          return bucketKey(repoKey, s.id);
        }
      }
    }
  }

  return runningBucket;
}
