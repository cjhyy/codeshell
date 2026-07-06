/**
 * Renderer-local message model. The agent worker streams individual
 * StreamEvents; the renderer accumulates them into a list of Message
 * objects that React renders. One assistant text reply is one
 * Message; one tool call (start → result) is one Message.
 */

import type { StreamEvent, TaskInfo } from "@cjhyy/code-shell-core";
import type { ApprovalRequestEnvelope } from "../preload/types";
import { aggregateFileChangeSummary } from "./messages/fileChangeAggregator";
import { translate } from "./i18n/translate";
import { loadUILanguage } from "./uiLanguage";

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
  /** True when this send established/advanced a persistent goal (CC /goal).
   *  Drives the ◎ goal marker on the message bubble. */
  isGoal?: boolean;
  /** True when this "user" message was INJECTED by the engine (step-gap steering
   *  / goal wakeup continuation), not typed by the user. The file-change
   *  aggregator treats it as transparent so a goal-driven task that spans many
   *  engine.run boundaries still summarizes ALL its edits, not just the last
   *  run's (TODO-background-panel #9). */
  injected?: boolean;
  /** Stable queued-steer id for optimistic step-in bubbles. */
  steerId?: string;
  /** Stable submit-intent id used to merge duplicate local/server echoes. */
  clientMessageId?: string;
  /** True until the engine echoes steer_injected for this steerId. */
  pending?: boolean;
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

/** A base64 image returned in a tool result (browser_observe vision/image,
 *  view_image). Minimal renderer-local shape — we only need to render it. */
export interface ToolImageBlock {
  mediaType: string;
  /** base64 (no data: prefix). */
  data: string;
}

export interface ToolMessage {
  kind: "tool";
  id: string;
  toolName: string;
  args: string; // serialized JSON snapshot at tool_use_start
  argsLive?: Record<string, unknown>; // updates while tool_use_args_delta streams
  result?: string;
  /** Image blocks the tool returned (screenshots etc.) — rendered as thumbnails. */
  images?: ToolImageBlock[];
  error?: string;
  status: ToolStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  /** Optional natural-language summary emitted via `tool_summary`. */
  summary?: string;
  /**
   * Sandbox info for tools that executed under it (Bash / background shell /
   * worktree). `backend: "off"` is set explicitly so the card shows「未隔离」
   * rather than nothing. Undefined for tools that don't touch the sandbox.
   */
  sandbox?: {
    backend: "off" | "seatbelt" | "bwrap";
    network?: "allow" | "deny";
  };
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
  /** True once the agent crossed the auto-background threshold and detached
   *  (StreamEvent agent_backgrounded). Still running, just no longer blocking
   *  the parent turn — so turn_complete's done-sweep must skip it, and the card
   *  shows "转后台 · 运行中". Implicitly irrelevant once done flips true. */
  backgrounded?: boolean;
  /** Epoch ms of the last agent_heartbeat covering this agent (B). Lets the
   *  card flag "可能失联" when a backgrounded agent stops pinging. */
  lastHeartbeat?: number;
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
  strategy: "micro" | "summary" | "window" | "snip" | "emergency" | "compacted";
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
  status: "not_met" | "met" | "exhausted" | "approaching_limit";
  round: number;
  gaps?: string;
  /** For "approaching_limit": turns left before the maxTurns cap (TODO 3.1). */
  turnsRemaining?: number;
  /** For "approaching_limit": consecutive blocks left before maxStopBlocks (TODO 3.1). */
  stopBlocksRemaining?: number;
  /** For "approaching_limit": which ceiling is closest — drives UI copy + extend default. */
  nearest?: "turns" | "stopBlocks";
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
  /**
   * Semantic coloring hint from the engine — `ok` (allow → green ✓),
   * `danger` (deny → red ✕), or absent/`neutral` (no coloring). Only trusted
   * first-party prompts (e.g. the credential-use gate) set it; LLM-authored
   * AskUserQuestion options arrive without it and render neutral.
   */
  tone?: "ok" | "danger" | "neutral";
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
  /**
   * The engine sessionId that ORIGINATED this prompt. Carried so the answer
   * routes back to that exact session's pending-approval map — deriving it from
   * the active bucket at answer time misroutes when the prompt belongs to a
   * background/non-active session (e.g. after a renderer remount left the route
   * table cold). Undefined for legacy/pre-bind prompts with no sessionId.
   */
  engineSessionId?: string;
  question: string;
  header?: string;
  options?: AskUserOption[];
  multiSelect: boolean;
  /** When true, only the listed options are offered — no "其它…" free-text
   *  box. Used by closed-set permission prompts whose answer is matched by
   *  exact label, where a typed answer would silently fail to match. */
  optionsOnly?: boolean;
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
  /**
   * Latest provider-reported prompt-cache counts, from the authoritative
   * usage_update emits. Feed the context-ring hover tooltip's hit rate.
   * undefined until the first usage_update that carries them (short/first
   * turns, or providers with no cache info, leave them undefined).
   */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * SESSION-CUMULATIVE cache/prompt totals (sum across every LLM response this
   * session). Drive the "本会话累计命中率" tooltip. Fed by the cumulative
   * usage_update emit (carries session* fields) from the engine turn boundary;
   * reset to 0 on a model switch (a new model has its own prompt cache).
   * Persisted to localStorage so they survive reload (rehydrate).
   */
  sessionCacheReadTokens: number;
  sessionCacheCreationTokens: number;
  sessionPromptTokens: number;
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
  /**
   * The session's active persistent goal (CC /goal). Set on `goal_set`,
   * round/progress updated by `goal_progress`, cleared on `goal_cleared` or
   * `goal_progress(met)`. Null when no goal is active. Drives the TopBar
   * status-popover Goal block + the goal-message marker.
   */
  activeGoal: { objective: string; round: number } | null;
}

