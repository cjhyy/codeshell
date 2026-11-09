/**
 * Tool-call stream events for both the main feed and sub-agent cards:
 * start, live argument deltas, result (with returned images) and the
 * natural-language summary. Each handler is one case of the reducer switch
 * in ../types.ts, moved verbatim.
 */

import type { StreamEvent } from "@cjhyy/code-shell-core";
import type {
  MessageClock,
  MessagesReducerState,
  ToolImageBlock,
  ToolMessage,
} from "../messageTypes";
import { sealStreamingThinking, toolDurationMs } from "./helpers";

export function applyToolUseStart(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "tool_use_start" }>,
  now: MessageClock,
): MessagesReducerState {
  const id = event.toolCall.id;
  const startedAt = now();
  const toolMsg: ToolMessage = {
    kind: "tool",
    id,
    toolName: event.toolCall.toolName,
    uiVisibility: event.toolCall.uiVisibility,
    args: JSON.stringify(event.toolCall.args ?? {}),
    status: "running",
    // Use the clock, not a hard-coded Date.now(): on replay `now()` returns
    // the PERSISTED timestamp so a tool's startedAt reflects when it really
    // ran, not the replay moment. Hard-coding Date.now() made the turn span
    // stretch to "now" and grow on every reopen. Fall back to 0 (never the
    // replay clock) for legacy items with no timestamp. Process grouping
    // filters missing/non-finite wall-clock stamps out.
    startedAt: startedAt ?? 0,
  };
  if (event.agentId) {
    const idx = state.agentMessageIndex[event.agentId];
    if (idx === undefined) return state;
    const msgs = state.messages.slice();
    const m = msgs[idx];
    if (!m || m.kind !== "agent") return state;
    // Idempotent: a duplicate tool_use_start for the same call id (provider
    // re-emit, stream replay/overlap) must NOT append a second tool with the
    // same id — that produces duplicate React keys and a doubled card.
    if (m.toolCalls.some((t) => t.id === id)) return state;
    msgs[idx] = {
      ...m,
      toolCalls: [...m.toolCalls, toolMsg],
      toolCount: m.toolCount + 1,
    };
    return { ...state, messages: msgs };
  }
  // Idempotent guard (see above) for the main feed.
  if (state.messages.some((m) => m.kind === "tool" && m.id === id)) return state;
  // A top-level tool begins a new visible segment. Finalize the prose that
  // preceded it so later text cannot be appended back above this card. This
  // is observable on Codex/Claude external runtimes, which use a single
  // stream_request_start for text → tool → text sequences. Drop an empty
  // placeholder (tool-first response); streamingAssistantId remains the
  // live-turn anchor so the next text_delta can create a new segment.
  // A tool call also ends the reasoning that led to it.
  const sealed = sealStreamingThinking(state.messages, state.streamingThinkingId);
  const messages = state.streamingAssistantId
    ? sealed.flatMap((message) => {
        if (
          message.kind !== "assistant" ||
          message.id !== state.streamingAssistantId ||
          message.done
        ) {
          return [message];
        }
        return message.text.length === 0
          ? []
          : [{ ...message, done: true, doneAt: message.doneAt ?? startedAt }];
      })
    : sealed;
  // Removing an empty assistant can shift agents that were started before
  // this tool arrived. Keep indexed child events attached to their owner.
  const agentMessageIndex =
    messages.length === state.messages.length
      ? state.agentMessageIndex
      : Object.fromEntries(
          messages.flatMap((message, index) =>
            message.kind === "agent" ? [[message.id, index]] : [],
          ),
        );
  return { ...state, messages: [...messages, toolMsg], agentMessageIndex };
}

