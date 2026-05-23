/**
 * Per-repo transcripts (renderer-side persistence).
 *
 * Each repo holds its own MessagesReducerState — the message list +
 * which assistant message is currently streaming. Switching repos in
 * the sidebar swaps the visible bucket; messages don't bleed across.
 *
 * Why localStorage and not Engine sessions (~/.code-shell/sessions/):
 *   - Engine sessions are token-budgeted transcripts the LLM sees on
 *     resume. They don't include the rendered structure (tool blocks,
 *     stream-event grouping) that the UI needs.
 *   - The UI transcript is denormalized for rendering. We'll wire
 *     "resume Engine session" + "show prior Engine turns" together in
 *     a later phase; for MVP, the UI keeps its own copy.
 *
 * Storage key: codeshell.transcript.<repoId> → JSON of MessagesReducerState.
 * Conversations for repoId === null (no repo selected) go to
 * codeshell.transcript.__global__ so the welcome state stays consistent.
 *
 * Size: we cap each transcript at TRANSCRIPT_MSG_CAP messages
 * (defensive — a runaway streaming bug shouldn't fill the user's
 * disk). The oldest messages get truncated when we save.
 */

import type { MessagesReducerState } from "./types";
import { INITIAL_STATE } from "./types";

const TRANSCRIPT_MSG_CAP = 500;

function keyFor(repoId: string | null): string {
  return `codeshell.transcript.${repoId ?? "__global__"}`;
}

export function loadTranscript(repoId: string | null): MessagesReducerState {
  try {
    const raw = localStorage.getItem(keyFor(repoId));
    if (!raw) return INITIAL_STATE;
    const parsed = JSON.parse(raw) as Partial<MessagesReducerState>;
    if (!parsed || !Array.isArray(parsed.messages)) return INITIAL_STATE;
    return {
      messages: parsed.messages,
      streamingAssistantId: parsed.streamingAssistantId ?? null,
    };
  } catch {
    return INITIAL_STATE;
  }
}

export function saveTranscript(repoId: string | null, state: MessagesReducerState): void {
  try {
    const capped: MessagesReducerState =
      state.messages.length <= TRANSCRIPT_MSG_CAP
        ? state
        : {
            ...state,
            messages: state.messages.slice(state.messages.length - TRANSCRIPT_MSG_CAP),
          };
    localStorage.setItem(keyFor(repoId), JSON.stringify(capped));
  } catch {
    // Quota exceeded or storage disabled — best effort. The transcript
    // will still live in React state for the current session.
  }
}

export function clearTranscript(repoId: string | null): void {
  try {
    localStorage.removeItem(keyFor(repoId));
  } catch {
    // best effort
  }
}
