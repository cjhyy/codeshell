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
  | "error";

export interface TranscriptEvent {
  id: string;
  type: TranscriptEventType;
  timestamp: number;
  turnNumber: number;
  data: Record<string, unknown>;
}

// ─── Session ──────────────────────────────────────────────────────

export type SessionStatus = "active" | "paused" | "completed" | "errored";

export interface SessionState {
  sessionId: string;
  cwd: string;
  startedAt: number;
  model: string;
  provider: string;
  tokenUsage: TokenUsage;
  turnCount: number;
  invokedSkills: string[];
  parentSessionId?: string;
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

export type ApprovalResult =
  | {
      approved: true;
      permanent?: boolean;
      always?: boolean;
      scope?: ApprovalScope;
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
  | "image_error";

// ─── Streaming ────────────────────────────────────────────────────

export interface TaskInfo {
  id: string;
  subject: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "stopped";
}

export type StreamEvent =
  | { type: "stream_request_start"; turnNumber: number; agentId?: string }
  | { type: "text_delta"; text: string; agentId?: string }
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
  | { type: "error"; error: string; agentId?: string }
  | { type: "tombstone"; messageId: string }
  | { type: "task_update"; tasks: TaskInfo[] }
  | { type: "thinking_delta"; text: string; agentId?: string }
  | { type: "agent_start"; agentId: string; description: string }
  | { type: "agent_end"; agentId: string; description: string; error?: string }
  | { type: "tool_summary"; summary: string }
  | {
      type: "context_compact";
      strategy: "summary" | "window" | "snip" | "emergency";
      before: number;
      after: number;
      agentId?: string;
    };

export type StreamCallback = (event: StreamEvent) => void | Promise<void>;

// ─── LLM ──────────────────────────────────────────────────────────

export interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeout?: number;
  retryMaxAttempts?: number;
  enableStreaming?: boolean;
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
}

// ─── Settings ─────────────────────────────────────────────────────

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
}
