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
  TaskInfo,
  LLMConfig,
  MCPServerConfig,
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
  EngineNotReady: -32001,
  SessionNotFound: -32002,
  AlreadyRunning: -32003,
  NotRunning: -32004,
} as const;

// ─── Client → Server Requests ───────────────────────────────────────

/** Start an agent run with a user task. */
export interface RunParams {
  task: string;
  sessionId?: string;
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
  requestId: string;
  decision: ApprovalResult;
}

/** Cancel a running agent. */
export interface CancelParams {
  reason?: string;
}

/** Inject context into a session transcript. */
export interface InjectParams {
  sessionId: string;
  content: string;
}

/** Update runtime configuration. */
export interface ConfigureParams {
  permissionMode?: PermissionMode;
  planMode?: boolean;
  bypassPermissions?: boolean;
  effort?: string;
  /** Switch active model by pool key (e.g. "sonnet", "haiku", "gpt"). */
  model?: string;
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
    | "permission_set"
    | "models"
    | "arena_status";
  sessionId?: string;
  /** Used by config_set / permission_set: dotted key path or mode field */
  key?: string;
  /** Used by config_set / permission_set: new value */
  value?: unknown;
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
  provider: string;
  active: boolean;
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

/** Stream event forwarded from the engine. */
export interface StreamEventNotification {
  event: StreamEvent;
}

/** Server requests approval from the client (UI). */
export interface ApprovalRequestNotification {
  requestId: string;
  request: ApprovalRequest;
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

  // Server → Client (notifications, no id)
  StreamEvent: "agent/streamEvent",
  ApprovalRequest: "agent/approvalRequest",
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

export function createErrorResponse(id: string | number, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export function createNotification(method: string, params?: Record<string, unknown>): RpcNotification {
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
