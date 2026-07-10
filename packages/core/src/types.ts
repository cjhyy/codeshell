/**
 * Core type definitions for the code-shell orchestration framework.
 */

import type { GoalConfig, GoalTerminal } from "./engine/goal.js";

// ─── Content & Messages ───────────────────────────────────────────

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image" | "reasoning";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
  tool_use_id?: string;
  /**
   * 标记 tool_result 为出错,让 provider 据此设置 wire 层错误标志
   * (Anthropic 的 `is_error: true`)。不设的话,出错的工具只会以普通
   * content 文字回传,模型可能把超时/中断误当成成功。
   */
  is_error?: boolean;
  source?: { type: "base64"; media_type: string; data: string };
  // DeepSeek thinking-mode payload that must be echoed back verbatim
  // on the next request, alongside the assistant's content/tool_calls.
  reasoningContent?: string;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  name?: string;
  tool_call_id?: string;
}

// ─── Tool Types ───────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Omit this tool's result body from retained Goal-judge evidence. */
  sensitiveResult?: boolean;
}

export interface ToolCall {
  id: string;
  toolName: string;
  serverName?: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  toolName: string;
  /**
   * Sensitive tool results keep `result` as the model-facing value for the
   * current model round only. Persisted/displayed/streamed observers must use
   * `transcriptResult`/`displayResult` (or the standard placeholder) instead.
   */
  sensitive?: boolean;
  result?: string;
  displayResult?: string;
  transcriptResult?: string;
  /**
   * 结构化结果块(目前仅图片)。存在时优先于 `result` 用作发给 LLM 的
   * tool_result content —— view_image 用它把本地图片以 image ContentBlock
   * 回传,让 vision 模型能「看」自己生成的图。非视觉模型由 provider 的
   * stripVisionFromHistory 自动剥离,所以这里照常带图也安全。
   */
  contentBlocks?: ContentBlock[];
  error?: string;
  isError?: boolean;
  /**
   * Set by command-executing tools with sandbox visibility (Bash / background
   * shell / worktree / PowerShell) so the UI can show whether THIS call was isolated. `backend`
   * "off" means the command ran un-sandboxed (we surface it explicitly so the
   * user sees "未隔离" rather than guessing from an absent badge); "seatbelt"
   * / "bwrap" mean OS-level isolation applied. `network` is the policy that
   * was in force (absent when off). Tools with no sandbox visibility leave this
   * undefined and the UI renders no badge.
   */
  sandbox?: {
    backend: "off" | "seatbelt" | "bwrap";
    network?: "allow" | "deny";
  };
}

export type ToolSource = "builtin" | "mcp";

export type ToolPathPolicyOperation =
  | "read"
  | "write"
  | {
      /** Argument whose value decides whether this invocation reads or writes. */
      fromArg: string;
      /** Values that classify the operation as a read. */
      readValues?: string[];
      /** Values that classify the operation as a write. */
      writeValues?: string[];
      /** Fallback when the argument is absent or does not match either list. */
      default: "read" | "write";
    };

export type ToolPathPolicy =
  | {
      kind: "arg";
      /** Argument containing a file or directory path. */
      arg: string;
      operation: ToolPathPolicyOperation;
      /** Use ctx.cwd when the argument is omitted. Useful for Glob/Grep roots. */
      defaultToCwd?: boolean;
    }
  | {
      kind: "apply_patch";
      /** Argument containing the V4A patch text. */
      arg: string;
      operation: "write";
    };

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: ToolSource;
  serverName?: string;
  /**
   * Declarative UI/metadata hint for hosts, docs, and capability listings.
   * It is not an execution-policy input: PermissionClassifier does not read
   * RegisteredTool and runtime decisions come from explicit rules, permission
   * mode, approval backend, and tool-specific gates.
   */
  permissionDefault: PermissionDecision;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  /** Declaratively marks result bodies as sensitive for retained Goal evidence. */
  sensitiveResult?: boolean;
  /**
   * Declarative file-path safety metadata. ToolExecutor enforces this before
   * dispatching the tool, so file access cannot depend on each tool handler
   * remembering to call path-policy manually.
   */
  pathPolicy?: ToolPathPolicy[];
  /**
   * Explicitly marks a path-looking tool as intentionally outside the file
   * policy layer. Used by tests/audits so new file tools fail closed unless
   * they either declare pathPolicy or document an exemption.
   */
  pathPolicyExempt?: boolean;
  /**
   * Override the default tool execution timeout (ms).
   * Falls back to DEFAULT_TOOL_TIMEOUT_MS (120s) if unset.
   * The caller of executeTool() can still override via options.timeoutMs.
   */
  timeoutMs?: number;
}

