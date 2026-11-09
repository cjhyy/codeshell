/**
 * Direct state mutators the host calls outside the stream: optimistic user
 * sends, inline AskUserQuestion cards and their answers, pending-steer
 * cleanup, and the manual Stop / timeout turn-end marker.
 */

import type { PetChatAttachment } from "../../shared/pet-chat-attachments";
import type {
  AskUserMessage,
  MessageClock,
  MessagesReducerState,
  TurnEndMessage,
  UserMessage,
} from "../messageTypes";
import {
  freshId,
  sealToolWithoutResult,
  validTime,
  withTurnTiming,
  withTurnUsage,
} from "./helpers";

export function appendAskUserMessage(
  state: MessagesReducerState,
  payload: Omit<AskUserMessage, "kind" | "id">,
): MessagesReducerState {
  // A pending approval snapshot can race persisted history hydration. The
  // request identity survives both paths; keep its card and any existing answer.
  // A republished question (the user chose to keep waiting) only moves its deadline.
  const index = state.messages.findIndex(
    (m) => m.kind === "ask_user" && m.requestId === payload.requestId,
  );
  if (index >= 0) {
    const existing = state.messages[index] as AskUserMessage;
    if (
      existing.answer !== undefined ||
      (existing.expiresAt === payload.expiresAt && existing.keepWaitable === payload.keepWaitable)
    )
      return state;
    const messages = state.messages.slice();
    messages[index] = {
      ...existing,
      expiresAt: payload.expiresAt,
      keepWaitable: payload.keepWaitable,
    };
    return { ...state, messages };
  }
  return {
    ...state,
    messages: [...state.messages, { kind: "ask_user", id: freshId("ask"), ...payload }],
  };
}

export function markAskUserAnswered(
  state: MessagesReducerState,
  requestId: string,
  answer: string,
): MessagesReducerState {
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.kind === "ask_user" && m.requestId === requestId ? { ...m, answer } : m,
    ),
  };
}

export function appendUserMessage(
  state: MessagesReducerState,
  text: string,
  /** Epoch ms to record as the send time. Omit on transcript replay
   *  (FoldItem has no original timestamp) so we don't stamp replay-time. */
  createdAt?: number,
  /** True when this send sets/advances a persistent goal (drives ◎ marker). */
  isGoal?: boolean,
  /** True for engine-injected user turns (steer / goal wakeup) — see
   *  UserMessage.injected. */
  injected?: boolean,
  steerId?: string,
  pending?: boolean,
  clientMessageId?: string,
  attachments?: PetChatAttachment[],
  sourceEventId?: string,
): MessagesReducerState {
  const existing = clientMessageId
    ? state.messages.find(
        (m): m is UserMessage => m.kind === "user" && m.clientMessageId === clientMessageId,
      )
    : undefined;
  // New replies and accepted pending sends answer the ask; a delayed echo of
  // an older accepted message must not answer a question asked afterwards.
  if (
    !(injected ?? existing?.injected) &&
    !pending &&
    state.activeGoal?.waitingForUser &&
    (!existing || (existing.pending === true && pending === false))
  ) {
    state = { ...state, activeGoal: { ...state.activeGoal, waitingForUser: undefined } };
  }
  if (clientMessageId) {
    let replaced = false;
    const messages = state.messages.map((m) => {
      if (m.kind === "user" && m.clientMessageId === clientMessageId) {
        replaced = true;
        return {
          ...m,
          text,
          createdAt: createdAt ?? m.createdAt,
          isGoal: isGoal ?? m.isGoal,
          injected: injected ?? m.injected,
          steerId: steerId ?? m.steerId,
          pending: pending ?? m.pending,
          clientMessageId,
          attachments: attachments ?? m.attachments,
          ...(sourceEventId ? { sourceEventId } : {}),
        };
      }
      return m;
    });
    if (replaced) return { ...state, messages };
  }
  return {
    ...state,
    ...(!injected && !pending
      ? {
          singleTurnPromptTokens: 0,
          singleTurnCacheReadTokens: 0,
          singleTurnCacheCreationTokens: 0,
        }
      : {}),
    messages: [
      ...state.messages,
      {
        kind: "user",
        id: freshId("user"),
        text,
        createdAt,
        isGoal,
        injected,
        steerId,
        pending,
        clientMessageId,
        attachments,
        ...(sourceEventId ? { sourceEventId } : {}),
      },
    ],
  };
}

