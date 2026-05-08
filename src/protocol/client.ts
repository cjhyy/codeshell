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
  private pendingRequests = new Map<string | number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();

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
    return this.request(Methods.Run, params as unknown as Record<string, unknown>) as Promise<RunResult>;
  }

  /**
   * Respond to an approval request from the server.
   */
  async approve(requestId: string, decision: ApprovalResult): Promise<void> {
    await this.request(Methods.Approve, { requestId, decision } as unknown as Record<string, unknown>);
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
    return this.request(Methods.Configure, params as unknown as Record<string, unknown>) as Promise<Record<string, unknown>>;
  }

  /**
   * Query server state.
   */
  async query(type: QueryParams["type"], sessionId?: string, ...extra: unknown[]): Promise<QueryResult> {
    const params: Record<string, unknown> = { type, sessionId };
    // Support config_set: query("config_set", key, value)
    if (type === "config_set" && extra.length >= 1) {
      params.key = sessionId;
      params.value = extra[0];
      delete params.sessionId;
    }
    // Support permission_set: query("permission_set", mode)
    if (type === "permission_set") {
      params.value = sessionId;
      delete params.sessionId;
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