// ─── Transcript Events ────────────────────────────────────────────

export type TranscriptEventType =
  | "message"
  | "tool_use"
  | "tool_result"
  | "summary"
  | "content_replace"
  | "file_history"
  | "plan_operation"
  | "session_meta"
  // A sub-agent was spawned this turn. Written at spawn time (regardless of
  // whether it later completes, is interrupted, or still runs) so replay can
  // rebuild its card by reading sessions/<agentId>/ — without it a backgrounded
  // sub-agent leaves no trace in the parent transcript and vanishes on reopen.
  // data = { agentId, name, description }; agentId === the sub-agent's session
  // id (agent_id===childSid), the key to fetch that session's state + result.
  | "subagent"
  // Files attributed to a completed external DriveAgent run. Persisted in the
  // parent transcript so desktop replay rebuilds the same per-user-turn file
  // summary as the live background_agent_completed stream event.
  | "external_file_changes"
  | "turn_boundary"
  | "goal_progress"
  // User interrupted the in-flight turn (pressed Stop). Persisted so a resume
  // can rebuild the renderer's "stopped" marker — without it the interrupted
  // turn loses its stopped flag on reload and wrongly folds behind the
  // "已处理 Xs ⌄" process-card header.
  | "turn_stopped"
  | "error";

export interface TranscriptEvent {
  id: string;
  type: TranscriptEventType;
  timestamp: number;
  turnNumber: number;
  data: Record<string, unknown>;
}

// ─── Session ──────────────────────────────────────────────────────

/**
 * Session lifecycle state persisted in state.json. `"active"` means a run is
 * currently in flight (or was, at the moment of the last heartbeat);
 * `"paused"` is a non-terminal hold (not a {@link TerminalReason}). Every
 * other value matches the TerminalReason the last run returned, so callers can
 * distinguish a user-cancelled session (`"aborted_streaming"`) from an actual
 * error (`"model_error"`, `"prompt_too_long"`, ...).
 */
export type SessionStatus = "active" | "paused" | TerminalReason;

/** Which host/context created a session — used by the desktop disk-rebuild to
 *  filter the sidebar (only `desktop` + `automation` are shown). */
export type SessionOrigin = "desktop" | "tui" | "automation" | "subagent";

export interface SessionWorkspace {
  root: string;
  kind: "main" | "worktree";
  worktree?: {
    path: string;
    branch: string;
    baseRef: string;
    createdBy: "codeshell";
  };
}

export interface ContextUsageAnchor {
  promptTokens: number;
  messageCount: number;
  estimateAtAnchor?: number;
  recordedAt: number;
  provider?: string;
  model?: string;
}

/** Provenance for a user-visible session fork. Optional on legacy sessions. */
export interface SessionForkLineage {
  sessionId: string;
  mode: "full" | "summary";
  fromEventId?: string;
  throughEventId?: string;
  sourceEventCount: number;
  createdAt: number;
}

