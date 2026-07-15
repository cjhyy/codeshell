// packages/web/app/protocol.ts
//
// Browser-side client for the CodeShell core JSON-RPC protocol over the
// headless serve WS pipe (/ws). Deliberately dependency-free: minimal local
// types mirror packages/core/src/protocol/types.ts for exactly the frames
// this UI uses. Auth rides the cs_access remember-cookie set by the page's
// passcode gate, so the WS upgrade needs no extra credentials.

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  startedAt: number;
  model: string;
  status: string;
  turnCount: number;
}

export interface ApprovalRequestPayload {
  requestId: string;
  sessionId?: string;
  connectionId?: string;
  generation?: number;
  request: {
    toolName: string;
    args: Record<string, unknown>;
    description?: string;
    riskLevel?: string;
  };
}

export type StreamEventPayload = { sessionId: string; event: Record<string, unknown> };

type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

export type ConnectionState = "connecting" | "open" | "closed";

const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 15_000;

export class ProtocolClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }
  >();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly stateHandlers = new Set<(state: ConnectionState) => void>();
  private reconnectDelay = RECONNECT_BASE_MS;
  private closedByUser = false;

  constructor(private readonly url: string) {}

  connect(): void {
    this.closedByUser = false;
    this.emitState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.emitState("open");
    };
    ws.onmessage = (msgEvent) => {
      let msg: {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        msg = JSON.parse(String(msgEvent.data));
      } catch {
        return;
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const pending = this.pending.get(String(msg.id));
        if (!pending) return;
        this.pending.delete(String(msg.id));
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error(msg.error.message ?? "request failed"));
        else pending.resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const handler of this.notificationHandlers) {
          handler(msg.method, msg.params ?? {});
        }
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.emitState("closed");
      this.failAllPending(new Error("connection closed"));
      if (!this.closedByUser) {
        // Reconnect with backoff — the serve host may be restarting; sessions
        // persist on disk so the UI can simply re-list once we're back.
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      }
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Correlated request; rejects on protocol error / timeout / disconnect. */
  request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const id = `web-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Fire-and-forget notification frame (e.g. agent/run — result streams back). */
  notify(method: string, params?: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /**
   * agent/run is a long-lived request (its response arrives at turn end), so
   * it gets a run-scoped id and NO timeout; progress arrives via
   * agent/streamEvent notifications regardless.
   */
  run(params: { sessionId: string; task: string; cwd?: string }): void {
    const id = `run-${this.nextId++}`;
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method: "agent/run", params }));
  }

  listSessions(): Promise<{ type: string; data: { sessions: SessionSummary[] } }> {
    return this.request("agent/query", { type: "sessions" });
  }

  sessionDetail(sessionId: string): Promise<{
    type: string;
    data: { state: Record<string, unknown>; transcript: Array<Record<string, unknown>> };
  }> {
    return this.request("agent/query", { type: "session_detail", sessionId });
  }

  approve(payload: ApprovalRequestPayload, approved: boolean, answer?: string): void {
    this.notifyRequest("agent/approve", {
      sessionId: payload.sessionId ?? "",
      ...(payload.connectionId ? { connectionId: payload.connectionId } : {}),
      ...(payload.generation !== undefined ? { generation: payload.generation } : {}),
      requestId: payload.requestId,
      decision: approved ? { approved: true, ...(answer ? { answer } : {}) } : { approved: false },
    });
  }

  cancel(sessionId: string): void {
    this.notifyRequest("agent/cancel", { sessionId });
  }

  /** Requests whose response we don't need to await (still id-carrying). */
  private notifyRequest(method: string, params: Record<string, unknown>): void {
    const id = `web-${this.nextId++}`;
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  private emitState(state: ConnectionState): void {
    for (const handler of this.stateHandlers) handler(state);
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function defaultWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
