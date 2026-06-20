/**
 * Replay a persisted transcript (as FoldItems from the main-process reader)
 * into a MessagesReducerState by reusing the SAME reducer the live stream
 * uses. This keeps message-folding logic single-sourced in types.ts.
 */
import { applyStreamEvent, appendUserMessage, appendTurnEndMessage, INITIAL_STATE, type MessagesReducerState } from "../types";
import type { FoldItem } from "../../preload/types";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";

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
    if (item.kind === "user") {
      state = appendUserMessage(state, item.text, item.timestamp);
    } else if (item.kind === "turn_stopped") {
      // Rebuild the user-interrupt marker so the stopped turn renders flat
      // (turnWasStopped finds this turn_end → no fold header). No elapsed on
      // replay; the marker's presence is what un-folds the turn.
      state = appendTurnEndMessage(state, "stopped");
    } else {
      state = applyStreamEvent(state, item.event, replayClock);
    }
  }
  return sealOrphanedAgents(state);
}

/**
 * Seal any sub-agent that got an `agent_start` but never a terminal
 * `agent_end` in the transcript. This happens when the worker/desktop is
 * quit (or crashes) while a backgrounded agent is still running: the
 * in-memory completion handler dies with the process, so no agent_end is ever
 * persisted. On reopen, replay rebuilds the `agent_start` (card → 'working')
 * with nothing to resolve it, and the card spins forever.
 *
 * A replayed transcript is finite history — there is no live run behind it —
 * so an agent still `done: false` after the whole replay can only be an
 * orphan. Mark it done with an "interrupted" note so the UI shows a terminal
 * state instead of a perpetual spinner. (Regression: session
 * s-mq0xsmes-e17c5a11, agent 676UNZFU — agent_start at 06-05 13:34, no
 * agent_end ever.)
 */
function sealOrphanedAgents(state: MessagesReducerState): MessagesReducerState {
  let touched = false;
  const messages = state.messages.map((m) => {
    if (m.kind === "agent" && !m.done) {
      touched = true;
      const flushed = m.textBuffer.length > 0 ? (m.text ?? "") + m.textBuffer : m.text;
      return {
        ...m,
        done: true,
        text: flushed,
        textBuffer: "",
        error: m.error ?? translate(loadUILanguage(), "auto.transcript.agentInterrupted"),
      };
    }
    return m;
  });
  if (!touched) return state;
  // Also clear activeAgents — nothing is actually running after replay.
  return { ...state, messages, activeAgents: {} };
}