export interface SessionState {
  sessionId: string;
  cwd: string;
  /** Current session workspace pointer. Absent only on legacy state.json files. */
  workspace?: SessionWorkspace;
  startedAt: number;
  model: string;
  provider: string;
  /**
   * Legacy/model-scoped usage summary. Some flows reset this accounting window
   * (for example model switches), so it must not drive whole-session metrics.
   */
  tokenUsage: TokenUsage;
  /**
   * Last provider-reported prompt-token count for the current context window.
   * Separate from cumulative tokenUsage; used only to seed context-size estimates
   * before the next provider response.
   */
  contextUsageAnchor?: ContextUsageAnchor;
  /**
   * Monotonic prompt-cache counters for the whole session. These only increase
   * from session start and are separate from the resettable tokenUsage window.
   * Optional on legacy state.json files; SessionManager normalizes them on load.
   */
  cumulativePromptTokens?: number;
  cumulativeCacheReadTokens?: number;
  cumulativeCacheCreationTokens?: number;
  turnCount: number;
  /**
   * Conversation-turn counter where ONE user message = one turn (incremented in
   * engine.run before the message hits the LLM). Distinct from `turnCount`,
   * which counts turn-loop iterations (a single user message can span many).
   * Tags file-history snapshots so turn-level `/undo` can revert exactly what
   * the last user message changed. Absent on legacy sessions → treated as 0.
   */
  turnSeq?: number;
  invokedSkills: string[];
  /**
   * Owning parent session for a sub-agent run; `null` explicitly marks a
   * top-level session (post-create marker). Absent only on legacy sessions
   * written before this field existed — the desktop disk-rebuild uses
   * "key present && null" to tell a new top-level session apart from legacy.
   */
  parentSessionId?: string | null;
  /** User-fork lineage; deliberately separate from sub-agent ownership. */
  forkedFrom?: SessionForkLineage;
  /**
   * Which host/context created this session. Desktop disk-rebuild shows only
   * `desktop` + `automation`. Absent on legacy sessions.
   */
  origin?: SessionOrigin;
  status: SessionStatus;
  /** Short summary derived from the first user message */
  summary?: string;
  /**
   * LLM-generated one-line title (auxModel, after the first turn). Distinct from
   * `summary` (the raw first-message fallback). Persisted so the sidebar shows
   * it after a localStorage wipe / disk rebuild — without this it lived only in
   * the renderer's localStorage index and was lost on reset.
   */
  title?: string;
  /** Persisted cost tracking state (survives process restart). */
  costState?: Record<string, unknown>;
  /**
   * Active persistent goal (CC `/goal` style). Set once, it survives across
   * messages AND manual interrupts until the judge says it's met or the user
   * clears it. Absent → no active goal. When a run supplies a new goal it
   * REPLACES this (one active goal per session). The judge's `met` verdict and
   * `agent/goalClear` both clear it. Persisted so it survives resume/refresh;
   * on resume the objective carries over but the run-scoped turn/token/time
   * baselines reset (matching CC). See engine.run goal-resolution.
   */
  activeGoal?: GoalConfig;
  /**
   * Last force-terminated goal instance. Kept separately from activeGoal so an
   * old whole-state writer cannot make that same exhausted goal armable again.
   * Optional for backward compatibility with pre-tombstone state.json files.
   */
  goalTerminal?: GoalTerminal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

// ─── Input Compilation ────────────────────────────────────────────

export interface CompiledInput {
  messages: Message[];
  rawText: string;
  options: InputOptions;
}

export interface InputOptions {
  slashCommand?: string;
  attachments?: Attachment[];
  mentionedFiles?: string[];
  images?: ImageAttachment[];
  allowedTools?: string[];
  modelOverride?: string;
}

export interface Attachment {
  path: string;
  content: string;
  mimeType: string;
}

export interface ImageAttachment {
  data: string;
  mediaType: string;
}

// ─── Permission ───────────────────────────────────────────────────

export type PermissionDecision = "allow" | "deny" | "ask";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "dontAsk"
  | "bypassPermissions"
  | "auto"
  | "plan";

export interface PermissionRule {
  tool: string;
  argsPattern?: Record<string, string | RegExp>;
  decision: PermissionDecision;
  reason?: string;
}

export interface ApprovalRequest {
  /** Originating engine session. Hosts use this only to route the prompt UI. */
  sessionId?: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  riskLevel: "low" | "medium" | "high";
}

/**
 * Scope of an "always allow" decision.
 *   "once"    — this single call only (default when always not set)
 *   "session" — remembered for the rest of the REPL session (in-memory)
 *   "project" — persisted to <cwd>/.code-shell/settings.local.json so it
 *               survives restart for the current project. Not committed.
 */
export type ApprovalScope = "once" | "session" | "project";

/**
 * Path granularity for a remembered file-tool grant (Write/Edit). Narrows the
 * remembered rule so "allow Write src/foo.ts for this session" doesn't become
 * "allow Write to ANY path".
 *   "file" — only this exact file
 *   "dir"  — this file's directory and its subdirectories
 *   "tool" — every path (the legacy tool-wide behavior)
 * Omitted → "tool" (back-compat). Ignored for non-file tools.
 */
export type ApprovalPathScope = "file" | "dir" | "tool";

export type ApprovalResult =
  | {
      approved: true;
      permanent?: boolean;
      always?: boolean;
      scope?: ApprovalScope;
      pathScope?: ApprovalPathScope;
      /** Used by AskUserQuestion to carry the user's free-text answer. */ answer?: string;
    }
  | { approved: false; reason?: string; always?: boolean; scope?: ApprovalScope };

// ─── Turn Loop ────────────────────────────────────────────────────

export type TurnPhase =
  | "pre_check"
  | "model_call"
  | "post_check"
  | "tool_exec"
  | "context_mgmt"
  | "hook_notify"
  | "complete"
  | "error";

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  status: "completed" | "tool_use" | "error" | "max_turns" | "aborted";
  error?: string;
}