export function removePendingSteerMessages(
  state: MessagesReducerState,
  steerIds: Iterable<string>,
): MessagesReducerState {
  const ids = new Set(steerIds);
  if (ids.size === 0) return state;
  let changed = false;
  const messages = state.messages.filter((m) => {
    if (m.kind === "user" && m.pending && m.steerId && ids.has(m.steerId)) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? { ...state, messages } : state;
}

/**
 * Append a turn-end marker (TODO 2.8). Used for a manual Stop ("你在 Ns 后停止了")
 * and reusable for timeout/error endings. Idempotent-ish guard: if the last
 * message is already a turn_end, replace it rather than stacking duplicates
 * (double-stop clicks).
 */
export function appendTurnEndMessage(
  state: MessagesReducerState,
  reason: TurnEndMessage["reason"],
  elapsedMs?: number,
  detail?: string,
  clock: MessageClock = Date.now,
): MessagesReducerState {
  const msg: TurnEndMessage = {
    kind: "turn_end",
    id: freshId("turn-end"),
    reason,
    elapsedMs,
    detail,
  };
  const stoppedAt = clock();
  const activeAgents = { ...state.activeAgents };
  let latestUserIndex = -1;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i]!;
    if (message.kind === "user" && !message.injected && !message.pending) {
      latestUserIndex = i;
      break;
    }
  }
  const msgs = withTurnTiming(
    state.messages,
    {
      type: "turn_complete",
      reason: reason === "stopped" ? "aborted_streaming" : "model_error",
      durationMs: validTime(elapsedMs),
    },
    stoppedAt,
  ).map((message, index) => {
    if (index <= latestUserIndex) return message;
    if (message.kind === "assistant" && !message.done) {
      return { ...message, done: true, doneAt: message.doneAt ?? stoppedAt };
    }
    if (message.kind === "thinking" && !message.done) return { ...message, done: true };
    const toolStatus = reason === "stopped" ? "cancelled" : "failed";
    if (message.kind === "tool") {
      return sealToolWithoutResult(message, stoppedAt ?? message.startedAt, toolStatus);
    }
    if (message.kind === "agent" && !message.done && !message.backgrounded) {
      delete activeAgents[message.id];
      const endedAt = message.endedAt ?? stoppedAt ?? message.startedAt;
      return {
        ...message,
        done: true,
        endedAt,
        error: message.error ?? detail,
        text: (message.text ?? "") + message.textBuffer,
        textBuffer: "",
        toolCalls: message.toolCalls.map((tool) =>
          sealToolWithoutResult(tool, endedAt, toolStatus),
        ),
      };
    }
    return message;
  });
  // Keep repeat Stop clicks idempotent when the usage detail follows the marker.
  const usage = msgs[msgs.length - 1]?.kind === "turn_usage" ? msgs.pop() : undefined;
  const last = msgs[msgs.length - 1];
  if (last && last.kind === "turn_end") {
    msgs[msgs.length - 1] = msg;
  } else {
    msgs.push(msg);
  }
  // Clear the streaming pointers here so the interrupted turn can't leave a
  // STALE non-null streamingAssistantId behind. On the "打断接力" path (stop →
  // immediately re-send the queued input), the new turn must not inherit the
  // killed turn's streaming id — and the cancelled turn's late abort
  // turn_complete/error would otherwise race to clear it after the new turn
  // already started, extinguishing the "正在思考…" line. (interrupt-relay
  // missing thinking state)
  if (usage) msgs.push(usage);
  const activeKey = state.activeStreamRunKey;
  const activeRun = activeKey ? state.streamRuns?.[activeKey] : undefined;
  const latestUser = state.messages
    .slice()
    .reverse()
    .find((message) => message.kind === "user" && !message.injected && !message.pending);
  return {
    ...state,
    ...(activeKey && activeRun && activeRun.userMessageId === latestUser?.id
      ? {
          streamRuns: { ...state.streamRuns, [activeKey]: { ...activeRun, stopped: true } },
        }
      : {}),
    messages: withTurnUsage(msgs, state),
    activeAgents,
    streamingAssistantId: null,
    streamingThinkingId: null,
  };
}
