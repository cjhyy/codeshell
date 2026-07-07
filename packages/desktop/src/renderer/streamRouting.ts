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
import { bucketKey, type SessionIndex } from "./transcripts";

// Bucket keys here are built from an already-resolved repoKey string (the keys
// of `sessionIndices`, never null) + a non-null UI session id, which the shared
// `bucketKey(repoId, sessionId)` reproduces byte-identically
// (`${repoKey}::${uiSessionId}`). Use the shared helper so this can't drift from
// App's map build / Sidebar's row lookup.

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

  return sessionId ? null : runningBucket;
}

/**
 * Find, across all rendered transcripts, the bucket + originating engine
 * sessionId of the pending AskUser prompt with `requestId`.
 *
 * Needed because an AskUser answer must route back to the session that ASKED —
 * not the currently-active bucket. When the prompt belongs to a background
 * session (or the route table went cold after a remount), the active bucket and
 * the prompt's bucket differ, and answering the active session's pending map
 * strands the real request until it times out. The prompt message carries the
 * engine sessionId it was stamped with at dispatch; this recovers it by id.
 *
 * `transcripts` is the App reducer map (bucket → { messages }). Kept pure +
 * structurally typed so it's testable without importing the full reducer types.
 * Returns undefined bucket/engineSessionId when the prompt isn't found (caller
 * falls back to the active-bucket derivation for legacy prompts).
 */
export function findAskUserOrigin(
  transcripts: Record<
    string,
    { messages: Array<{ kind: string; requestId?: string; engineSessionId?: string; answer?: string }> }
  >,
  requestId: string,
): { bucket: string; engineSessionId?: string; answer?: string } | undefined {
  for (const [bucket, state] of Object.entries(transcripts)) {
    const msg = state.messages.find(
      (m) => m.kind === "ask_user" && m.requestId === requestId,
    );
    if (msg) return { bucket, engineSessionId: msg.engineSessionId, answer: msg.answer };
  }
  return undefined;
}
