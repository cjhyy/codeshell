/**
 * AgentClient — the UI-side interface to the agent server.
 *
 * Replaces direct Engine usage in the UI. Communicates with AgentServer
 * over a Transport (in-process or cross-process).
 *
 * Usage:
 *   const client = new AgentClient({ transport });
 *   client.onStreamEvent((event) => { ... });
 *   client.onApprovalRequest((reqId, request) => { ... });
 *   const result = await client.run("fix the bug");
 */

import type { Transport } from "./transport.js";
import {
  type RpcResponse,
  type RpcNotification,
  type RunParams,
  type RunResult,
  type AgentStreamEventNotification,
  type ConfigureParams,
  type QueryParams,
  type QueryResult,
  Methods,
  createRequest,
  isResponse,
  isNotification,
} from "./types.js";
import type {
  StreamEvent,
  ApprovalRequest,
  ApprovalResult,
  PermissionMode,
  BackgroundAgentCompletedEvent,
} from "../types.js";
import { EventEmitter } from "node:events";
import { logger } from "../logging/logger.js";

// ─── Event Types ────────────────────────────────────────────────────

export interface AgentClientEvents {
  /** Multi-session envelope: carries sessionId + event. */
  stream: (envelope: AgentStreamEventNotification) => void;
  approvalRequest: (requestId: string, request: ApprovalRequest) => void;
  status: (status: string, message?: string) => void;
}

export interface AgentRunOptions {
  cwd?: string;
  sessionId?: string;
  permissionMode?: PermissionMode;
  planMode?: boolean;
}

// ─── Client ─────────────────────────────────────────────────────────

export type BackgroundAgentCompletedHandler = (
  sessionId: string,
  event: BackgroundAgentCompletedEvent,
) => void;

export class AgentClient {
  private transport: Transport;
  private emitter = new EventEmitter();
  private pendingRequests = new Map<
    string | number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  /**
   * Map from a user-supplied `BackgroundAgentCompletedHandler` to the
   * internal envelope-filtering wrapper actually registered on the
   * EventEmitter. Lets `offBackgroundAgentCompleted` look up the real
   * listener so removal is symmetric with subscription.
   */
  private bgAgentHandlers = new Map<
    BackgroundAgentCompletedHandler,
    (envelope: AgentStreamEventNotification) => void
  >();

  constructor(options: { transport: Transport }) {
    this.transport = options.transport;

    this.transport.onMessage((msg) => {
      if (isResponse(msg)) {
        this.handleResponse(msg);
      } else if (isNotification(msg)) {
        this.handleNotification(msg);
      }
    });
  }

  // ─── Requests ───────────────────────────────────────────────────

  /**
   * Run an agent task. Resolves when the agent completes.
   * Stream events arrive via the onStreamEvent callback.
   *
   * Accepts either the new object form `{ sessionId, task, ... }` (required
   * for multi-session servers) or the legacy string form `(task, sessionId?)`
   * for backward compatibility with createInProcessClient callers.
   */
  async run(
    taskOrParams: string | RunParams,
    sessionIdOrOptions?: string | AgentRunOptions,
  ): Promise<RunResult> {
    let params: RunParams;
    if (typeof taskOrParams === "string") {
      // Form: run(task, sessionId | options?)
      const options =
        typeof sessionIdOrOptions === "string"
          ? { sessionId: sessionIdOrOptions }
          : sessionIdOrOptions;
      params = {
        task: taskOrParams,
        sessionId: options?.sessionId ?? "",
        ...(options ?? {}),
      };
    } else {
      // Form: run({ sessionId, task, ... }). The caller-provided fields
      // win; the empty-string default only fills in when sessionId is
      // truly absent (cold start).
      params = { ...taskOrParams, sessionId: taskOrParams.sessionId ?? "" };
    }
    // If the caller provided a session id, stamp it on the logger eagerly
    // so client-side log lines emitted during this run (before the server
    // response arrives) carry the right sid. The server-resolved id from
    // the response below takes precedence — they only differ on the
    // first call of a brand-new session, when sessionId is undefined.
    if (params.sessionId) logger.setSid(params.sessionId);
    const result = (await this.request(
      Methods.Run,
      params as unknown as Record<string, unknown>,
    )) as RunResult;
    if (result.sessionId) logger.setSid(result.sessionId);
    return result;
  }

