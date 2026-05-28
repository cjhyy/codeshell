/**
 * Renderer-local message model. The agent worker streams individual
 * StreamEvents; the renderer accumulates them into a list of Message
 * objects that React renders. One assistant text reply is one
 * Message; one tool call (start → result) is one Message.
 */

import type { StreamEvent, TaskInfo } from "@cjhyy/code-shell-core";
import type { ApprovalRequestEnvelope } from "../preload/types";

export type ToolStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled";

export interface UserMessage {
  kind: "user";
  id: string;
  text: string;
}

export interface AssistantMessage {
  kind: "assistant";
  id: string;
  text: string;
  done: boolean;
}

export interface ThinkingMessage {
  kind: "thinking";
  id: string;
  text: string;
  done: boolean;
  agentId?: string;
}

export interface ToolMessage {
  kind: "tool";
  id: string;
  toolName: string;
  args: string; // serialized JSON snapshot at tool_use_start
  argsLive?: Record<string, unknown>; // updates while tool_use_args_delta streams
  result?: string;
  error?: string;
  status: ToolStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  /** Optional natural-language summary emitted via `tool_summary`. */
  summary?: string;
}

export interface TaskListMessage {
  kind: "task_list";
  id: string;
  tasks: TaskInfo[];
}

export interface AgentMessage {
  kind: "agent";
  id: string; // === agentId
  name?: string;
  description: string;
  done: boolean;
  text?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** Tool calls made by this subagent, in arrival order. */
  toolCalls: ToolMessage[];
  /** Accumulating text_delta payload; flushed to `text` on turn_complete / agent_end. */
  textBuffer: string;
  /** Cheap counter for the folded header. Equals toolCalls.length. */
  toolCount: number;
}

export interface ContextBoundaryMessage {
  kind: "context_boundary";
  id: string;
  strategy: "micro" | "summary" | "window" | "snip" | "emergency";
  before: number;
  after: number;
}

export interface SystemMessage {
  kind: "system";
  id: string;
  text: string;
}

export interface AskUserOption {
  label: string;
  description: string;
}

/**
 * Inline AskUserQuestion prompt rendered as a message in the chat
 * stream (NOT as an approval modal). Engine emits this through the
 * approval channel with toolName "__ask_user__"; App routes it here
 * instead of into the approval queue. Once the user answers we send
 * `approve(requestId, "approve", undefined, answer)` and mark the
 * message answered so it won't keep rendering as actionable.
 */
export interface AskUserMessage {
  kind: "ask_user";
  id: string;
  requestId: string;
  question: string;
  header?: string;
  options?: AskUserOption[];
  multiSelect: boolean;
  /** Set after the user answers; chat then renders as resolved. */
  answer?: string;
}

export type Message =
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
  | ToolMessage
  | TaskListMessage
  | AgentMessage
  | ContextBoundaryMessage
  | SystemMessage
  | AskUserMessage;

export interface AgentRuntime {
  agentId: string;
  name?: string;
  description: string;
  startedAt: number;
}

export interface MessagesReducerState {
  messages: Message[];
  /**
   * Track which assistant message id is currently streaming. Set on
   * `stream_request_start` (we open a fresh assistant message),
   * cleared on `turn_complete`.
   */
  streamingAssistantId: string | null;
  /** Currently-streaming thinking-message id, if any. */
  streamingThinkingId: string | null;
  /** Authoritative engine session id (set on session_started). */
  sessionId: string | null;
  /** Latest known context token count (session_started / usage_update). */
  promptTokens: number;
  /** Currently-active sub-agents by id. */
  activeAgents: Record<string, AgentRuntime>;
  /**
   * agentId → index in `messages`. Set on agent_start. The `tombstone`
   * case updates these indices when a message is removed so the mapping
   * stays coherent for the agent's lifetime within an active session.
   * Cleared on saveTranscript truncation because slice() invalidates them.
   */
  agentMessageIndex: Record<string, number>;
}