export type TerminalReason =
  | "completed"
  | "stop_hook_prevented"
  | "hook_stopped"
  | "prompt_too_long"
  | "model_error"
  | "aborted_streaming"
  | "aborted_tools"
  | "max_turns"
  | "goal_budget_exhausted"
  | "image_error";

// ─── Streaming ────────────────────────────────────────────────────

export interface TaskInfo {
  id: string;
  subject: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "stopped";
}

export type PromptTokenSource =
  | "provider_usage"
  | "anchor_delta"
  | "anchor_rescale"
  | "calibrated_estimate"
  | "heuristic_estimate"
  | "session_cumulative";

export type PromptTokenConfidence = "high" | "medium" | "low";

export type StreamEvent =
  // Emitted once per run() as soon as the Engine has resolved the session
  // id (resume vs. create). Lets the client know the authoritative sid
  // *before* run() resolves, which matters for mid-turn `/sid` lookups.
  | {
      type: "session_started";
      sessionId: string;
      promptTokens: number;
      promptTokensSource?: PromptTokenSource;
      promptTokensConfidence?: PromptTokenConfidence;
    }
  // Emitted once, fire-and-forget, after the FIRST turn of a session
  // completes: an LLM-generated one-line title for the sidebar. Best-effort
  // — absent on failure / when aux model unavailable.
  | { type: "session_title"; sessionId: string; title: string }
  | { type: "stream_request_start"; turnNumber: number; messageId?: string; agentId?: string }
  // A host-queued user message was spliced into the running turn at the
  // turn-loop step boundary (Engine.enqueueSteer / 引导不打断注入). The client
  // uses this to flip a queued "待注入" chip to "已注入". `id` echoes the host's
  // queue-entry id so it can remove exactly that pending draft from its panel
  // (insert-time and bubble-display are decoupled — the panel item lives until
  // THIS event confirms the engine actually consumed it).
  | { type: "steer_injected"; text: string; id?: string }
  | { type: "text_delta"; text: string; tokens?: number; agentId?: string }
  | { type: "tool_use_start"; toolCall: ToolCall; agentId?: string }
  | {
      type: "tool_use_args_delta";
      toolCallId: string;
      args: Record<string, unknown>;
      agentId?: string;
    }
  | { type: "tool_result"; result: ToolResult; agentId?: string }
  | { type: "assistant_message"; message: Message; messageId?: string; agentId?: string }
  | { type: "turn_complete"; reason: TerminalReason; agentId?: string }
  // Goal mode visibility: emitted each time the goal judge re-prompts the
  // model ("not_met", carries the judge's `gaps` + the running round count),
  // when the goal is finally judged complete ("met", round = total rounds),
  // and when the continuation cap / run budget forces a stop ("exhausted").
  // The UI renders one marker bar per event so the user can count rounds.
  // No extra LLM call — `gaps` reuses the verdict the judge already produced.
  | {
      type: "goal_progress";
      status: "not_met" | "met" | "exhausted" | "approaching_limit";
      round: number;
      gaps?: string;
      /** For "approaching_limit": turns left before the maxTurns cap (TODO 3.1). */
      turnsRemaining?: number;
      /** For "approaching_limit": consecutive blocks left before maxStopBlocks (TODO 3.1). */
      stopBlocksRemaining?: number;
      /** For "approaching_limit": which ceiling is closest — drives UI copy + extend default. */
      nearest?: "turns" | "stopBlocks";
      agentId?: string;
    }
  // Persistent goal lifecycle (CC /goal style). `goal_set` fires when a send
  // establishes or REPLACES the session's active goal (`replaced` true on
  // replace). `goal_cleared` fires on explicit clear (agent/goalClear) — the
  // judge-met path emits goal_progress(met) instead. The UI keeps an
  // "active goal" per session from these + goal_progress.
  | { type: "goal_set"; objective: string; replaced: boolean }
  | { type: "goal_cleared" }
  | { type: "error"; error: string; agentId?: string }
  | { type: "tombstone"; messageId: string; agentId?: string }
  | { type: "task_update"; tasks: TaskInfo[]; agentId?: string }
  // 记忆被召回(用户拍板可见性):MemoryRead 命中一条记忆时发出,渲染端显示
  // 「📖 读取了记忆 X」,让用户肉眼看到持久记忆真的被用上了。usageCount 记账
  // 在工具内做,本事件仅为 UI 可见性。
  | {
      type: "memory_recalled";
      name: string;
      scope: "user" | "dream";
      location: "global" | "project";
      agentId?: string;
    }
  | { type: "thinking_delta"; text: string; agentId?: string }
  | { type: "agent_start"; agentId: string; name?: string; description: string; agentType?: string }
  | {
      // A sync sub-agent crossed the auto-background threshold and was detached
      // (handoffToBackground): still RUNNING, just no longer blocking the parent
      // turn. The UI uses this to render "转后台 · 运行中" and to keep the agent out
      // of turn_complete's done-sweep (it's not an orphan). Distinct from
      // agent_start (foreground running) and agent_end (finished).
      type: "agent_backgrounded";
      agentId: string;
      name?: string;
      description: string;
      agentType?: string;
    }
  | {
      type: "agent_end";
      agentId: string;
      name?: string;
      description: string;
      text?: string;
      error?: string;
      agentType?: string;
    }
  | {
      // Periodic liveness ping for backgrounded agents (B). The worker emits
      // every ~30s with the agentIds still running, so the UI knows they're
      // alive (vs stuck/dead) even during long LLM requests where no other
      // event fires.
      type: "agent_heartbeat";
      agentIds: string[];
      ts: number;
    }
  | { type: "tool_summary"; summary: string; toolCallIds?: string[]; agentId?: string }
  | {
      type: "context_compact";
      strategy: "micro" | "summary" | "window" | "snip" | "emergency" | "compacted";
      before: number;
      after: number;
      agentId?: string;
    }
  | {
      type: "usage_update";
      promptTokens: number;
      promptTokensSource?: PromptTokenSource;
      promptTokensConfidence?: PromptTokenConfidence;
      /**
       * Provider-reported prompt-cache counts, forwarded so the UI can show a
       * cache hit rate in the context-ring tooltip. Present only when the LLM
       * response carried them (authoritative-usage emits); omitted on the
       * message-estimate emits that fire between LLM calls. See
       * docs/todo/prompt-cache-optimization.md.
       */
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      /**
       * Prompt-cache metrics for the current turn only. These are reset at the
       * start of each turn-loop iteration and sum every LLM response in that
       * turn, including max-token continuations.
       */
      singleTurnPromptTokens?: number;
      singleTurnCacheReadTokens?: number;
      singleTurnCacheCreationTokens?: number;
      singleTurnCacheHitRate?: number;
      /**
       * Whole-session monotonic prompt-cache counters/rate. Unlike the legacy
       * session* fields below, these are not derived from the resettable
       * tokenUsage accounting window.
       */
      cumulativePromptTokens?: number;
      cumulativeCacheReadTokens?: number;
      cumulativeCacheCreationTokens?: number;
      cumulativeCacheHitRate?: number;
      /**
       * SESSION-CUMULATIVE cache counts (sum across every LLM response this
       * session, across runs and turns), emitted from the engine's turn
       * boundary off the persisted session.state.tokenUsage. Distinct from the
       * per-response cacheReadTokens/cacheCreationTokens above: those drive the
       * live context reading, these drive the "本会话累计命中率" tooltip. Reset
       * to 0 on a model switch. Present only on the cumulative (turn-boundary)
       * emit; omitted on per-response / estimate emits.
       */
      sessionCacheReadTokens?: number;
      sessionCacheCreationTokens?: number;
      sessionPromptTokens?: number;
      agentId?: string;
    }
  // B2.2 — background sub-agent/job finished (completed | failed | cancelled). Mirrors the
  // shape of NotificationItem in tool-system/builtin/agent-notifications.ts
  // so adapters between the two paths are trivial. Sub-agent cancellation stays
  // silent, but DriveAgent cancellation enqueues a cancelled event so the
  // detached external CLI job does not leave a session waiting forever.
  | {
      type: "background_agent_completed";
      agentId: string;
      name?: string;
      description: string;
      status: "completed" | "failed" | "cancelled";
      /**
       * What kind of background work this was. Lets UIs localize the
       * completion toast (e.g. a shell shows "命令完成" not the raw English
       * description, which is written for the agent's wakeup notification).
       * Absent for legacy sub-agent notifications (treated as "agent").
       */
      workKind?: "agent" | "shell" | "video" | "cc";
      /** For workKind === "shell": the command that ran (for a friendly label). */
      command?: string;
      /** Final assistant text (status === "completed" only). */
      finalText?: string;
      /** Error message (status === "failed" or "cancelled" only). */
      error?: string;
      /** External Claude/Codex session id, when workKind === "cc". */
      ccSessionId?: string;
      /** Files attributed to an external DriveAgent transcript. */
      changedFiles?: string[];
      /** Working directory used to canonicalize relative/absolute path aliases. */
      cwd?: string;
      /** Client id of the real user turn that launched this background work. */
      originClientMessageId?: string;
      /** When the bg agent finished (Date.now() value). */
      enqueuedAt: number;
    };

