/**
 * Renderer message model: the Message union React renders and the
 * MessagesReducerState the stream reducer folds events into. Types only, so
 * the reducer modules under messages-reducer/ can share it without a
 * runtime import of ./types (which re-exports everything here).
 */

import type {
  ExternalChangedFilesProvenance,
  ExternalChangedFileRef,
  TurnDiffSnapshot,
} from "@cjhyy/code-shell-core";
import type { TaskInfo } from "@cjhyy/code-shell-core/internal";
import type { PetChatAttachment } from "../shared/pet-chat-attachments";

export type ToolStatus = "queued" | "running" | "succeeded" | "failed" | "denied" | "cancelled";

export interface UserMessage {
  kind: "user";
  id: string;
  text: string;
  /** Epoch ms the user sent this message. Legacy history may lack this stamp. */
  createdAt?: number;
  /** Run lifecycle timing, independent of individual assistant/tool segments. */
  turnTiming?: {
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    completed?: boolean;
    completedCleanly?: boolean;
  };
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
  /** Original persisted user event when replayed from a transcript window. */
  sourceEventId?: string;
  /** True until the engine echoes steer_injected for this steerId. */
  pending?: boolean;
  /** User-supplied Mimi attachments projected for chat rendering. */
  attachments?: PetChatAttachment[];
}

export interface AssistantMessage {
  kind: "assistant";
  id: string;
  text: string;
  done: boolean;
  /** Epoch ms this assistant segment began streaming. */
  createdAt?: number;
  /** Epoch ms this segment closed. Whole-run timing lives on its user anchor. */
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
  uiVisibility?: "hidden" | "milestones" | "full";
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
   * Sandbox info for tools with sandbox visibility (Bash / background shell /
   * worktree / PowerShell). `backend: "off"` is set explicitly so the card
   * shows「未隔离」rather than nothing. Undefined for tools that don't expose it.
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
  /** Current correlated child model request. The offset spans text + textBuffer
   *  so a parent-turn flush cannot move its revocation frontier. */
  streamingTextRequest?: { messageId: string; startOffset: number };
  /** Cheap counter for the folded header. Equals toolCalls.length. */
  toolCount: number;
}

export interface ContextBoundaryMessage {
  kind: "context_boundary";
  id: string;
  strategy: "micro" | "summary" | "window" | "snip" | "emergency" | "compacted" | "range" | "notes";
  before: number;
  after: number;
  contextTransfer?: {
    summary: string;
    sourceSessionId: string;
    fromEventId: string;
    toEventId: string;
    sourceEventCount: number;
    estimatedTokens: number;
  };
}

export interface SystemMessage {
  kind: "system";
  id: string;
  text: string;
  /** Latest execution-owned aggregate; empty files are an authoritative net-zero result. */
  turnDiff?: TurnDiffSnapshot;
  /** Capture timestamp retained when late child events rebuild this turn's card. */
  turnDiffCapturedAt?: number;
  /** Hidden attribution payload carried by a DriveAgent completion marker. */
  externalFileChanges?: {
    sourceId: string;
    cwd: string;
    files: string[];
    provenance?: ExternalChangedFilesProvenance;
    originClientMessageId?: string;
  };
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
  goalId?: string;
  status: "not_met" | "met" | "exhausted" | "approaching_limit";
  round: number;
  gaps?: string;
  /** For "approaching_limit": turns left before the maxTurns cap (TODO 3.1). */
  turnsRemaining?: number;
  /** For "approaching_limit": consecutive blocks left before maxStopBlocks (TODO 3.1). */
  stopBlocksRemaining?: number;
  /** For "approaching_limit": which ceiling is closest — drives UI copy + extend default. */
  nearest?: "turns" | "stopBlocks";
  /** The goal parked on finite background work (rendered as a wait, not a verdict). */
  waiting?: { sinceMs: number; tasks?: Array<{ kind: string; label: string }> };
  /** When the wait ended (the next run started or the goal moved on). */
  waitEndedAtMs?: number;
}

/** Renderer projection of the session's persisted Goal state. */
export interface ActiveGoal {
  objective: string;
  goalId?: string;
  /** Monotonic edit/pause generation used to fence late terminal events. */
  revision?: number;
  round: number;
  paused: boolean;
  /** When the objective was set (epoch ms); not elapsed working time. */
  setAtMs?: number;
  /** The Goal stopped to wait for the user's answer to this question. */
  waitingForUser?: string;
  /**
   * Goal-level active time (running + background waits), settled up to
   * `clockSinceMs` when that is set, else final. Absent before any marker
   * carried progress (older servers) — unknown history is not estimated.
   */
  activeMs?: number;
  /** The goal clock is running since this epoch ms (a run or a background wait). */
  clockSinceMs?: number;
  /** Parked on background work: the clock keeps running after the run ends. */
  waitingBackground?: boolean;
}

