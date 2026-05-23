/**
 * Renderer-local message model. The agent worker streams individual
 * StreamEvents; the renderer accumulates them into a list of Message
 * objects that React renders. One assistant text reply is one
 * Message; one tool call (start → result) is one Message.
 */

import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { ApprovalRequestEnvelope } from "../preload/types";

export type Message =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; done: boolean }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      args: string; // serialized
      result?: string; // serialized; undefined while running
      error?: string;
    }
  | { kind: "system"; id: string; text: string };

export interface MessagesReducerState {
  messages: Message[];
  /**
   * Track which assistant message id is currently streaming. Set on
   * `stream_request_start` (we open a fresh assistant message),
   * cleared on `turn_complete`.
   */
  streamingAssistantId: string | null;
}

export const INITIAL_STATE: MessagesReducerState = {
  messages: [],
  streamingAssistantId: null,
};

let _counter = 0;
function freshId(prefix: string): string {
  _counter += 1;
  return `${prefix}-${Date.now()}-${_counter}`;
}

/**
 * Fold a single StreamEvent into the message list. Pure — returns a
 * new state. Unknown event types are no-ops so future Engine event
 * additions don't break the renderer.
 *
 * NOTE: real ToolCall fields are `toolName` and `args` (not `name`/`input`).
 * Real ToolResult correlation field is `id` (not `toolCallId`).
 * Real ToolResult output field is `result?: string`, error field is `error?: string`.
 */
export function applyStreamEvent(
  state: MessagesReducerState,
  event: StreamEvent,
): MessagesReducerState {
  switch (event.type) {
    case "stream_request_start": {
      const id = freshId("assistant");
      return {
        messages: [...state.messages, { kind: "assistant", id, text: "", done: false }],
        streamingAssistantId: id,
      };
    }
    case "text_delta": {
      if (!state.streamingAssistantId) return state;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.kind === "assistant" && m.id === state.streamingAssistantId
            ? { ...m, text: m.text + event.text }
            : m,
        ),
      };
    }
    case "tool_use_start": {
      // ToolCall: { id, toolName, args, serverName? }
      const id = event.toolCall.id;
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            kind: "tool",
            id,
            toolName: event.toolCall.toolName,
            args: JSON.stringify(event.toolCall.args ?? {}),
          },
        ],
      };
    }
    case "tool_result": {
      // ToolResult: { id, toolName, result?: string, error?: string, isError?: boolean }
      // Correlate via `id` (not `toolCallId`)
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.kind === "tool" && m.id === event.result.id
            ? {
                ...m,
                result: event.result.result,
                error: event.result.error,
              }
            : m,
        ),
      };
    }
    case "turn_complete": {
      return {
        ...state,
        streamingAssistantId: null,
        messages: state.messages.map((m) =>
          m.kind === "assistant" && m.id === state.streamingAssistantId
            ? { ...m, done: true }
            : m,
        ),
      };
    }
    case "error": {
      return {
        ...state,
        messages: [
          ...state.messages,
          { kind: "system", id: freshId("err"), text: `Error: ${event.error}` },
        ],
        streamingAssistantId: null,
      };
    }
    default:
      return state; // unknown / unhandled events — ignore
  }
}

export function appendUserMessage(
  state: MessagesReducerState,
  text: string,
): MessagesReducerState {
  return {
    ...state,
    messages: [...state.messages, { kind: "user", id: freshId("user"), text }],
  };
}

export type ApprovalState = ApprovalRequestEnvelope | null;
