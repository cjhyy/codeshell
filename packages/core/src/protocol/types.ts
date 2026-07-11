/**
 * Agent protocol — JSON-RPC-style messages for client-server communication.
 *
 * The protocol separates the agent engine (server) from the UI (client).
 * Communication is bidirectional:
 *   Client → Server: requests (run, approve, cancel, configure, query)
 *   Server → Client: notifications (stream events, approval requests)
 *   Server → Client: responses (results of requests)
 */

import type {
  StreamEvent,
  TokenUsage,
  TerminalReason,
  ApprovalRequest,
  ApprovalResult,
  PermissionMode,
} from "../types.js";

// ─── Envelope ───────────────────────────────────────────────────────

export interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: RpcError;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

// ─── Error Codes ────────────────────────────────────────────────────

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Custom codes
  Overloaded: -32001,
  SessionNotFound: -32002,
  SessionClosed: -32004,
  /**
   * Run was cancelled by the user (ESC / Stop). Clients should treat
   * this as a clean terminal state, not a real error: no banner, no
   * red toast — just clear busy and stop streaming.
   */
  Cancelled: -32005,
} as const;

// ─── Client → Server Requests ───────────────────────────────────────

export type InputAttachmentKind = "image" | "file" | "directory";

export type InputAttachmentOrigin =
  | "paste"
  | "os-drop"
  | "file-panel"
  | "picker"
  | "mention"
  | "generated"
  | "tool";

export interface InputAttachmentMeta {
  id: string;
  sessionId: string;
  kind: InputAttachmentKind;
  origin: InputAttachmentOrigin;
  path: string;
  absPath: string;
  relPath?: string;
  mime?: string;
  size: number;
  sha256: string;
  originalName?: string;
  createdAt: number;
  sourcePath?: string;
  width?: number;
  height?: number;
  vision?: {
    include: boolean;
    mediaPath?: string;
    detail?: "low" | "standard" | "high";
  };
  directory?: {
    treePath?: string;
    truncated?: boolean;
    entryCount?: number;
  };
}

/** Start an agent run with a user task. */
export interface RunParams {
  sessionId: string; // required, client-minted
  task: string;
  /** Structured input attachments. Legacy `<codeshell-image>` task blocks remain supported. */
  attachments?: InputAttachmentMeta[];
  /** Stable id for the user's submit intent; duplicate ids are idempotent. */
  clientMessageId?: string;
  /**
   * Working directory for this run. When omitted, the Engine uses its
   * configured cwd.
   */
  cwd?: string;
  /**
   * Per-run permission mode supplied by desktop/composer UIs.
   * When omitted, the engine keeps its configured default.
   */
  permissionMode?: PermissionMode;
  /**
   * Per-run model pool key. Applied after the session exists and before the
   * turn starts, so cold desktop runs don't need a separate pre-run configure
   * request to a worker that has not been spawned yet.
   */
  model?: string;
  /**
   * Workspace trust for this run's project (`cwd`), asserted by the host
   * (desktop main from its trust-store) — never by the renderer. When false,
   * the engine strips dangerous fields from the project's own .code-shell
   * settings (permissions/env/hooks/mcpServers/localEnvironment). Omitted →
   * trusted (preserves behavior for hosts that don't wire trust).
   */
  projectTrusted?: boolean;
  /**
   * Per-run plan-mode flag. When true, the Engine enters plan mode for
   * this run; when omitted, the engine keeps its configured default.
   */
  planMode?: boolean;
  /**
   * Require the target session to already exist on disk. When true and the
   * session is absent, the run is rejected with `SessionNotFound` instead of
   * silently creating a fresh empty session. Used by cron "continue this
   * conversation" jobs: if the user deleted the target session, the job must
   * fail loudly (so it can be auto-disabled) rather than run its prompt against
   * a blank context. Omitted/false → the normal resume-or-create behavior.
   */
  requireExisting?: boolean;
  /**
   * Goal mode for this run. When set, the engine runs loop-until-done:
   * on each natural completion a GoalStopHook judges whether this goal is
   * met and re-prompts if not (bounded). Orthogonal to permissionMode.
   *
   * Accepts a bare objective string or a full GoalConfig (objective +
   * optional token/time budgets). Normalized at the engine run boundary.
   */
  goal?: string | import("../engine/goal.js").GoalConfig;
}

export interface RunResult {
  text: string;
  reason: TerminalReason;
  sessionId: string;
  turnCount: number;
  usage: TokenUsage;
}

