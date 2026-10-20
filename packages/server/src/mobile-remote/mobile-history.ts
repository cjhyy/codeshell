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
import { transcriptUserDisplay } from "@cjhyy/code-shell-web";

/** Structural projection of the desktop's FoldItem — only what we consume. */
export interface TranscriptHistoryItem {
  kind: string;
  text?: unknown;
  /** Image blocks of a raw model-facing user input (it has no displayText). */
  images?: unknown;
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
      events.push(userHistoryEvent(item));
    } else if (item.kind === "stream") {
      events.push(item.event);
    }
  }
  return events;
}

/**
 * A user input with image blocks but no displayText (e.g. an old paired
 * chat.send) persisted the engine's model-facing text, including the
 * attached-image path envelope and tool hint. Project it through the same
 * display rules as durable replay instead of showing that as the user's text.
 */
function userHistoryEvent(item: TranscriptHistoryItem): Record<string, unknown> {
  const images = typeof item.images === "number" && item.images > 0 ? item.images : 0;
  if (!images || typeof item.text !== "string") return { type: "user_message", text: item.text };
  const display = transcriptUserDisplay({
    content: [
      { type: "text", text: item.text },
      ...Array.from({ length: images }, () => ({ type: "image", source: {} })),
    ],
  });
  return {
    type: "user_message",
    text: display.text,
    ...(display.attachments.length ? { attachments: display.attachments } : {}),
  };
}