/**
 * Lightweight marker for how a turn ended when it didn't end naturally
 * Rendered as a compact status, separate from tool/thinking cards.
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

/**
 * What one completed turn consumed. The TUI has always printed this after each
 * turn; the desktop showed nothing, so an expensive run (one real session spent
 * 17.8M tokens over 35 turns) left no cost trace in the conversation. The
 * ContextRing is a context-window gauge, not a spend record.
 */
export interface TurnUsageMessage {
  kind: "turn_usage";
  id: string;
  /** Prompt tokens for this turn alone, not the session total. */
  promptTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
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
  /** The model's recommended choice; picked automatically if the question times out. */
  recommended?: boolean;
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
  /** Native approvals resolve authoritatively through Core; external runtimes retain their mirror. */
  source?: "external-runtime";
  expiresAt?: number;
  question: string;
  header?: string;
  options?: AskUserOption[];
  multiSelect: boolean;
  /** When true, only the listed options are offered — no "其它…" free-text
   *  box. Used by closed-set permission prompts whose answer is matched by
   *  exact label, where a typed answer would silently fail to match. */
  optionsOnly?: boolean;
  /** The agent continues working while this question remains available. */
  asynchronous?: boolean;
  /** The question auto-continues at `expiresAt` unless the user keeps waiting. */
  keepWaitable?: boolean;
  /** A model question the user may skip (permission prompts offer 拒绝 instead). */
  skippable?: boolean;
  /** Set after the user answers; chat then renders as resolved. */
  answer?: string;
}

export interface ExternalFileOrigin {
  kind: "external-agent";
  sourceId: string;
  cli?: "claude" | "codex";
  observedAt?: number;
  ref?: ExternalChangedFileRef;
}

export interface FileEditEntry {
  origin?: ExternalFileOrigin;
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
  /** Execution-owned original-to-final diff, or a legacy tool-payload preview. */
  diff: string;
}

/**
 * Codex-style "files changed this turn" summary card, appended on
 * execution updates and turn_complete. New runs use authoritative turn_diff
 * snapshots; older transcripts retain tool-payload previews.
 */
export interface FilesChangedSummaryMessage {
  kind: "files_changed";
  id: string;
  files: FileEditEntry[];
  totalAdded: number;
  totalRemoved: number;
  /**
   * Execution-owned original-to-final diffs, one per file. Older transcripts
   * and unresolved child writes retain explicitly incomplete tool previews.
   * Avoids including unrelated changes from the working tree.
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
  | TurnUsageMessage
  | FilesChangedSummaryMessage;

export interface AgentRuntime {
  agentId: string;
  name?: string;
  description: string;
  startedAt: number;
}

export interface MessagesReducerState {
  /** Lightweight live-run projections, retained while their user anchor exists. */
  streamRuns?: Record<string, StreamRunProjection>;
  activeStreamRunKey?: string;
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
  /** Prompt-cache totals for the current turn only. */
  singleTurnPromptTokens: number;
  singleTurnCacheReadTokens: number;
  singleTurnCacheCreationTokens: number;
  /** Whole-session monotonic prompt-cache totals. */
  cacheUsageVersion?: 1;
  cumulativePromptTokens: number;
  cumulativeCacheReadTokens: number;
  cumulativeCacheCreationTokens: number;
  /** Legacy aliases kept for localStorage migration. */
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
  /** Highest main-process session snapshot seq applied to this projection. */
  snapshotSeq: number;
  /** Main-process lifetime that owns snapshotSeq; absent on legacy caches. */
  snapshotEpoch?: string;
  /** A verified Session output prefix, separate from Main's transport lifetime. */
  outputCursor?: string;
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
  activeGoal: ActiveGoal | null;
}

export interface StreamRunProjection {
  runId?: string;
  clientMessageId?: string;
  userMessageId: string;
  streamingAssistantId: string | null;
  streamingThinkingId: string | null;
  promptTokens: number;
  singleTurnPromptTokens: number;
  singleTurnCacheReadTokens: number;
  singleTurnCacheCreationTokens: number;
  completed?: boolean;
  stopped?: boolean;
}

/**
 * Clock for timestamping live messages. Returns epoch ms for live stream
 * events; transcript replay passes a clock returning `undefined` so old
 * sessions don't get stamped with the replay-time (which made hover footers
 * show today's time, e.g. "16:30", on historical content). Absent timestamps
 * render no footer — same as replayed user messages.
 */
export type MessageClock = () => number | undefined;
