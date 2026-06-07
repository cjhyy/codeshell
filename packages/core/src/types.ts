/**
 * Core type definitions for the code-shell orchestration framework.
 */

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
  result?: string;
  /**
   * 结构化结果块(目前仅图片)。存在时优先于 `result` 用作发给 LLM 的
   * tool_result content —— view_image 用它把本地图片以 image ContentBlock
   * 回传,让 vision 模型能「看」自己生成的图。非视觉模型由 provider 的
   * stripVisionFromHistory 自动剥离,所以这里照常带图也安全。
   */
  contentBlocks?: ContentBlock[];
  error?: string;
  isError?: boolean;
}

export type ToolSource = "builtin" | "mcp";

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: ToolSource;
  serverName?: string;
  permissionDefault: PermissionDecision;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
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
  | "turn_boundary"
  | "goal_progress"
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

export interface SessionState {
  sessionId: string;
  cwd: string;
  startedAt: number;
  model: string;
  provider: string;
  tokenUsage: TokenUsage;
  turnCount: number;
  invokedSkills: string[];
  /**
   * Owning parent session for a sub-agent run; `null` explicitly marks a
   * top-level session (post-create marker). Absent only on legacy sessions
   * written before this field existed — the desktop disk-rebuild uses
   * "key present && null" to tell a new top-level session apart from legacy.
   */
  parentSessionId?: string | null;
  /**
   * Which host/context created this session. Desktop disk-rebuild shows only
   * `desktop` + `automation`. Absent on legacy sessions.
   */
  origin?: SessionOrigin;
  status: SessionStatus;
  /** Short summary derived from the first user message */
  summary?: string;
  /** Persisted cost tracking state (survives process restart). */
  costState?: Record<string, unknown>;
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

export type StreamEvent =
  // Emitted once per run() as soon as the Engine has resolved the session
  // id (resume vs. create). Lets the client know the authoritative sid
  // *before* run() resolves, which matters for mid-turn `/sid` lookups.
  | { type: "session_started"; sessionId: string; promptTokens: number }
  // Emitted once, fire-and-forget, after the FIRST turn of a session
  // completes: an LLM-generated one-line title for the sidebar. Best-effort
  // — absent on failure / when aux model unavailable.
  | { type: "session_title"; sessionId: string; title: string }
  | { type: "stream_request_start"; turnNumber: number; agentId?: string }
  | { type: "text_delta"; text: string; tokens?: number; agentId?: string }
  | { type: "tool_use_start"; toolCall: ToolCall; agentId?: string }
  | {
      type: "tool_use_args_delta";
      toolCallId: string;
      args: Record<string, unknown>;
      agentId?: string;
    }
  | { type: "tool_result"; result: ToolResult; agentId?: string }
  | { type: "assistant_message"; message: Message; agentId?: string }
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
  | { type: "error"; error: string; agentId?: string }
  | { type: "tombstone"; messageId: string }
  | { type: "task_update"; tasks: TaskInfo[]; agentId?: string }
  | { type: "thinking_delta"; text: string; agentId?: string }
  | { type: "agent_start"; agentId: string; name?: string; description: string; agentType?: string }
  | { type: "agent_end"; agentId: string; name?: string; description: string; text?: string; error?: string; agentType?: string }
  | { type: "tool_summary"; summary: string }
  | {
      type: "context_compact";
      strategy: "micro" | "summary" | "window" | "snip" | "emergency";
      before: number;
      after: number;
      agentId?: string;
    }
  | {
      type: "usage_update";
      promptTokens: number;
      agentId?: string;
    }
  // B2.2 — background sub-agent finished (completed | failed). Mirrors the
  // shape of NotificationItem in tool-system/builtin/agent-notifications.ts
  // so adapters between the two paths are trivial. Status "cancelled" is
  // intentionally absent — the in-memory queue does not enqueue cancelled
  // agents (user explicitly stopped, no follow-up turn needed), and this
  // protocol event matches that policy.
  | {
      type: "background_agent_completed";
      agentId: string;
      name?: string;
      description: string;
      status: "completed" | "failed";
      /** Final assistant text (status === "completed" only). */
      finalText?: string;
      /** Error message (status === "failed" only). */
      error?: string;
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
   * OpenAI-style detail hint sent on every image_url part. Anthropic
   * ignores this. Defaults to "high" (OpenAI's own default) when
   * unset; "low" is 85-tokens-per-image fixed.
   */
  imageDetail?: "low" | "high" | "original";
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
   * Toggle a server off without deleting its config (mirrors Codex's
   * `enabled` field). Absent or `true` → connected; only the literal
   * `false` disables it. Filtered in MCPManager.connectAll so the
   * connection is never attempted; the entry stays in settings so the
   * UI toggle can flip it back on. See connectAll().
   */
  enabled?: boolean;
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