/**
 * Convenience extraction so SDK consumers and tests can import the
 * `background_agent_completed` payload shape without re-destructuring
 * the StreamEvent union themselves.
 */
export type BackgroundAgentCompletedEvent = Extract<
  StreamEvent,
  { type: "background_agent_completed" }
>;

export type StreamCallback = (event: StreamEvent) => void | Promise<void>;

// ─── LLM ──────────────────────────────────────────────────────────

/**
 * LLMConfig — model identity only. Everything in this object describes
 * "which model and how to reach it", nothing about user preferences or
 * client wiring. Hot-switching models replaces this object wholesale.
 *
 * For cross-model preferences (temperature, timeouts, image detail) see
 * ClientDefaults — those live on the Engine and feed every LLMClient
 * independently of model identity.
 */
export interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  /** Per-model context window size used by hosts to seed Engine.maxContextTokens. */
  maxContextTokens?: number;
  /**
   * Shell command whose stdout is the auth token (TODO 7.2). Resolved at
   * client-build time when `apiKey` is absent. The trimmed first line of
   * stdout becomes the bearer token.
   */
  authCommand?: string;
  /**
   * Extra HTTP headers for every request to this model's provider (TODO 7.2).
   * A value `$ENV_VAR` is resolved from the environment at build time.
   */
  httpHeaders?: Record<string, string>;
  /** OpenAI `service_tier` request param, passed through verbatim (TODO 7.2). */
  serviceTier?: string;
  /** OpenAI reasoning `summary` control ("auto"|"concise"|"detailed") (TODO 7.2). */
  reasoningSummary?: string;
  /**
   * Default reasoning/thinking setting for this model. Per-call
   * `options.reasoning` (e.g. summarize sub-calls) overrides this.
   * Translated to the per-vendor wire form by the client's capability layer.
   */
  reasoning?: import("./llm/reasoning-setting.js").ReasoningSetting;
  /**
   * The provider's `kind` (deepseek/openai/zai/openrouter/...). Used by
   * the capability layer to look up per-(kind, model) request-shape rules
   * (token-limit field, rejected sampling params, thinking shape, etc.).
   * Distinct from `provider` above, which is the protocol family
   * ("openai" or "anthropic") that picks which client class to use.
   */
  providerKind?: string;
  /**
   * Catalog-driven extra request-body fields (temperature/top_p/thinking etc),
   * already wire-mapped from the connection's paramValues. Merged into the
   * request body, each key filtered by the model's rejectedParams.
   */
  extraBody?: Record<string, unknown>;
}

