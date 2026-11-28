import type { MobileHistoryItem } from "@cjhyy/code-shell-core";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { createStreamBatcher, type StreamBatcher } from "../lib/streamBatcher.js";
import {
  appendUserMessage,
  initialChatState,
  reduceScopedStream,
  reduceStream,
  type ChatState,
} from "../lib/streamReducer.js";

/** The remote conversation reducer: Host stream events plus local bookkeeping. */
export type ChatAction =
  | { kind: "goalProjection"; raw: unknown; expected: { goalId?: string; revision?: number } }
  | { kind: "raw"; raw: unknown }
  | {
      kind: "user";
      text: string;
      clientMessageId?: string;
      attachments?: Array<{ name: string; mime?: string; size: number }>;
    }
  | { kind: "hydrate"; chat: ChatState; verifiedInputIds?: string[] }
  | { kind: "prependHistory"; sessionId: string; items: MobileHistoryItem[] }
  | { kind: "reset" }
  | { kind: "stream_epoch_changed" }
  | { kind: "replay"; events: unknown[] }
  /** Earlier CLI-room transcript events, placed before everything shown. */
  | { kind: "prependEvents"; key: string; events: unknown[] }
  | { kind: "append"; events: unknown[] };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "goalProjection":
      return state.goalId === action.expected.goalId &&
        state.goalRevision === action.expected.revision
        ? reduceStream(state, action.raw)
        : state;
    case "raw":
      // Child agent output lives in the child view (Desktop's parent feed).
      return reduceScopedStream(state, action.raw);
    case "user":
      return appendUserMessage(state, action.text, action.attachments, action.clientMessageId);
    case "prependHistory": {
      if (state.sessionId !== action.sessionId) return state;
      const seen = new Set(state.items.map((item) => item.id));
      return {
        ...state,
        items: [...action.items.filter((item) => !seen.has(item.id)), ...state.items],
      };
    }
    case "hydrate": {
      const ids = new Set(
        action.chat.items.flatMap((item) =>
          item.kind === "user" && item.clientMessageId ? [item.clientMessageId] : [],
        ),
      );
      for (const id of action.verifiedInputIds ?? []) ids.add(id);
      const pending = state.items.filter(
        (item) => item.kind === "user" && item.clientMessageId && !ids.has(item.clientMessageId),
      );
      return { ...action.chat, items: [...action.chat.items, ...pending] };
    }
    case "reset":
      return initialChatState();
    case "stream_epoch_changed": {
      const seq = state.seq + 1;
      return {
        ...state,
        seq,
        run: "idle",
        liveByAgent: {},
        orphanResults: undefined,
        items: state.items.map((item) =>
          item.kind === "assistant"
            ? { ...item, done: true }
            : item.kind === "tool"
              ? { ...item, id: `prior-${seq}-${item.id}`, done: true }
              : item,
        ),
      };
    }
    case "replay":
      return action.events.reduce(reduceScopedStream, initialChatState());
    case "prependEvents": {
      // Reduced on their own: ids are namespaced so they never collide with
      // (or seal) items of the conversation already displayed.
      const earlier = action.events.reduce(reduceStream, initialChatState()).items;
      return {
        ...state,
        items: [
          ...earlier.map((item) => ({ ...item, id: `earlier-${action.key}-${item.id}` })),
          ...state.items,
        ],
      };
    }
    case "append":
      return action.events.reduce(reduceScopedStream, state);
  }
}

/**
 * The remote chat reducer with render batching. Live stream envelopes arrive
 * one per token; callers `push` them into the returned batcher, which applies
 * token deltas as one `append` per frame. Every other chat action flushes the
 * buffer first, and callers flush before handling any other inbound message,
 * so the reducer still sees exactly the arrival order.
 */
export function useBatchedChatReducer(
  init: () => ChatState,
): [ChatState, (action: ChatAction) => void, StreamBatcher] {
  const [chat, dispatchNow] = useReducer(chatReducer, undefined, init);
  const batcherRef = useRef<StreamBatcher | null>(null);
  batcherRef.current ??= createStreamBatcher((events) => dispatchNow({ kind: "append", events }));
  const batcher = batcherRef.current;
  const dispatch = useCallback(
    (action: ChatAction) => {
      batcher.flush();
      dispatchNow(action);
    },
    [batcher],
  );
  useEffect(() => () => batcher.flush(), [batcher]);
  return [chat, dispatch, batcher];
}