  /**
   * Respond to an approval request from the server.
   *
   * Multi-session form: approve(sessionId, requestId, decision)
   * Legacy form:        approve(requestId, decision)
   */
  approve(sessionId: string, requestId: string, decision: ApprovalResult): Promise<void>;
  approve(requestId: string, decision: ApprovalResult): Promise<void>;
  approve(...args: unknown[]): Promise<void> {
    if (args.length === 3) {
      const [sessionId, requestId, decision] = args as [string, string, ApprovalResult];
      return this.request(Methods.Approve, {
        sessionId,
        requestId,
        decision,
      } as unknown as Record<string, unknown>) as Promise<void>;
    }
    const [requestId, decision] = args as [string, ApprovalResult];
    return this.request(Methods.Approve, {
      requestId,
      decision,
    } as unknown as Record<string, unknown>) as Promise<void>;
  }

  /**
   * Cancel a running agent.
   *
   * Multi-session form: cancel(sessionId, reason?)
   * Legacy form:        cancel(reason?)
   */
  async cancel(sessionId?: string, reason?: string): Promise<void> {
    await this.request(Methods.Cancel, { sessionId, reason } as Record<string, unknown>);
  }

  /**
   * Clear a session's persisted active goal (CC `/goal clear`). Returns whether
   * a goal was actually cleared (false = there was none).
   */
  async goalClear(sessionId?: string): Promise<boolean> {
    const res = (await this.request(Methods.GoalClear, { sessionId } as Record<string, unknown>)) as
      | { cleared?: boolean }
      | undefined;
    return res?.cleared === true;
  }

  /**
   * Read a session's persisted active goal objective, or null when there's
   * none. The host calls this on session load to re-surface the goal block +
   * Cancel button after a reload (a persistent goal isn't replayed from the
   * transcript, so the live stream never re-announces it).
   */
  async goalGet(sessionId: string): Promise<string | null> {
    const res = (await this.request(Methods.GoalGet, { sessionId } as Record<string, unknown>)) as
      | { goal?: string | null }
      | undefined;
    return res?.goal ?? null;
  }

  /**
   * Update runtime configuration on the server.
   */
  async configure(params: ConfigureParams): Promise<Record<string, unknown>> {
    return this.request(Methods.Configure, params as unknown as Record<string, unknown>) as Promise<
      Record<string, unknown>
    >;
  }

  /**
   * Query server state.
   */
  async query(
    type: QueryParams["type"],
    arg?: string | Record<string, unknown>,
    ...extra: unknown[]
  ): Promise<QueryResult> {
    const params: Record<string, unknown> = { type };
    // Per-type argument mapping. The second positional param overloads:
    //   - "models" / "sessions" / "providers" / "permission_state": (sessionId?)
    //   - "config_set": (key, value)
    //   - "config_get": (key)
    //   - "permission_set": (mode) — server reads `params.value`
    //   - "provider_add" / "model_add" / "provider_refresh" /
    //     "provider_delete" / "model_delete": ({ ...payload }) — the object
    //     is spread into the top-level params so the server can read
    //     `params.key` / `params.provider` / `params.model` directly.
    if (type === "config_set" && extra.length >= 1) {
      params.key = arg;
      params.value = extra[0];
    } else if (type === "config_get") {
      params.key = arg;
    } else if (type === "permission_set") {
      params.value = arg;
    } else if (
      type === "provider_add" ||
      type === "model_add" ||
      type === "provider_refresh" ||
      type === "provider_delete" ||
      type === "model_delete"
    ) {
      if (arg && typeof arg === "object") Object.assign(params, arg);
    } else {
      params.sessionId = arg as string | undefined;
    }
    return this.request(Methods.Query, params) as Promise<QueryResult>;
  }

