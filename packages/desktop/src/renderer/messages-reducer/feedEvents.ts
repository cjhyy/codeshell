/**
 * Main-feed stream events: user / steer bubbles, run start, assistant text
 * and thinking streaming, the final assistant message, the task list and
 * context-compaction boundaries. Each handler is one case of the reducer
 * switch in ../types.ts, moved verbatim.
 */

import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { PetChatAttachment } from "../../shared/pet-chat-attachments";
import { closeOpenGoalWaits, startGoalClock } from "../goalClock";
import type {
  AssistantMessage,
  ContextBoundaryMessage,
  MessageClock,
  MessagesReducerState,
} from "../messageTypes";
import { appendUserMessage } from "./appenders";
import {
  assistantMessageToText,
  findThinkingFromEnd,
  freshId,
  sealStreamingThinking,
  withTurnTiming,
} from "./helpers";

function outputUserAttachments(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "session_user_message" | "steer_injected" }>,
): PetChatAttachment[] | undefined {
  return event.attachments?.flatMap((attachment) =>
    attachment.path
      ? [
          {
            kind: attachment.mime?.startsWith("image/")
              ? ("image" as const)
              : attachment.name.endsWith("/")
                ? ("directory" as const)
                : ("file" as const),
            path: attachment.path,
            absPath: attachment.absPath ?? attachment.path,
            sessionId: event.sessionId ?? state.sessionId ?? "",
            originalName: attachment.name,
            size: attachment.size,
            ...(attachment.mime ? { mime: attachment.mime } : {}),
          },
        ]
      : [],
  );
}

export function applySessionUserMessage(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "session_user_message" }>,
  now: MessageClock,
): MessagesReducerState {
  const hidden =
    event.injected === true ||
    event.authority === "agent" ||
    event.authority === "system" ||
    event.authority === "policy";
  if (hidden && !event.clientMessageId) return state;
  return appendUserMessage(
    state,
    hidden ? "" : event.text,
    now(),
    undefined,
    hidden || undefined,
    undefined,
    undefined,
    event.clientMessageId,
    hidden ? undefined : outputUserAttachments(state, event),
  );
}

export function applySessionStarted(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "session_started" }>,
  now: MessageClock,
): MessagesReducerState {
  // Ignore event.promptTokens here: on resume, core reports the
  // *theoretical* size of the entire transcript file (byte/4
  // estimate), not the prompt that will actually be sent. That
  // produced the alarming "473k → 39k" jump in the ring. Wait for
  // the next usage_update — that's the real active prompt size.
  // A new run of the goal: an open background wait has ended and the
  // goal clock runs for the run.
  const startedAt = now() ?? Date.now();
  return {
    ...state,
    sessionId: event.sessionId,
    messages: closeOpenGoalWaits(withTurnTiming(state.messages, event, now()), startedAt),
    ...(state.activeGoal && !("agentId" in event && event.agentId)
      ? { activeGoal: startGoalClock(state.activeGoal, startedAt) }
      : {}),
  };
}