/**
 * ClientDefaults — runtime knobs that apply regardless of which model is
 * active. Settings/UI source these once at boot (or when settings change);
 * model hot-switching never alters them.
 *
 * Anything model-specific belongs in LLMConfig instead.
 */
export interface ClientDefaults {
  /** Sampling temperature. Default 0.3. Per-call options.temperature overrides. */
  temperature?: number;
  /** HTTP timeout in ms for LLM requests. Default 120_000. */
  timeout?: number;
  /** Max retry attempts for transient errors. Default 3. */
  retryMaxAttempts?: number;
  /**
   * Provider-agnostic image clarity level. Drives the renderer-side
   * downscale (long-edge cap: low→~1024 / standard→~1568 / high→~2576)
   * so BOTH providers save tokens before send. On the OpenAI path it
   * also maps to the wire `detail` hint (low→low, standard/high→high);
   * Anthropic has no such param and saves purely via the downscale.
   * Defaults to "high" (full fidelity) when unset.
   *
   * Legacy "original" values from older settings are migrated to "high".
   */
  imageDetail?: "low" | "standard" | "high";
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  stopReason?: string;
  // Provider-side reasoning payload (e.g. DeepSeek V4 thinking mode).
  // Must be threaded back into the next request unchanged or the
  // upstream API rejects the call with HTTP 400.
  reasoningContent?: string;
}