export function applyToolUseArgsDelta(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "tool_use_args_delta" }>,
): MessagesReducerState {
  if (event.agentId) {
    const idx = state.agentMessageIndex[event.agentId];
    if (idx === undefined) return state;
    const msgs = state.messages.slice();
    const m = msgs[idx];
    if (!m || m.kind !== "agent") return state;
    msgs[idx] = {
      ...m,
      toolCalls: m.toolCalls.map((t) =>
        t.id === event.toolCallId
          ? { ...t, argsLive: { ...(t.argsLive ?? {}), ...event.args } }
          : t,
      ),
    };
    return { ...state, messages: msgs };
  }
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.kind === "tool" && m.id === event.toolCallId
        ? { ...m, argsLive: { ...(m.argsLive ?? {}), ...event.args } }
        : m,
    ),
  };
}

export function applyToolResult(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "tool_result" }>,
  now: MessageClock,
): MessagesReducerState {
  // Clock, not Date.now() — see tool_use_start. Replay supplies the
  // persisted end time; a missing stamp falls back to the tool's own
  // startedAt (→ 0ms span) rather than the replay clock.
  const endedAt = now() ?? undefined;
  // Surface any image blocks the tool returned (browser_observe vision/image,
  // view_image) so the card can show them — core streams them in the result
  // but the UI dropped them before this. Map to the minimal local shape.
  const images: ToolImageBlock[] | undefined = (event.result.contentBlocks ?? [])
    .filter(
      (b): b is typeof b & { source: { media_type: string; data: string } } =>
        b.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string",
    )
    .map((b) => ({ mediaType: b.source.media_type, data: b.source.data }));
  const patch = (t: ToolMessage): ToolMessage => {
    const failed = event.result.error !== undefined || event.result.isError === true;
    const end = endedAt ?? t.startedAt;
    return {
      ...t,
      result: event.result.result,
      images: images && images.length > 0 ? images : t.images,
      error: event.result.error,
      sandbox: event.result.sandbox,
      uiVisibility: event.result.uiVisibility ?? t.uiVisibility,
      status: failed ? "failed" : "succeeded",
      endedAt: end,
      durationMs: toolDurationMs(t.startedAt, end),
    };
  };
  if (event.agentId) {
    const idx = state.agentMessageIndex[event.agentId];
    if (idx === undefined) return state;
    const msgs = state.messages.slice();
    const m = msgs[idx];
    if (!m || m.kind !== "agent") return state;
    msgs[idx] = {
      ...m,
      toolCalls: m.toolCalls.map((t) => (t.id === event.result.id ? patch(t) : t)),
    };
    return { ...state, messages: msgs };
  }
  return {
    ...state,
    messages: state.messages.map((m) => {
      if (m.kind !== "tool" || m.id !== event.result.id) return m;
      return patch(m);
    }),
  };
}

export function applyToolSummary(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "tool_summary" }>,
): MessagesReducerState {
  const targetIds = event.toolCallIds ?? [];
  const targetToolId = targetIds.length > 0 ? targetIds[targetIds.length - 1] : undefined;

  if (event.agentId) {
    const idx = state.agentMessageIndex[event.agentId];
    if (idx === undefined) return state;
    const msgs = state.messages.slice();
    const m = msgs[idx];
    if (!m || m.kind !== "agent") return state;
    const targetIndex = targetToolId
      ? m.toolCalls.findIndex((t) => t.id === targetToolId)
      : m.toolCalls.length - 1;
    if (targetIndex < 0) return state;
    const toolCalls = m.toolCalls.map((t, i) =>
      i === targetIndex ? { ...t, summary: event.summary } : t,
    );
    msgs[idx] = { ...m, toolCalls };
    return { ...state, messages: msgs };
  }

  if (targetToolId) {
    let found = false;
    const messages = state.messages.map((m) => {
      if (m.kind !== "tool" || m.id !== targetToolId) return m;
      found = true;
      return { ...m, summary: event.summary };
    });
    return found ? { ...state, messages } : state;
  }

  // Legacy worker/snapshot compatibility: old tool_summary events carried
  // no ids, so keep attaching them to the most recent top-level tool.
  const msgs = state.messages.slice();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.kind === "tool") {
      msgs[i] = { ...m, summary: event.summary };
      return { ...state, messages: msgs };
    }
  }
  return state;
}