export function applyStreamRequestStart(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "stream_request_start" }>,
  now: MessageClock,
): MessagesReducerState {
  // Sub-agent request starts carry agentId via the engine wrapper and do
  // not open a main assistant slot. Top-level starts have no agentId and
  // must not be routed based on the activeAgents table, which can contain
  // stale/orphan cleanup state during replay and background handoffs.
  if (event.agentId) {
    const index = state.agentMessageIndex[event.agentId];
    const agent = index === undefined ? undefined : state.messages[index];
    if (agent?.kind !== "agent" || agent.done) return state;
    if (event.messageId === agent.streamingTextRequest?.messageId) return state;
    // Legacy starts without an id still leave displayed text untouched,
    // but cannot let an older request claim later uncorrelated deltas.
    const messages = [...state.messages];
    messages[index!] = {
      ...agent,
      streamingTextRequest: event.messageId
        ? {
            messageId: event.messageId,
            startOffset: (agent.text?.length ?? 0) + agent.textBuffer.length,
          }
        : undefined,
    };
    return { ...state, messages };
  }
  const id = event.messageId ?? freshId("assistant");
  const startedAt = now();
  const previousId = state.streamingAssistantId;
  // The previous request's thinking is over; seal it before the pointer
  // reset below, or turn_complete can no longer find it.
  const sealed = sealStreamingThinking(state.messages, state.streamingThinkingId);
  const messages = previousId
    ? sealed.map((m) =>
        m.kind === "assistant" && m.id === previousId && !m.done
          ? { ...m, done: true, doneAt: m.doneAt ?? startedAt }
          : m,
      )
    : sealed;
  return {
    ...state,
    messages: [
      ...withTurnTiming(messages, event, startedAt),
      { kind: "assistant", id, text: "", done: false, createdAt: startedAt },
    ],
    streamingAssistantId: id,
    streamingThinkingId: null,
  };
}

export function applySteerInjected(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "steer_injected" }>,
  now: MessageClock,
): MessagesReducerState {
  const attachments = outputUserAttachments(state, event);
  // Older Host envelopes can carry the parent run's clientMessageId.
  // New producers bind the queued message to its own Session identity.
  const clientMessageId =
    event.sessionId && event.sessionId === state.sessionId ? event.clientMessageId : undefined;
  if (event.id) {
    let matched = false;
    const messages = state.messages.map((m) => {
      if (m.kind === "user" && (m.steerId === event.id || m.clientMessageId === event.id)) {
        matched = true;
        return {
          ...m,
          pending: false,
          text: event.text,
          injected: true,
          clientMessageId: clientMessageId ?? m.clientMessageId,
          attachments: attachments ?? m.attachments,
        };
      }
      return m;
    });
    if (matched) return { ...state, messages };
  }
  // 引导(不打断): the host queued this user message and the engine spliced
  // it into the running turn at a step boundary. Render it as a user bubble
  // in the feed so the injected guidance is visible inline (it really did
  // join the conversation — it's persisted to the transcript core-side).
  // Mark injected so it doesn't reset the file-change aggregation boundary
  // (a goal-driven task steers/wakes across many runs — #9). Carry the
  // steerId (event.id) so this bubble is protected by hydrate's steer guard
  // and dedupes against the disk replay of the SAME steerId — otherwise a
  // lagging snapshot would wipe it (the s-mr8s3w5i loss bug) or a later
  // hydrate would duplicate it. Since queueInput no longer plants an
  // optimistic bubble, this append IS the bubble's first appearance.
  return appendUserMessage(
    state,
    event.text,
    now(),
    false,
    true,
    event.id,
    false,
    clientMessageId,
    attachments,
  );
}

export function applyTextDelta(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "text_delta" }>,
  now: MessageClock,
): MessagesReducerState {
  // Subagent text never enters the main feed — it accumulates in the
  // owning AgentMessage's textBuffer and is flushed to `text` on
  // turn_complete / agent_end. This is the hot path that froze the
  // UI in session s-mpo7fju0-7d6942b7.
  if (event.agentId) {
    const idx = state.agentMessageIndex[event.agentId];
    if (idx === undefined) return state;
    const msgs = state.messages.slice();
    const m = msgs[idx];
    if (!m || m.kind !== "agent") return state;
    msgs[idx] = { ...m, textBuffer: m.textBuffer + event.text };
    return { ...state, messages: msgs };
  }
  if (!state.streamingAssistantId) return state;
  const streamingAssistant = state.messages.find(
    (message): message is AssistantMessage =>
      message.kind === "assistant" && message.id === state.streamingAssistantId,
  );
  // External runtimes open one provider stream for the whole turn, even
  // though that turn can contain several assistant text segments separated
  // by tools. tool_use_start finalizes the current segment but deliberately
  // keeps its id as the live-turn anchor; the next delta opens a fresh
  // AssistantMessage here. Native Engine streams still open their next
  // segment explicitly with stream_request_start, so both paths converge.
  // Answer text means the reasoning that preceded it has finished.
  const base =
    event.text.length > 0
      ? sealStreamingThinking(state.messages, state.streamingThinkingId)
      : state.messages;
  if (!streamingAssistant || streamingAssistant.done) {
    const id = freshId("assistant");
    return {
      ...state,
      messages: [
        ...base,
        { kind: "assistant", id, text: event.text, done: false, createdAt: now() },
      ],
      streamingAssistantId: id,
    };
  }
  return {
    ...state,
    messages: base.map((m) =>
      m.kind === "assistant" && m.id === state.streamingAssistantId
        ? { ...m, text: m.text + event.text }
        : m,
    ),
  };
}

