import { getSessionTranscript } from "../sessions-service.js";

/**
 * Build a session's history as a flat list of events the phone's streamReducer
 * understands. We REUSE the renderer's transcript reader (transcriptToFoldItems
 * via getSessionTranscript) so there is one transcript parser, then project its
 * FoldItems into reducer events:
 *   - { kind: "stream", event }  → the raw StreamEvent (reducer eats it directly)
 *   - { kind: "user", text }     → a synthetic { type: "user_message", text }
 *
 * The phone feeds these through the SAME reducer used for the live stream, so
 * replay and live are identical (design §4).
 */
export async function buildSessionHistory(sessionId: string): Promise<unknown[]> {
  const items = await getSessionTranscript(sessionId);
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
