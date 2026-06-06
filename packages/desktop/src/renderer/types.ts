/**
 * Renderer-local message model. The agent worker streams individual
 * StreamEvents; the renderer accumulates them into a list of Message
 * objects that React renders. One assistant text reply is one
 * Message; one tool call (start → result) is one Message.
 */

import type { StreamEvent, TaskInfo } from "@cjhyy/code-shell-core";
import type { ApprovalRequestEnvelope } from "../preload/types";
import { aggregateFileChangeSummary } from "./messages/fileChangeAggregator";

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
  /** Epoch ms the user sent this message. Absent on replayed/historical
   *  transcripts (FoldItem carries no timestamp) — render nothing then. */
  createdAt?: number;
}

export interface AssistantMessage {
  kind: "assistant";
  id: string;
  text: string;
  done: boolean;
  /** Epoch ms this assistant turn began streaming. */
  createdAt?: number;
  /** Epoch ms this turn finished (done:true). Elapsed = doneAt − createdAt. */
  doneAt?: number;
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
  /** Resolved role the agent was dispatched as (e.g. "general-purpose",
   *  "explorer"). From agent_start.agentType. Undefined for an ephemeral
   *  agent (no role registry). Shown as a small badge in the card header. */
  agentType?: string;
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

/**
 * Goal-mode progress marker. Emitted once per judge verdict: `not_met` each
 * time the goal judge re-prompts the model (with its `gaps` + running round),
 * `met` when the goal is finally complete (round = total rounds), `exhausted`
 * when the continuation cap forces a stop. Rendered as a thin marker bar so
 * the user can count how many rounds the goal ran. Display-only.
 */
export interface GoalProgressMessage {
  kind: "goal_progress";
  id: string;
  status: "not_met" | "met" | "exhausted";
  round: number;
  gaps?: string;
}

/**
 * Lightweight marker for how a turn ended when it didn't end naturally
 * (TODO 2.8). Rendered as a thin right-aligned status line with a divider —
 * NOT a foldable tool/thinking card. `elapsedMs` drives "你在 Ns 后停止了".
 */
export interface TurnEndMessage {
  kind: "turn_end";
  id: string;
  reason: "stopped" | "timeout" | "error";
  /** Time from turn start to the end event, in ms (when known). */
  elapsedMs?: number;
  /** Optional detail for error/timeout. */
  detail?: string;
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

export interface FileEditEntry {
  path: string;
  added: number;
  removed: number;
  /** Number of tool calls that touched this path in this turn. */
  count: number;
}

export interface SessionFileDiff {
  /** Path touched by this session/turn-scoped edit operation. */
  path: string;
  /** Tool call that produced this diff; used only as stable provenance. */
  toolCallId: string;
  /** Synthetic unified diff generated from the tool's own edit payload. */
  diff: string;
}

/**
 * Codex-style "files changed this turn" summary card, appended on
 * turn_complete when at least one successful Edit/Write/NotebookEdit
 * fired since the last user message. Renderer-computed — no engine
 * event for this; see fileChangeAggregator.ts.
 */
export interface FilesChangedSummaryMessage {
  kind: "files_changed";
  id: string;
  files: FileEditEntry[];
  totalAdded: number;
  totalRemoved: number;
  /**
   * Session/turn-scoped diff snippets derived from the tool calls that
   * produced this card. This deliberately avoids asking Git for the
   * whole working tree, which can include changes from other sessions.
   */
  sessionDiffs?: SessionFileDiff[];
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
  | GoalProgressMessage
  | AskUserMessage
  | TurnEndMessage
  | FilesChangedSummaryMessage;

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
  /**
   * Monotonic counter incremented on each turn_complete. ToolCard /
   * ToolGroupCard subscribe via prop and force their open state back
   * to false when this changes, so prior-turn details fold out of the
   * way when a new turn finishes.
   */
  turnEpoch: number;
}

export const INITIAL_STATE: MessagesReducerState = {
  messages: [],
  streamingAssistantId: null,
  streamingThinkingId: null,
  sessionId: null,
  promptTokens: 0,
  activeAgents: {},
  agentMessageIndex: {},
  turnEpoch: 0,
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
/**
 * Clock for timestamping live messages. Returns epoch ms for live stream
 * events; transcript replay passes a clock returning `undefined` so old
 * sessions don't get stamped with the replay-time (which made hover footers
 * show today's time, e.g. "16:30", on historical content). Absent timestamps
 * render no footer — same as replayed user messages.
 */
export type MessageClock = () => number | undefined;

export function applyStreamEvent(
  state: MessagesReducerState,
  event: StreamEvent,
  now: MessageClock = Date.now,
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
      // If a subagent is active, this request_start belongs to it (the
      // event itself doesn't carry agentId). Don't open a new main
      // assistant message — that would create a phantom card in the feed.
      if (Object.keys(state.activeAgents).length > 0) return state;
      const id = freshId("assistant");
      return {
        ...state,
        messages: [
          ...state.messages,
          { kind: "assistant", id, text: "", done: false, createdAt: now() },
        ],
        streamingAssistantId: id,
        streamingThinkingId: null,
      };
    }

    case "text_delta": {
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
      // Subagent thinking is dropped — same as TUI. No user value in the
      // folded card, and rendering it would defeat the freeze fix.
      if (event.agentId) return state;
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
      const toolMsg: ToolMessage = {
        kind: "tool",
        id,
        toolName: event.toolCall.toolName,
        args: JSON.stringify(event.toolCall.args ?? {}),
        status: "running",
        // Use the clock, not a hard-coded Date.now(): on replay `now()` returns
        // the PERSISTED timestamp so a tool's startedAt reflects when it really
        // ran, not the replay moment. Hard-coding Date.now() made the turn span
        // stretch to "now" and grow on every reopen. Fall back to 0 (never the
        // replay clock) for legacy items with no timestamp — turnSpanMs/
        // spanDurationMs filter 0/non-finite stamps out.
        startedAt: now() ?? 0,
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
      return { ...state, messages: [...state.messages, toolMsg] };
    }

    case "tool_use_args_delta": {
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

    case "tool_result": {
      // Clock, not Date.now() — see tool_use_start. Replay supplies the
      // persisted end time; a missing stamp falls back to the tool's own
      // startedAt (→ 0ms span) rather than the replay clock.
      const endedAt = now() ?? undefined;
      const patch = (t: ToolMessage): ToolMessage => {
        const failed =
          event.result.error !== undefined || event.result.isError === true;
        const end = endedAt ?? t.startedAt;
        return {
          ...t,
          result: event.result.result,
          error: event.result.error,
          status: failed ? "failed" : "succeeded",
          endedAt: end,
          durationMs: Math.max(0, end - t.startedAt),
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
          toolCalls: m.toolCalls.map((t) =>
            t.id === event.result.id ? patch(t) : t,
          ),
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

    case "tool_summary": {
      // tool_summary has no agentId in the StreamEvent type; attach to the
      // most recent top-level tool message (existing behavior preserved).
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
            ? { ...m, done: true, doneAt: m.doneAt ?? now() }
            : m,
        ),
      };
    }

    case "task_update": {
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
            agentType: event.agentType,
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
      const idx = state.agentMessageIndex[event.agentId];
      const msgs = state.messages.slice();
      if (idx !== undefined) {
        const m = msgs[idx];
        if (m && m.kind === "agent") {
          // Idempotent / first-terminal-state-wins. The engine should now emit
          // exactly one agent_end per agent (the sub-agent wall-clock timeout
          // that raced completion was removed), but stay defensive: if a second
          // agent_end ever arrives for an already-finished agent, do NOT let a
          // later success overwrite an earlier error (a timed-out/failed agent
          // must not flip back to "done" with text). Keep the first terminal
          // result; just refresh activeAgents bookkeeping.
          if (!m.done) {
            const flushed = m.textBuffer.length > 0
              ? (m.text ?? "") + m.textBuffer
              : m.text;
            msgs[idx] = {
              ...m,
              done: true,
              text: event.text ?? flushed,
              textBuffer: "",
              error: event.error,
              endedAt,
            };
          }
        }
      }
      return { ...state, activeAgents: rest, messages: msgs };
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

    case "goal_progress": {
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            kind: "goal_progress",
            id: freshId("goal"),
            status: event.status,
            round: event.round,
            gaps: event.gaps,
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
      // 1. Flush every active agent's textBuffer to its `text` field.
      const msgs = state.messages.slice();
      for (const agentId of Object.keys(state.activeAgents)) {
        const idx = state.agentMessageIndex[agentId];
        if (idx === undefined) continue;
        const m = msgs[idx];
        if (!m || m.kind !== "agent" || m.textBuffer.length === 0) continue;
        msgs[idx] = {
          ...m,
          text: (m.text ?? "") + m.textBuffer,
          textBuffer: "",
        };
      }

      // 2. Finalize streaming pointers (existing behavior).
      const streamingAssistantId = state.streamingAssistantId;
      const streamingThinkingId = state.streamingThinkingId;
      const turnDoneAt = now();
      let finalized: Message[] = msgs.map((m) => {
        if (m.kind === "assistant" && m.id === streamingAssistantId) {
          return { ...m, done: true, doneAt: m.doneAt ?? turnDoneAt };
        }
        if (m.kind === "thinking" && m.id === streamingThinkingId) {
          return { ...m, done: true };
        }
        return m;
      });

      // 3. Compute the per-turn files-changed summary. Remove any
      //    prior files_changed from this user-turn first so multiple
      //    turn_complete events within one user-turn don't stack.
      let lastUserIdx = -1;
      for (let i = finalized.length - 1; i >= 0; i--) {
        if (finalized[i].kind === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        finalized = finalized.filter(
          (m, i) => !(i > lastUserIdx && m.kind === "files_changed"),
        );
      }
      const summary = aggregateFileChangeSummary(finalized);
      if (summary) {
        const entries = summary.files;
        const totalAdded = entries.reduce((acc, e) => acc + e.added, 0);
        const totalRemoved = entries.reduce((acc, e) => acc + e.removed, 0);
        finalized = [
          ...finalized,
          {
            kind: "files_changed",
            id: freshId("files-changed"),
            files: entries,
            totalAdded,
            totalRemoved,
            sessionDiffs: summary.sessionDiffs,
          },
        ];
      }

      // Only a cleanly completed turn bumps turnEpoch — that counter is what
      // force-collapses tool cards back to their summary (ToolGroupCard /
      // ToolCardShell watch it). An abnormal end (model_error, aborted_*,
      // prompt_too_long, …) often fires mid-task on a transient error and
      // should NOT yank the cards the user is reading shut; we still flush and
      // finalize above, just don't advance the epoch.
      const cleanlyCompleted = event.reason === "completed";
      return {
        ...state,
        streamingAssistantId: null,
        streamingThinkingId: null,
        messages: finalized,
        turnEpoch: cleanlyCompleted ? state.turnEpoch + 1 : state.turnEpoch,
      };
    }

    case "error": {
      // An empty error would render as a bare "Error: " block. Drop the
      // message but still clear streaming ids (the turn is over either way).
      const errText = (event.error ?? "").trim();
      return {
        ...state,
        messages: errText
          ? [...state.messages, { kind: "system", id: freshId("err"), text: `Error: ${errText}` }]
          : state.messages,
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
  /** Epoch ms to record as the send time. Omit on transcript replay
   *  (FoldItem has no original timestamp) so we don't stamp replay-time. */
  createdAt?: number,
): MessagesReducerState {
  return {
    ...state,
    messages: [
      ...state.messages,
      { kind: "user", id: freshId("user"), text, createdAt },
    ],
  };
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
): MessagesReducerState {
  const msg: TurnEndMessage = {
    kind: "turn_end",
    id: freshId("turn-end"),
    reason,
    elapsedMs,
    detail,
  };
  const msgs = state.messages.slice();
  const last = msgs[msgs.length - 1];
  if (last && last.kind === "turn_end") {
    msgs[msgs.length - 1] = msg;
  } else {
    msgs.push(msg);
  }
  return { ...state, messages: msgs };
}

export type ApprovalState = ApprovalRequestEnvelope | null;