export interface LLMStreamChunk {
  type: "text" | "tool_use_start" | "tool_use_delta" | "tool_use_end" | "stop";
  text?: string;
  /** Token count for this text delta, when provider can compute it. */
  tokens?: number;
  toolCall?: Partial<ToolCall>;
  stopReason?: string;
}

// ─── MCP ──────────────────────────────────────────────────────────

export type MCPTransport = "stdio" | "sse" | "streamable-http" | "inprocess";

export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: MCPTransport;
  headers?: Record<string, string>;
  /**
   * (stdio) NAMES of env vars to forward from the parent process to the
   * spawned server. The value is read from `process.env` at connect time —
   * the secret itself is never stored in config. Explicit `env` overrides.
   */
  envVars?: string[];
  /**
   * (HTTP) NAME of an env var whose value is sent as
   * `Authorization: Bearer <value>`. Read from `process.env` at connect time.
   */
  bearerTokenEnvVar?: string;
  /**
   * (HTTP) Map of header-name → env-var-NAME. Each header's value is read
   * from the named env var at connect time, keeping secrets out of config.
   */
  envHeaders?: Record<string, string>;
  /**
   * (HTTP) id of a stored credential (token/link/oauth) to use as Bearer auth.
   * OAuth credentials inject their current access token. Resolved at connect
   * time via CredentialStore; the secret is never stored in MCP config. Wins
   * over bearerTokenEnvVar.
   */
  credentialRef?: string;
  /**
   * Toggle a server off without deleting its config (mirrors Codex's
   * `enabled` field). Absent or `true` → connected; only the literal
   * `false` disables it. Filtered in MCPManager.connectAll so the
   * connection is never attempted; the entry stays in settings so the
   * UI toggle can flip it back on. See connectAll().
   */
  enabled?: boolean;
}

