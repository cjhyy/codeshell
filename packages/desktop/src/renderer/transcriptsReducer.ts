import type { StreamEvent } from "@cjhyy/code-shell-core";
import { timePhase } from "./perf";
import {
  INITIAL_STATE,
  appendAskUserMessage,
  appendTurnEndMessage,
  appendUserMessage,
  applyStreamEvent,
  markAskUserAnswered,
  removePendingSteerMessages,
  type AskUserOption,
  type MessagesReducerState,
} from "./types";

export type TranscriptsMap = Record<string, MessagesReducerState>;

export type TranscriptsAction =
  | {
      type: "user_message";
      bucket: string;
      text: string;
      isGoal?: boolean;
      injected?: boolean;
      steerId?: string;
      clientMessageId?: string;
      pending?: boolean;
    }
  | { type: "stream"; bucket: string; event: StreamEvent }
  | { type: "stream_batch"; bucket: string; events: StreamEvent[] }
  | { type: "hydrate"; bucket: string; state: MessagesReducerState }
  | { type: "remove_pending_steers"; bucket: string; steerIds: string[] }
  | {
      type: "ask_user";
      bucket: string;
      requestId: string;
      engineSessionId?: string;
      question: string;
      header?: string;
      options?: AskUserOption[];
      multiSelect: boolean;
      optionsOnly?: boolean;
    }
  | { type: "ask_user_answered"; bucket: string; requestId: string; answer: string }
  | {
      type: "turn_end";
      bucket: string;
      reason: "stopped" | "timeout" | "error";
      elapsedMs?: number;
      detail?: string;
    };

export function transcriptsReducer(
  map: TranscriptsMap,
  action: TranscriptsAction,
): TranscriptsMap {
  if (action.type === "hydrate") {
    const current = map[action.bucket];
    // Protect ALL local steer bubbles (not just still-pending ones) from a
    // lagging snapshot. A steer that steer_injected already confirmed
    // (pending:false) can still be missing from a hydrate whose disk read
    // happened before core appended it — the old pending-only guard let that
    // wholesale-replace wipe it (session s-mr8s3w5i loss bug). Now core
    // persists the steerId (plan A), so the snapshot replays the same bubble
    // with the same id → we keep the server copy and drop the local one
    // (no dup); only a steer the snapshot still LACKS is re-appended (no loss).
    const localUserIntents = (current?.messages ?? []).flatMap((m) =>
      m.kind === "user" && (m.steerId || m.clientMessageId) ? [m] : [],
    );
    if (localUserIntents.length === 0) return { ...map, [action.bucket]: action.state };
    const existingSteerIds = new Set(
      action.state.messages.flatMap((m) => (m.kind === "user" && m.steerId ? [m.steerId] : [])),
    );
    const existingClientIds = new Set(
      action.state.messages.flatMap((m) =>
        m.kind === "user" && m.clientMessageId ? [m.clientMessageId] : [],
      ),
    );
    const missing = localUserIntents.filter((m) => {
      if (m.clientMessageId && existingClientIds.has(m.clientMessageId)) return false;
      if (m.steerId && existingSteerIds.has(m.steerId)) return false;
      return true;
    });
    return {
      ...map,
      [action.bucket]: missing.length === 0
        ? action.state
        : { ...action.state, messages: [...action.state.messages, ...missing] },
    };
  }
  const current = map[action.bucket] ?? INITIAL_STATE;
  let next: MessagesReducerState;
  switch (action.type) {
    case "user_message":
      next = appendUserMessage(
        current,
        action.text,
        Date.now(),
        action.isGoal,
        action.injected,
        action.steerId,
        action.pending,
        action.clientMessageId,
      );
      break;
    case "remove_pending_steers":
      next = removePendingSteerMessages(current, action.steerIds);
      break;
    case "ask_user":
      next = appendAskUserMessage(current, {
        requestId: action.requestId,
        engineSessionId: action.engineSessionId,
        question: action.question,
        header: action.header,
        options: action.options,
        multiSelect: action.multiSelect,
        optionsOnly: action.optionsOnly,
      });
      break;
    case "ask_user_answered":
      next = markAskUserAnswered(current, action.requestId, action.answer);
      break;
    case "turn_end":
      next = appendTurnEndMessage(current, action.reason, action.elapsedMs, action.detail);
      break;
    case "stream":
      next = applyStreamEvent(current, action.event);
      break;
    case "stream_batch": {
      // Fold the whole 50ms batch into one new state so the list re-renders
      // once per window, not once per event. applyStreamEvent returns the
      // same ref when an event is a no-op, so an all-no-op batch leaves
      // `next === current` and the dispatch below bails out.
      next = timePhase(
        "reducer.batch",
        () => {
          let acc = current;
          for (const ev of action.events) acc = applyStreamEvent(acc, ev);
          return acc;
        },
        () => ({ events: action.events.length, msgs: current.messages.length }),
      );
      break;
    }
    default:
      next = current;
  }
  if (next === current) return map;
  return { ...map, [action.bucket]: next };
}
