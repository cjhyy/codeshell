/**
 * Replay a persisted transcript (as FoldItems from the main-process reader)
 * into a MessagesReducerState by reusing the SAME reducer the live stream
 * uses. This keeps message-folding logic single-sourced in types.ts.
 */
import { applyStreamEvent, appendUserMessage, INITIAL_STATE, type MessagesReducerState } from "../types";
import type { FoldItem } from "../../preload/types";

export function foldTranscript(items: FoldItem[]): MessagesReducerState {
  let state = INITIAL_STATE;
  for (const item of items) {
    // Replay clock = the event's ORIGINAL persisted timestamp, so createdAt/
    // doneAt reflect when the message was actually asked/answered (and elapsed =
    // doneAt − createdAt is real). When a FoldItem carries no timestamp (older
    // transcripts written before timestamps were threaded through), the clock
    // returns undefined so we leave the stamps absent rather than fabricate the
    // replay-time — never stamp "now" onto history.
    const replayClock = () => item.timestamp;
    state = item.kind === "user"
      ? appendUserMessage(state, item.text, item.timestamp)
      : applyStreamEvent(state, item.event, replayClock);
  }
  return state;
}