  /**
   * Inject context into the session transcript without triggering a LLM turn.
   * Used to make arena results, tool outputs, etc. visible to subsequent LLM calls.
   */
  async inject(sessionId: string, content: string): Promise<void> {
    await this.request(Methods.Inject, { sessionId, content });
  }

  // ─── Event Handlers ─────────────────────────────────────────────

  /**
   * Register a handler for stream event notifications.
   * The handler receives the full envelope `{ sessionId, event }` so callers
   * can route events to the correct tab/session.
   */
  onStreamEvent(handler: (envelope: AgentStreamEventNotification) => void): void {
    this.emitter.on("stream", handler);
  }

  offStreamEvent(handler: (envelope: AgentStreamEventNotification) => void): void {
    this.emitter.off("stream", handler);
  }

  onApprovalRequest(handler: (requestId: string, request: ApprovalRequest) => void): void {
    this.emitter.on("approvalRequest", handler);
  }

  offApprovalRequest(handler: (requestId: string, request: ApprovalRequest) => void): void {
    this.emitter.off("approvalRequest", handler);
  }

  onStatus(handler: (status: string, message?: string) => void): void {
    this.emitter.on("status", handler);
  }

  offStatus(handler: (status: string, message?: string) => void): void {
    this.emitter.off("status", handler);
  }

  /**
   * Typed convenience for the B2.2 `background_agent_completed` stream
   * event. Internally wraps `onStreamEvent`, so catch-all stream
   * consumers keep seeing the same envelope; this just adds a typed
   * entry point so SDK callers don't have to switch on `event.type`
   * themselves.
   */
  onBackgroundAgentCompleted(handler: BackgroundAgentCompletedHandler): void {
    const wrapper = (envelope: AgentStreamEventNotification) => {
      if (envelope.event.type === "background_agent_completed") {
        handler(envelope.sessionId, envelope.event);
      }
    };
    this.bgAgentHandlers.set(handler, wrapper);
    this.emitter.on("stream", wrapper);
  }

  offBackgroundAgentCompleted(handler: BackgroundAgentCompletedHandler): void {
    const wrapper = this.bgAgentHandlers.get(handler);
    if (!wrapper) return;
    this.bgAgentHandlers.delete(handler);
    this.emitter.off("stream", wrapper);
  }

  // ─── Internals ──────────────────────────────────────────────────

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = createRequest(method, params);
      this.pendingRequests.set(req.id, { resolve, reject });
      this.transport.send(req);
    });
  }

  private handleResponse(res: RpcResponse): void {
    const pending = this.pendingRequests.get(res.id);
    if (!pending) return;

    this.pendingRequests.delete(res.id);

    if (res.error) {
      // Attach both message and code so callers can do toMatchObject({ code }).
      const err = new Error(`[${res.error.code}] ${res.error.message}`) as Error & {
        code: number;
      };
      err.code = res.error.code;
      pending.reject(err);
    } else {
      pending.resolve(res.result);
    }
  }

  private handleNotification(notif: RpcNotification): void {
    const params = (notif.params ?? {}) as Record<string, unknown>;

    switch (notif.method) {
      case Methods.StreamEvent: {
        const event = params.event as StreamEvent | undefined;
        const sessionId = (params.sessionId as string | undefined) ?? "";
        if (event) {
          const envelope: AgentStreamEventNotification = { sessionId, event };
          this.emitter.emit("stream", envelope);
        }
        break;
      }
      case Methods.ApprovalRequest: {
        const requestId = params.requestId as string | undefined;
        const request = params.request as ApprovalRequest | undefined;
        if (requestId && request) {
          this.emitter.emit("approvalRequest", requestId, request);
        }
        break;
      }
      case Methods.Status: {
        const status = params.status as string | undefined;
        const message = params.message as string | undefined;
        this.emitter.emit("status", status, message);
        break;
      }
    }
  }

  close(): void {
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Client closed"));
    }
    this.pendingRequests.clear();
    this.bgAgentHandlers.clear();
    this.emitter.removeAllListeners();
    this.transport.close();
  }
}