export function applyThinkingDelta(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "thinking_delta" }>,
): MessagesReducerState {
  // Subagent thinking is dropped — same as TUI. No user value in the
  // folded card, and rendering it would defeat the freeze fix.
  if (event.agentId) return state;
  // A sealed (done) row belongs to an earlier phase of the stream — e.g.
  // reasoning that resumed after a tool call on a single-stream external
  // runtime. Open a new row in stream order instead of growing the old one.
  const liveThinking = findThinkingFromEnd(state.messages, state.streamingThinkingId);
  if (!liveThinking || liveThinking.message.done) {
    const id = freshId("thinking");
    return {
      ...state,
      streamingThinkingId: id,
      messages: [
        ...state.messages,
        { kind: "thinking", id, text: event.text, done: false, agentId: event.agentId },
      ],
    };
  }
  const messages = state.messages.slice();
  messages[liveThinking.index] = {
    ...liveThinking.message,
    text: liveThinking.message.text + event.text,
  };
  return { ...state, messages };
}

export function applyAssistantMessage(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "assistant_message" }>,
  now: MessageClock,
): MessagesReducerState {
  // Sub-agent final assistant messages are represented by agent_end/text
  // card state, not by the main assistant feed.
  if (event.agentId) return state;
  const finalText = assistantMessageToText(event.message.content);
  const targetId = event.messageId ?? state.streamingAssistantId;
  if (!targetId) return state;
  let found = false;
  const messages = state.messages.map((m) => {
    if (m.kind !== "assistant" || m.id !== targetId) return m;
    found = true;
    return {
      ...m,
      text: finalText ?? m.text,
      done: true,
      doneAt: m.doneAt ?? now(),
    };
  });
  if (!found && event.messageId && finalText !== undefined) {
    return {
      ...state,
      messages: [
        ...state.messages,
        {
          kind: "assistant",
          id: event.messageId,
          text: finalText,
          done: true,
          createdAt: now(),
          doneAt: now(),
        },
      ],
    };
  }
  return {
    ...state,
    messages,
  };
}

export function applyTaskUpdate(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "task_update" }>,
): MessagesReducerState {
  // Subagent task lists are intentionally not shown in the desktop UI.
  // Main agent's task panel stays uncluttered by subagent activity.
  if (event.agentId) return state;
  // Find the most recent TaskListMessage and update in place; if
  // none exists yet, append a new one.
  const msgs = state.messages.slice();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.kind === "task_list") {
      msgs[i] = { ...m, tasks: event.tasks };
      return { ...state, messages: msgs };
    }
  }
  return {
    ...state,
    messages: [...state.messages, { kind: "task_list", id: freshId("tasks"), tasks: event.tasks }],
  };
}

export function applyContextCompact(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "context_compact" }>,
): MessagesReducerState {
  const contextTransfer = (
    event as typeof event & {
      contextTransfer?: ContextBoundaryMessage["contextTransfer"];
    }
  ).contextTransfer;
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        kind: "context_boundary",
        id: freshId("ctx"),
        strategy: event.strategy,
        before: event.before,
        after: event.after,
        ...(contextTransfer ? { contextTransfer } : {}),
      },
    ],
  };
}
