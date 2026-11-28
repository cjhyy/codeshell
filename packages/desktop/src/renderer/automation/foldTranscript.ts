/**
 * Replay a persisted transcript (as FoldItems from the main-process reader)
 * into a MessagesReducerState by reusing the SAME reducer the live stream
 * uses. This keeps message-folding logic single-sourced in types.ts.
 */
import {
  appendUserMessage,
  appendTurnEndMessage,
  INITIAL_STATE,
  type MessagesReducerState,
} from "../types";
import type { FoldItem } from "../../preload/types";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";
import { applyTranscriptStreamEvent } from "../transcripts";

export function foldTranscript(
  items: FoldItem[],
  options: { live?: boolean } = {},
): MessagesReducerState {
  return finishFold(foldTranscriptItems(INITIAL_STATE, items), options.live);
}

/** A fold that can be extended by the items appended since it was made. */
export interface IncrementalTranscriptFold {
  /** The rendered state (orphaned agents sealed unless `live`). */
  value: MessagesReducerState;
  live: boolean;
  /** Unsealed state after `count` items, the base for appended items. */
  base: MessagesReducerState;
  count: number;
  firstItem: string;
  lastItem: string;
}

/**
 * Fold a re-read transcript against the previous fold of the same session.
 *
 * Returns `previous` itself when nothing changed, so a poll can skip its state
 * update. When the transcript only grew, folds just the appended items on top
 * of the previous state: untouched messages keep their object identity (and
 * ids), so rows do not re-render. Anything else — a rewrite, a shrink, a
 * changed boundary item — is folded from scratch.
 */
export function foldTranscriptIncremental(
  previous: IncrementalTranscriptFold | null,
  items: FoldItem[],
  options: { live?: boolean } = {},
): IncrementalTranscriptFold {
  const live = options.live === true;
  const firstItem = items.length > 0 ? JSON.stringify(items[0]) : "";
  const lastItem = items.length > 0 ? JSON.stringify(items[items.length - 1]) : "";
  const extendsPrevious =
    previous !== null &&
    previous.count > 0 &&
    items.length >= previous.count &&
    previous.firstItem === firstItem &&
    previous.lastItem === JSON.stringify(items[previous.count - 1]);
  if (previous && extendsPrevious && items.length === previous.count) {
    if (previous.live === live) return previous;
    return { ...previous, live, value: finishFold(previous.base, live) };
  }
  const base = extendsPrevious
    ? foldTranscriptItems(previous.base, items.slice(previous.count))
    : foldTranscriptItems(INITIAL_STATE, items);
  return {
    value: finishFold(base, live),
    live,
    base,
    count: items.length,
    firstItem,
    lastItem,
  };
}

// A detail view can replay a snapshot while the child still runs. Its nested
// agents remain live; absence of an end event is only orphan evidence for
// historical replay.
function finishFold(state: MessagesReducerState, live = false): MessagesReducerState {
  return live ? state : sealOrphanedAgents(state);
}

function foldTranscriptItems(
  initial: MessagesReducerState,
  items: FoldItem[],
): MessagesReducerState {
  let state = initial;
  for (const item of items) {
    // Replay clock = the event's ORIGINAL persisted timestamp, so createdAt/
    // doneAt reflect when the message was actually asked/answered (and elapsed =
    // doneAt − createdAt is real). When a FoldItem carries no timestamp (older
    // transcripts written before timestamps were threaded through), the clock
    // returns undefined so we leave the stamps absent rather than fabricate the
    // replay-time — never stamp "now" onto history.
    const replayClock = () => item.timestamp;
    if (item.kind === "user") {
      // A persisted steerId marks an engine-injected step-in turn (steer). Replay
      // it as injected + carry the steerId so hydrate can dedup the optimistic
      // bubble against this disk snapshot (session s-mr8s3w5i loss/dup bug).
      state = item.steerId
        ? appendUserMessage(
            state,
            item.text,
            item.timestamp,
            undefined,
            true,
            item.steerId,
            undefined,
            item.clientMessageId,
            undefined,
            item.sourceEventId,
          )
        : appendUserMessage(
            state,
            item.text,
            item.timestamp,
            undefined,
            item.injected,
            undefined,
            undefined,
            item.clientMessageId,
            item.attachments,
            item.sourceEventId,
          );
    } else if (item.kind === "turn_stopped") {
      // Rebuild the user-interrupt marker so the stopped turn renders flat
      // (turnWasStopped finds this turn_end → no fold header). No elapsed on
      // replay; the marker's presence is what un-folds the turn.
      state = appendTurnEndMessage(state, "stopped", undefined, undefined, replayClock);
    } else {
      state = applyTranscriptStreamEvent(state, item.event, replayClock);
    }
  }
  return state;
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