export const INITIAL_STATE: MessagesReducerState = {
  messages: [],
  streamingAssistantId: null,
  streamingThinkingId: null,
  sessionId: null,
  promptTokens: 0,
  sessionCacheReadTokens: 0,
  sessionCacheCreationTokens: 0,
  sessionPromptTokens: 0,
  activeAgents: {},
  agentMessageIndex: {},
  turnEpoch: 0,
  activeGoal: null,
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

/** Shared text for a background-task completion (video etc.) — used by the
 *  reducer (message stream) and App.tsx (toast) so the two never drift. */
/** Max chars of a background agent's finalText to inline in the completion
 *  line. The full text already lives in the agent's own card (AgentMessage.text)
 *  — the stream/toast line is just a "✓ done · here's the gist" pointer, not a
 *  place to dump a multi-paragraph subagent report (that's what made completed
 *  background agents flood the transcript). */
const BG_COMPLETION_PREVIEW_CHARS = 160;

function previewLine(text: string, max = BG_COMPLETION_PREVIEW_CHARS): string {
  // Collapse whitespace/newlines so a long multi-line report doesn't render as
  // a tall block, then clip to one short preview.
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function bgCompletionText(event: {
  name?: string;
  description: string;
  status: "completed" | "failed";
  workKind?: "agent" | "shell" | "video" | "cc";
  command?: string;
  finalText?: string;
  error?: string;
}): string {
  const lang = loadUILanguage();
  // For background shells, `description` is English wakeup text meant for the
  // agent ("Background shell exited (exit 0): yt-dlp …"). Don't surface that raw
  // in the toast — use a localized name + the command as the preview instead.
  const isShell = event.workKind === "shell";
  const who = isShell
    ? translate(lang, "misc.bgTask.shellName")
    : (event.name ?? translate(lang, "misc.bgTask.defaultName"));
  const completedPreview = isShell
    ? previewLine(event.command ?? event.description)
    : previewLine(event.finalText ?? event.description);
  const failedPreview = isShell
    ? previewLine(event.command ?? event.description)
    : previewLine(event.error ?? event.description);
  if (event.status === "completed") {
    return translate(lang, "misc.bgTask.completed", {
      name: who,
      preview: completedPreview,
    });
  }
  return translate(lang, "misc.bgTask.failed", {
    name: who,
    preview: failedPreview,
  });
}

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

    case "steer_injected": {
      if (event.id) {
        let matched = false;
        const messages = state.messages.map((m) => {
          if (m.kind === "user" && m.steerId === event.id) {
            matched = true;
            return { ...m, pending: false, text: event.text, injected: true };
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
      // (a goal-driven task steers/wakes across many runs — #9).
      return appendUserMessage(state, event.text, now(), false, true);
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
      // Surface any image blocks the tool returned (browser_observe vision/image,
      // view_image) so the card can show them — core streams them in the result
      // but the UI dropped them before this. Map to the minimal local shape.
      const images: ToolImageBlock[] | undefined = (event.result.contentBlocks ?? [])
        .filter((b): b is typeof b & { source: { media_type: string; data: string } } =>
          b.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string",
        )
        .map((b) => ({ mediaType: b.source.media_type, data: b.source.data }));
      const patch = (t: ToolMessage): ToolMessage => {
        const failed =
          event.result.error !== undefined || event.result.isError === true;
        const end = endedAt ?? t.startedAt;
        return {
          ...t,
          result: event.result.result,
          images: images && images.length > 0 ? images : t.images,
          error: event.result.error,
          sandbox: event.result.sandbox,
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

    case "agent_backgrounded": {
      // The sync agent crossed the auto-background threshold and detached. Mark
      // it `backgrounded` (still running, NOT done) so the card renders
      // "转后台 · 运行中" and turn_complete's done-sweep skips it. No-op if the
      // agent already finished (a racing agent_end won the terminal state).
      const idx = state.agentMessageIndex[event.agentId];
      if (idx === undefined) return state;
      const m = state.messages[idx];
      if (!m || m.kind !== "agent" || m.done) return state;
      const msgs = state.messages.slice();
      msgs[idx] = { ...m, backgrounded: true };
      return { ...state, messages: msgs };
    }

    case "agent_heartbeat": {
      // B: liveness ping. Stamp lastHeartbeat on every still-running agent the
      // worker reports, so the card can flag "可能失联" when pings stop.
      const ids = new Set(event.agentIds);
      if (ids.size === 0) return state;
      let changed = false;
      const msgs = state.messages.map((m) => {
        if (m.kind === "agent" && !m.done && ids.has(m.id)) {
          changed = true;
          return { ...m, lastHeartbeat: event.ts };
        }
        return m;
      });
      return changed ? { ...state, messages: msgs } : state;
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
              backgrounded: false, // resolved → clear the "转后台·运行中" flag
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
      const msg: GoalProgressMessage = {
        kind: "goal_progress",
        id: freshId("goal"),
        status: event.status,
        round: event.round,
        gaps: event.gaps,
        turnsRemaining: event.turnsRemaining,
        stopBlocksRemaining: event.stopBlocksRemaining,
        nearest: event.nearest,
      };
      // The "approaching_limit" marker carries the "再续" button. Only prune it
      // when the moment has TRULY passed:
      //  - met/exhausted → the limit dimension settled / the run stopped.
      //  - a NEW approaching_limit → never stack two (re-announced after extend).
      // A "not_met" event means the goal is still advancing and may still be
      // nearing the cap, so the button must stay (fixes B2: previously not_met
      // pruned the button within the same turn it appeared).
      const dropApproaching =
        event.status === "met" ||
        event.status === "exhausted" ||
        event.status === "approaching_limit";
      const base = dropApproaching
        ? state.messages.filter(
            (m) => !(m.kind === "goal_progress" && m.status === "approaching_limit"),
          )
        : state.messages;
      // Track the active goal's round; clear it when the goal settles
      // (met = achieved, exhausted = gave up). not_met/approaching_limit keep
      // it active and bump the round so the popover shows "第 N 轮".
      const activeGoal =
        event.status === "met" || event.status === "exhausted"
          ? null
          : state.activeGoal
            ? { ...state.activeGoal, round: event.round }
            : state.activeGoal;
      return { ...state, messages: [...base, msg], activeGoal };
    }

    case "goal_set": {
      // A send established or replaced the session's persistent goal.
      return {
        ...state,
        activeGoal: { objective: event.objective, round: 0 },
      };
    }

    case "goal_cleared": {
      return { ...state, activeGoal: null };
    }

    case "usage_update": {
      // Two flavours share this event:
      //  1. Per-response / estimate emit (turn-loop): drives the live context
      //     reading `promptTokens` + last-known per-response cache counts.
      //  2. Session-cumulative emit (engine turn boundary): carries session*
      //     fields = totals across the whole session, driving the "本会话累计
      //     命中率" tooltip. It must NOT clobber the context reading, so when
      //     sessionPromptTokens is present we update ONLY the cumulative fields.
      if (event.sessionPromptTokens !== undefined) {
        return {
          ...state,
          sessionPromptTokens: event.sessionPromptTokens,
          sessionCacheReadTokens: event.sessionCacheReadTokens ?? 0,
          sessionCacheCreationTokens: event.sessionCacheCreationTokens ?? 0,
        };
      }
      // Cache counts ride only the authoritative (LLM-response) emits; the
      // estimate emits between calls omit them. Keep the last-known values on
      // those so the ring tooltip doesn't flicker its hit rate away to nothing.
      return {
        ...state,
        promptTokens: event.promptTokens,
        ...(event.cacheReadTokens !== undefined
          ? { cacheReadTokens: event.cacheReadTokens }
          : {}),
        ...(event.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: event.cacheCreationTokens }
          : {}),
      };
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
      // 1. Flush every active agent's textBuffer to its `text` field, and on a
      //    CLEAN completion also mark any still-running agent done. A cleanly
      //    completed main turn means no foreground subagent is legitimately
      //    still running — a leftover done:false agent is an orphan whose
      //    agent_end was dropped/raced (worker died, or agent_end arrived with
      //    no matching agent_start index). Without this sweep that orphan keeps
      //    `runningAgents` > 0 forever, so "后台 N 个子代理运行中…" sticks after
      //    the turn ends. (#4 stuck background count) A genuinely-backgrounded
      //    agent reports separately via background_agent_completed.
      const cleanSweep = event.reason === "completed";
      const msgs = state.messages.slice();
      for (const agentId of Object.keys(state.activeAgents)) {
        const idx = state.agentMessageIndex[agentId];
        if (idx === undefined) continue;
        const m = msgs[idx];
        if (!m || m.kind !== "agent") continue;
        const flushedText =
          m.textBuffer.length > 0 ? (m.text ?? "") + m.textBuffer : m.text;
        if (cleanSweep && !m.done && !m.backgrounded) {
          // Sweep only true ORPHANS (agent_start, no agent_end, agent_end
          // dropped/raced). A `backgrounded` agent is legitimately still running
          // after the parent turn ends — it reports done later via agent_end /
          // background_agent_completed — so it must NOT be swept here (else the
          // card collapses + loses its "running" state). Still flush its buffer.
          msgs[idx] = {
            ...m,
            text: flushedText,
            textBuffer: "",
            done: true,
            endedAt: m.endedAt ?? now(),
          };
        } else if (m.textBuffer.length > 0) {
          msgs[idx] = { ...m, text: flushedText, textBuffer: "" };
        }
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

      // 3. Compute the per-turn files-changed summary. Remove any prior
      //    files_changed from this logical task first so multiple turn_complete
      //    events don't stack. The boundary MUST match aggregateFileChangeSummary:
      //    scope to the last NON-injected user message. A goal/steer task spans
      //    many engine.run boundaries — each inserts an injected user turn — and
      //    the new card already re-aggregates edits from ALL of them. Anchoring
      //    the sweep on the last user message of ANY kind would leave earlier
      //    runs' cards standing (they sit before the injected user turn), so a
      //    file edited across runs would show in two cards (#9 follow-up).
      let lastUserIdx = -1;
      for (let i = finalized.length - 1; i >= 0; i--) {
        const m = finalized[i];
        if (m.kind === "user" && !m.injected) {
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
      // Belt-and-braces: a user-initiated Stop can surface as an abort-flavored
      // error event (the engine now suppresses these at the source, but other
      // paths may not). The "你停止了本轮" turn_end line already covers a stop,
      // so swallow abort text instead of stacking a red Error block on top.
      const isAbort = /\b(abort|aborted|cancell?ed|interrupt)\b/i.test(errText);
      return {
        ...state,
        messages: errText && !isAbort
          ? [...state.messages, { kind: "system", id: freshId("err"), text: `Error: ${errText}` }]
          : state.messages,
        streamingAssistantId: null,
        streamingThinkingId: null,
      };
    }

    case "background_agent_completed": {
      // A backgrounded sub-agent finished. Besides the system "✓ done" line,
      // RESOLVE its card to done — otherwise it stays {backgrounded:true,
      // done:false}, and once heartbeats stop (it's finished) the card wrongly
      // shows "可能失联" (bug: 转后台完成的卡全失联). The success handoff path in
      // core emits this event (not always a UI agent_end), so this is the
      // reliable place to close the card. Carries agentId → locate the card.
      const msgs = state.messages.slice();
      const agentId = (event as { agentId?: string }).agentId;
      if (agentId) {
        const idx = state.agentMessageIndex[agentId];
        if (idx !== undefined) {
          const m = msgs[idx];
          if (m && m.kind === "agent" && !m.done) {
            const isFail = (event as { status?: string }).status === "failed";
            msgs[idx] = {
              ...m,
              done: true,
              backgrounded: false,
              text: (event as { finalText?: string }).finalText ?? m.text,
              error: isFail ? (event as { error?: string }).error ?? m.error : m.error,
              endedAt: m.endedAt ?? now(),
            };
          }
        }
      }
      return {
        ...state,
        messages: [
          ...msgs,
          { kind: "system", id: freshId("bg-done"), text: bgCompletionText(event) },
        ],
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
  /** True when this send sets/advances a persistent goal (drives ◎ marker). */
  isGoal?: boolean,
  /** True for engine-injected user turns (steer / goal wakeup) — see
   *  UserMessage.injected. */
  injected?: boolean,
  steerId?: string,
  pending?: boolean,
  clientMessageId?: string,
): MessagesReducerState {
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
        };
      }
      return m;
    });
    if (replaced) return { ...state, messages };
  }
  return {
    ...state,
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
  // Clear the streaming pointers here so the interrupted turn can't leave a
  // STALE non-null streamingAssistantId behind. On the "打断接力" path (stop →
  // immediately re-send the queued input), the new turn must not inherit the
  // killed turn's streaming id — and the cancelled turn's late abort
  // turn_complete/error would otherwise race to clear it after the new turn
  // already started, extinguishing the "正在思考…" line. (interrupt-relay
  // missing thinking state)
  return { ...state, messages: msgs, streamingAssistantId: null, streamingThinkingId: null };
}

export type ApprovalState = ApprovalRequestEnvelope | null;
