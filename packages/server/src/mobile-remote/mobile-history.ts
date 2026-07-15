/**
 * Build a session's history as a flat list of events the phone's streamReducer
 * understands. We REUSE the desktop's transcript reader (transcriptToFoldItems
 * via its getSessionTranscript) so there is one transcript parser, then project
 * its FoldItems into reducer events:
 *   - { kind: "stream", event }  → the raw StreamEvent (reducer eats it directly)
 *   - { kind: "user", text }     → a synthetic { type: "user_message", text }
 *
 * The phone feeds these through the SAME reducer used for the live stream, so
 * replay and live are identical (design §4).
 *
 * The transcript reader itself stays in the desktop package (it depends on
 * renderer FoldItem types), so it is injected here instead of imported.
 */

/** Structural projection of the desktop's FoldItem — only what we consume. */
export interface TranscriptHistoryItem {
  kind: string;
  text?: unknown;
  event?: unknown;
}

export type SessionTranscriptReader = (
  sessionId: string,
) => Promise<readonly TranscriptHistoryItem[]>;

export async function buildSessionHistory(
  sessionId: string,
  getTranscript: SessionTranscriptReader,
): Promise<unknown[]> {
  const items = await getTranscript(sessionId);
  const events: unknown[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      events.push({ type: "user_message", text: item.text });
    } else if (item.kind === "stream") {
      events.push(item.event);
    }
  }
  return events;
}