/** Respond to an approval request from the server. */
export interface ApproveParams {
  sessionId: string;
  /** Connection owner echoed from ApprovalRequestNotification when present. */
  connectionId?: string;
  /** Session-owner generation echoed from ApprovalRequestNotification when present. */
  generation?: number;
  requestId: string;
  decision: ApprovalResult;
}

/** Cancel a running agent turn. */
export interface CancelParams {
  sessionId: string;
  reason?: string;
}

/** Close (destroy) a session. */
export interface CloseSessionParams {
  sessionId: string;
}

/** Reset a live session's workspace binding back to main. */
export interface ReleaseWorkspaceParams {
  sessionId: string;
}

/** Inject context into a session transcript. */
export interface InjectParams {
  sessionId: string;
  content: string;
}

/** Steer an in-flight run: queue a user message for the next turn-loop step. */
export interface SteerParams {
  sessionId: string;
  text: string;
  /** Structured input attachments that should ride with this queued steer. */
  attachments?: InputAttachmentMeta[];
  /** Stable host-side id for this queued draft. Rides through to the
   *  steer_injected event and is the handle Unsteer uses to revoke it. */
  id?: string;
  /** Stable submit-intent id, distinct from the queued steer id. */
  clientMessageId?: string;
}

/** Revoke a still-pending steer entry by id (before the loop consumes it). */
export interface UnsteerParams {
  sessionId: string;
  id: string;
}

/** Update runtime configuration. */
export interface ConfigureParams {
  /** When present, configure that specific chat session. Otherwise worker-global. */
  sessionId?: string;
  permissionMode?: PermissionMode;
  planMode?: boolean;
  bypassPermissions?: boolean;
  effort?: string;
  /** Switch active model by pool key (e.g. "sonnet", "haiku", "gpt"). */
  model?: string;
  /**
   * Re-read settings (providers[]/models[]) into the engine's ModelPool before
   * any model switch. Set after onboarding/login persists new entries so the
   * running engine picks them up without a process restart.
   */
  reloadModels?: boolean;
  /** Clear the live model pool, used after logout removes saved credentials. */
  clearModels?: boolean;
  /**
   * Re-read disk settings and hot-push the disk-default config fields (preset /
   * customSystemPrompt / appendSystemPrompt / personalization / mcpServers) +
   * settings hooks onto ALREADY-RUNNING sessions ("config hot-reload layer 2").
   * No sessionId → applies to every live session; with sessionId → that one.
   * Applied at the next turn boundary; in-flight turns are not interrupted.
   */
  reloadSettings?: boolean;
}

/** Query server state. */
export interface QueryParams {
  type:
    | "sessions"
    | "tools"
    | "config"
    | "session_detail"
    | "compact"
    | "config_set"
    | "config_get"
    | "permission_set"
    | "models"
    | "providers"
    | "arena_status"
    | "provider_add"
    | "provider_refresh"
    | "provider_delete"
    | "model_add"
    | "model_delete";
  sessionId?: string;
  /** Used by config_set / permission_set: dotted key path or mode field */
  key?: string;
  /** Used by config_set / permission_set: new value */
  value?: unknown;
  /** Used by provider_add: full ProviderConfig payload */
  provider?: unknown;
  /** Used by model_add: the new model entry */
  model?: unknown;
}

export interface QueryResult {
  type: string;
  data: unknown;
}

/** List / get session info. */
export interface SessionListResult {
  sessions: Array<{
    sessionId: string;
    cwd: string;
    startedAt: number;
    model: string;
    status: string;
    turnCount: number;
  }>;
}

export interface ToolListResult {
  tools: Array<{
    name: string;
    description: string;
  }>;
}

/** Shape of a model-pool entry returned by query("models"). */
export interface ProtocolModelEntry {
  key: string;
  label: string;
  model: string;
  /**
   * Protocol the LLM client speaks ("openai" or "anthropic"). DeepSeek,
   * Mistral, etc. all use "openai" since they're OpenAI-compatible.
   * NOT the brand/vendor — that's providerKey below.
   */
  protocol: string;
  /**
   * Pool entry's reference into settings.providers[]. Used by ModelManager
   * to derive each provider's modelCount client-side ("how many models
   * point at me"). Optional because auto-populated entries (autoPopulatePool)
   * don't go through the wizard and have no providers[] row.
   */
  providerKey?: string;
  active: boolean;
  /** Max output tokens (0 or undefined = unknown). */
  maxOutputTokens?: number;
  /** Max context window size (0 or undefined = unknown). */
  maxContextTokens?: number;
}

