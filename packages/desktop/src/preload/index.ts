/**
 * Preload — exposes a minimal, typed IPC surface to the renderer via
 * contextBridge. The renderer never sees ipcRenderer directly so
 * contextIsolation stays meaningful.
 *
 * All requests to the main process are JSON-RPC 2.0 messages sent via
 * `code-shell:rpc:to-main`. Responses and notifications from the main
 * process arrive via `code-shell:rpc:to-renderer`.
 *
 * Stream events are delivered as { sessionId, event } envelopes so the
 * renderer can route them to the correct session bucket.
 *
 * NOTE: sessionId is required on run/cancel/approve/closeSession. This
 * is intentional — T14 will update App.tsx to supply it. Until T14
 * lands, App.tsx callers will have a typecheck error.
 */

import { contextBridge, ipcRenderer } from "electron";

const RPC_FROM_RENDERER = "code-shell:rpc:to-main";
const RPC_TO_RENDERER = "code-shell:rpc:to-renderer";

// ─── Internal types (preload-only) ──────────────────────────────────

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type IncomingMessage = RpcResponse | RpcNotification;

// ─── Pending RPC call registry ───────────────────────────────────────

let _nextId = 1;
const _pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    const req: RpcRequest = { jsonrpc: "2.0", id, method, params };
    ipcRenderer.send(RPC_FROM_RENDERER, req);
  });
}

// ─── Listener sets ───────────────────────────────────────────────────

type StreamEnvelope = { sessionId: string; event: unknown };
type ApprovalEnvelope = { sessionId: string; requestId: string; request: unknown };

const streamListeners = new Set<(env: StreamEnvelope) => void>();
const approvalListeners = new Set<(env: ApprovalEnvelope) => void>();

// ─── Incoming message router ─────────────────────────────────────────

ipcRenderer.on(RPC_TO_RENDERER, (_ipcEvent, msg: IncomingMessage) => {
  // Response to a pending call
  if ("id" in msg && msg.id != null) {
    const pending = _pending.get(msg.id as number);
    if (pending) {
      _pending.delete(msg.id as number);
      if ("error" in msg && msg.error) {
        const err = new Error(msg.error.message);
        (err as { code?: number }).code = msg.error.code;
        pending.reject(err);
      } else {
        pending.resolve((msg as RpcResponse).result);
      }
    }
    return;
  }

  // Notification (no id)
  const notification = msg as RpcNotification;
  const { method, params } = notification;

  if (method === "agent/streamEvent") {
    const sessionId = params?.sessionId as string;
    const event = params?.event;
    streamListeners.forEach((cb) => cb({ sessionId, event }));
  } else if (method === "agent/approvalRequest") {
    const sessionId = params?.sessionId as string;
    const requestId = params?.requestId as string;
    const request = params?.request;
    approvalListeners.forEach((cb) => cb({ sessionId, requestId, request }));
  }
});

// ─── Exposed bridge ──────────────────────────────────────────────────

contextBridge.exposeInMainWorld("codeshell", {
  /**
   * Start a new agent run inside the given session.
   * sessionId is REQUIRED — create one with crypto.randomUUID() before calling.
   */
  run: (task: string, opts: { sessionId: string; cwd?: string; permissionMode?: string }) =>
    rpc("agent/run", { task, ...opts }),

  /** Cancel the running turn in the given session. */
  cancel: (sessionId: string) => rpc("agent/cancel", { sessionId }),

  /**
   * Respond to an approval request.
   * decision shape mirrors ApprovalResult from @cjhyy/code-shell-core.
   */
  approve: (
    sessionId: string,
    requestId: string,
    decision: {
      approved: boolean;
      permanent?: boolean;
      always?: boolean;
      scope?: "once" | "session" | "project";
      reason?: string;
      answer?: string;
    },
  ) => rpc("agent/approve", { sessionId, requestId, decision }),

  /** Destroy (close) a session and free its resources. */
  closeSession: (sessionId: string) => rpc("agent/closeSession", { sessionId }),

  /** Register a callback that fires for every stream event envelope. */
  onStreamEvent: (cb: (env: StreamEnvelope) => void): void => {
    streamListeners.add(cb);
  },

  /** Unregister a stream event callback previously registered with onStreamEvent. */
  offStreamEvent: (cb: (env: StreamEnvelope) => void): void => {
    streamListeners.delete(cb);
  },

  /** Register a callback that fires when the server requests tool approval. */
  onApprovalRequest: (cb: (env: ApprovalEnvelope) => void): void => {
    approvalListeners.add(cb);
  },

  /** Unregister an approval request callback. */
  offApprovalRequest: (cb: (env: ApprovalEnvelope) => void): void => {
    approvalListeners.delete(cb);
  },
});
