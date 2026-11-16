/**
 * Test helper: what Transcript.appendMessage returns, for a stand-in
 * transcript that stores nothing. Production code relies on appendMessage
 * always returning the appended event.
 */
import type { TranscriptEvent } from "../types.js";

let appended = 0;

export function fakeTranscriptEvent(): TranscriptEvent {
  appended += 1;
  return { id: `fake-event-${appended}`, type: "message", timestamp: 0, turnNumber: 0, data: {} };
}