export const INITIAL_STATE: MessagesReducerState = {
  messages: [],
  streamingAssistantId: null,
  streamingThinkingId: null,
  sessionId: null,
  promptTokens: 0,
  activeAgents: {},
  agentMessageIndex: {},
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
 */
export function applyStreamEvent(
  state: MessagesReducerState,
  event: StreamEvent,
): MessagesReducerState {
  switch (event.type) {
    case "session_started": {
      // Ignore event.promptTokens here: on resume, core reports the
      // *theoretical* size of the entire transcript file (byte/4
      // estimate), not the prompt that will actually be sent. That
      // produced the alarming "473k → 39k" jump in the ring. Wait for
      // the next usage_update — that's the real active prompt size.
      return {
        ...state,
        sessionId: event.sessionId,
      };
    }

    case "stream_request_start": {
      const id = freshId("assistant");
      return {
        ...state,
        messages: [...state.messages, { kind: "assistant", id, text: "", done: false }],
        streamingAssistantId: id,
        // A new request also implies thinking from the previous turn is done.
        streamingThinkingId: null,
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

    case "thinking_delta": {
      // Open a new ThinkingMessage if none is currently streaming.
      if (!state.streamingThinkingId) {
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
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.kind === "thinking" && m.id === state.streamingThinkingId
            ? { ...m, text: m.text + event.text }
            : m,
        ),
      };
    }

    case "tool_use_start": {
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
            status: "running",
            startedAt: Date.now(),
          },
        ],
      };
    }

    case "tool_use_args_delta": {
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.kind === "tool" && m.id === event.toolCallId
            ? { ...m, argsLive: { ...(m.argsLive ?? {}), ...event.args } }
            : m,
        ),
      };
    }

    case "tool_result": {
      const endedAt = Date.now();
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.kind !== "tool" || m.id !== event.result.id) return m;
          const failed =
            event.result.error !== undefined || event.result.isError === true;
          return {
            ...m,
            result: event.result.result,
            error: event.result.error,
            status: failed ? "failed" : "succeeded",
            endedAt,
            durationMs: endedAt - m.startedAt,
          };
        }),
      };
    }

    case "tool_summary": {
      // Attach to the most recent tool message.
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

    case "assistant_message": {
      // Finalize whichever assistant message is currently streaming;
      // engine sends this when it's emitted a complete assistant turn.
      if (!state.streamingAssistantId) return state;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.kind === "assistant" && m.id === state.streamingAssistantId
            ? { ...m, done: true }
            : m,
        ),
      };
    }

    case "task_update": {
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
        messages: [
          ...state.messages,
          { kind: "task_list", id: freshId("tasks"), tasks: event.tasks },
        ],
      };
    }

    case "agent_start": {
      const startedAt = Date.now();
      const newIndex = state.messages.length;
      return {
        ...state,
        activeAgents: {
          ...state.activeAgents,
          [event.agentId]: {
            agentId: event.agentId,
            name: event.name,
            description: event.description,
            startedAt,
          },
        },
        messages: [
          ...state.messages,
          {
            kind: "agent",
            id: event.agentId,
            name: event.name,
            description: event.description,
            done: false,
            startedAt,
            toolCalls: [],
            textBuffer: "",
            toolCount: 0,
          },
        ],
        agentMessageIndex: {
          ...state.agentMessageIndex,
          [event.agentId]: newIndex,
        },
      };
    }

    case "agent_end": {
      const endedAt = Date.now();
      const { [event.agentId]: _omit, ...rest } = state.activeAgents;
      return {
        ...state,
        activeAgents: rest,
        messages: state.messages.map((m) =>
          m.kind === "agent" && m.id === event.agentId
            ? { ...m, done: true, text: event.text, error: event.error, endedAt }
            : m,
        ),
      };
    }

    case "context_compact": {
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
          },
        ],
      };
    }

    case "usage_update": {
      return { ...state, promptTokens: event.promptTokens };
    }

    case "tombstone": {
      // Find the doomed message's index so we can adjust agentMessageIndex.
      const removedIdx = state.messages.findIndex((m) => m.id === event.messageId);
      if (removedIdx < 0) return state;
      const messages = state.messages.filter((_, i) => i !== removedIdx);
      // Drop the entry for the removed agent (if it was an AgentMessage),
      // decrement every index that pointed past the removed slot.
      const removed = state.messages[removedIdx]!;
      const agentMessageIndex: Record<string, number> = {};
      for (const [agentId, idx] of Object.entries(state.agentMessageIndex)) {
        if (removed.kind === "agent" && agentId === removed.id) continue;
        agentMessageIndex[agentId] = idx > removedIdx ? idx - 1 : idx;
      }
      return { ...state, messages, agentMessageIndex };
    }

    case "turn_complete": {
      return {
        ...state,
        streamingAssistantId: null,
        streamingThinkingId: null,
        messages: state.messages.map((m) => {
          if (m.kind === "assistant" && m.id === state.streamingAssistantId) {
            return { ...m, done: true };
          }
          if (m.kind === "thinking" && m.id === state.streamingThinkingId) {
            return { ...m, done: true };
          }
          return m;
        }),
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
        streamingThinkingId: null,
      };
    }

    default:
      return state; // unknown / unhandled events — ignore
  }
}

export function appendAskUserMessage(
  state: MessagesReducerState,
  payload: Omit<AskUserMessage, "kind" | "id">,
): MessagesReducerState {
  return {
    ...state,
    messages: [
      ...state.messages,
      { kind: "ask_user", id: freshId("ask"), ...payload },
    ],
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
      m.kind === "ask_user" && m.requestId === requestId
        ? { ...m, answer }
        : m,
    ),
  };
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