/**
 * User-supplied supplement for a PLUGIN-provided MCP server, keyed by the
 * server's `<plugin>:<server>` name. Stored globally under
 * `settings.mcpServerOverrides` and layered onto the plugin's config at merge
 * time (see mergePluginMcpServers). Only env/credential fields are allowed —
 * command/args/url/transport stay owned by the plugin manifest so a plugin
 * update is never shadowed by a stale user copy.
 */
export interface MCPServerOverride {
  env?: Record<string, string>;
  envVars?: string[];
  /** (HTTP) id of a stored token/link/oauth credential used as Bearer auth. */
  credentialRef?: string;
  bearerTokenEnvVar?: string;
  envHeaders?: Record<string, string>;
}

// ─── Settings ─────────────────────────────────────────────────────

/**
 * Shell-hook configuration entry from settings.json. Each entry binds
 * a hook event to a shell command. The command runs as a child process
 * on every emit (filtered by `matcher` when present), receives ctx
 * JSON on stdin, and returns a HookResult JSON on stdout. See
 * src/hooks/shell-runner.ts for the protocol spec.
 */
export interface SettingsHookConfig {
  event: string;
  command: string;
  /**
   * Optional regex (matched with new RegExp(matcher).test(toolName)) to
   * filter which tools fire this hook. Currently honored for
   * pre_tool_use / post_tool_use / on_tool_start / on_tool_end /
   * on_permission_check / file_changed. Ignored for events without a
   * meaningful toolName (session/turn/prompt/notification/compact).
   */
  matcher?: string;
  /** Per-hook timeout in milliseconds. Defaults to 60_000. */
  timeout_ms?: number;
  /**
   * Optional working directory for the spawned command. Defaults to
   * Engine.cwd. Useful for hooks that need to run in a sibling repo.
   */
  cwd?: string;
}

export interface Settings {
  model: {
    provider: string;
    name: string;
    apiKey?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
  };
  permissions: {
    defaultMode: PermissionMode;
    rules: PermissionRule[];
  };
  context: {
    maxTokens: number;
    compactAtRatio: number;
    summarizeAtRatio: number;
    microcompactFloorRatio: number;
  };
  session: {
    storageDir: string;
    maxHistory: number;
  };
  mcpServers: Record<string, MCPServerConfig>;
  instructions: {
    fileName: string;
    scanDirs: string[];
  };
  output: {
    format: "text" | "json" | "jsonl" | "stream-json";
  };
  /**
   * Optional shell-hook entries. Engine reads on construction and
   * registers a wrapper handler per entry that spawns the command and
   * parses the HookResult. Empty / missing = no shell hooks.
   */
  hooks?: SettingsHookConfig[];
}
