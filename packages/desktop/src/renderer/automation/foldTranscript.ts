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
    state = item.kind === "user"
      ? appendUserMessage(state, item.text)
      : applyStreamEvent(state, item.event);
  }
  return state;
}