export interface ProtocolProviderEntry {
  key: string;
  label: string;
  kind: string;
  modelCount: number;
  cachedModels?: number;
  cachedAt?: string;
}

export interface ConfigResult {
  permissionMode: PermissionMode;
  planMode: boolean;
  preset?: string;
  model: string;
  cwd: string;
  maxContextTokens?: number;
}

// ─── Server → Client Notifications ─────────────────────────────────

/** Stream event forwarded from the engine (legacy, no sessionId). */
export interface StreamEventNotification {
  event: StreamEvent;
}

/** Multi-session stream event envelope — carries the originating sessionId. */
export interface AgentStreamEventNotification {
  sessionId: string;
  event: StreamEvent;
}

/** Server requests approval from the client (UI). */
export interface ApprovalRequestNotification {
  /** Originating engine session when known. */
  sessionId?: string;
  /** Connection owner required by strict multi-connection hosts. */
  connectionId?: string;
  /** Monotonic owner generation required by strict multi-connection hosts. */
  generation?: number;
  requestId: string;
  request: ApprovalRequest;
}

/** Server tells clients a pending approval/ask has been resolved elsewhere. */
export interface ApprovalResolvedNotification {
  /** Originating engine session when known. */
  sessionId?: string;
  requestId: string;
}

/** Server status changed. */
export interface StatusNotification {
  status: "ready" | "running" | "error" | "shutdown";
  message?: string;
}

// ─── Method Names ───────────────────────────────────────────────────

export const Methods = {
  // Client → Server
  Run: "agent/run",
  Approve: "agent/approve",
  Cancel: "agent/cancel",
  Configure: "agent/configure",
  Query: "agent/query",
  /** Inject context into transcript without triggering LLM. */
  Inject: "agent/inject",
  /** Steer an in-flight run: queue a user message spliced at the next step (不打断). */
  Steer: "agent/steer",
  /** Revoke a still-pending steer entry by id (撤回, before the loop consumes it). */
  Unsteer: "agent/unsteer",
  /** Close (destroy) a session. */
  CloseSession: "agent/closeSession",
  /** Reset a session's workspace binding to main without closing it. */
  ReleaseWorkspace: "agent/releaseWorkspace",
  /** Extend a running goal's turn/budget ceilings mid-run (TODO 3.1). */
  GoalExtend: "agent/goalExtend",
  /** Clear a session's persisted active goal (CC /goal clear). */
  GoalClear: "agent/goalClear",
  /** Read a session's persisted active goal, to re-surface it on session load. */
  GoalGet: "agent/goalGet",
  /** Query/control a session's background shells for the UI panel (TODO 3.2). */
  BackgroundShells: "agent/backgroundShells",
  /** Unified listing of a session's background work (shells + sub-agents + jobs)
   *  for the desktop background panel. Output/kill of a shell still goes through
   *  BackgroundShells by shellId; this is list-only across all three kinds. */
  BackgroundWork: "agent/backgroundWork",

  // Server → Client (notifications, no id)
  StreamEvent: "agent/streamEvent",
  ApprovalRequest: "agent/approvalRequest",
  /** Server-initiated resolution of a pending approval/ask (e.g. a goal-mode
   *  AskUserQuestion that timed out) so every client can dismiss its stale card
   *  without a user decision. Same envelope the desktop main broadcasts. */
  ApprovalResolved: "agent/approvalResolved",
  Status: "agent/status",
} as const;

// ─── Helpers ────────────────────────────────────────────────────────

let _nextId = 1;

export function createRequest(method: string, params?: Record<string, unknown>): RpcRequest {
  return { jsonrpc: "2.0", id: _nextId++, method, params };
}

export function createResponse(id: string | number, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function createErrorResponse(
  id: string | number,
  code: number,
  message: string,
  data?: unknown,
): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export function createNotification(
  method: string,
  params?: Record<string, unknown>,
): RpcNotification {
  return { jsonrpc: "2.0", method, params };
}

export function isRequest(msg: RpcMessage): msg is RpcRequest {
  return "method" in msg && "id" in msg;
}

export function isResponse(msg: RpcMessage): msg is RpcResponse {
  return "id" in msg && !("method" in msg);
}

export function isNotification(msg: RpcMessage): msg is RpcNotification {
  return "method" in msg && !("id" in msg);
}
