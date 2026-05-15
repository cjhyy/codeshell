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
  type ConfigureParams,
  type QueryParams,
  type QueryResult,
  Methods,
  createRequest,
  isResponse,
  isNotification,
} from "./types.js";
import type { StreamEvent, ApprovalRequest, ApprovalResult } from "../types.js";
import { EventEmitter } from "node:events";
import { logger } from "../logging/logger.js";

// ─── Event Types ────────────────────────────────────────────────────

export interface AgentClientEvents {
  stream: (event: StreamEvent) => void;
  approvalRequest: (requestId: string, request: ApprovalRequest) => void;
  status: (status: string, message?: string) => void;
}

// ─── Client ─────────────────────────────────────────────────────────

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
   */
  async run(task: string, sessionId?: string): Promise<RunResult> {
    const params: RunParams = { task, sessionId };
    // If the caller provided a session id, stamp it on the logger eagerly
    // so client-side log lines emitted during this run (before the server
    // response arrives) carry the right sid. The server-resolved id from
    // the response below takes precedence — they only differ on the
    // first call of a brand-new session, when sessionId is undefined.
    if (sessionId) logger.setSid(sessionId);
    const result = (await this.request(
      Methods.Run,
      params as unknown as Record<string, unknown>,
    )) as RunResult;
    if (result.sessionId) logger.setSid(result.sessionId);
    return result;
  }

  /**
   * Respond to an approval request from the server.
   */
  async approve(requestId: string, decision: ApprovalResult): Promise<void> {
    await this.request(Methods.Approve, { requestId, decision } as unknown as Record<
      string,
      unknown
    >);
  }

  /**
   * Cancel a running agent.
   */
  async cancel(reason?: string): Promise<void> {
    await this.request(Methods.Cancel, { reason } as Record<string, unknown>);
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

  onStreamEvent(handler: (event: StreamEvent) => void): void {
    this.emitter.on("stream", handler);
  }

  offStreamEvent(handler: (event: StreamEvent) => void): void {
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
      pending.reject(new Error(`[${res.error.code}] ${res.error.message}`));
    } else {
      pending.resolve(res.result);
    }
  }

  private handleNotification(notif: RpcNotification): void {
    const params = (notif.params ?? {}) as Record<string, unknown>;

    switch (notif.method) {
      case Methods.StreamEvent: {
        const event = params.event as StreamEvent | undefined;
        if (event) this.emitter.emit("stream", event);
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
    this.emitter.removeAllListeners();
    this.transport.close();
  }
}
