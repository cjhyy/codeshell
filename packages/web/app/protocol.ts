// packages/web/app/protocol.ts
//
// Browser-side client for the CodeShell core JSON-RPC protocol over the
// headless serve WS pipe (/ws). Deliberately dependency-free: SessionSummary,
// ApprovalRequestPayload, and StreamEventPayload stay as minimal local mirrors
// because core does not export these UI-facing payload shapes. Auth rides the
// same-origin HttpOnly session cookie (or the legacy passcode cookie), so the
// WS upgrade needs no credential in its URL or message frames.

export interface SessionSummary {
  title?: string;
  customTitle?: string;
  lastActiveAt?: number;
  running?: boolean;
  sessionId: string;
  cwd: string;
  startedAt: number;
  model: string;
  status: string;
  turnCount: number;
  preview?: string;
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

export interface HubStreamCursor {
  epoch: string;
  sequence: number;
}

export interface SessionDetailData {
  state: Record<string, unknown>;
  transcript: Array<Record<string, unknown>>;
  running?: boolean;
  streamCursor?: HubStreamCursor;
  liveStream?: {
    events: Array<{ sequence: number; event: Record<string, unknown> }>;
    truncated: boolean;
  };
}

export type StreamEventPayload = {
  sessionId: string;
  event: Record<string, unknown>;
  hubEpoch?: string;
  hubSequence?: number;
};

/** Distinguish a definite rejection from a lost acknowledgement. Retrying an
 * uncertain transport failure before checking history could repeat a task. */
export class ProtocolRequestError extends Error {
  constructor(
    message: string,
    readonly kind: "response" | "transport" | "timeout" | "not-sent",
    readonly code?: number,
  ) {
    super(message);
    this.name = "ProtocolRequestError";
  }
}

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
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly stateHandlers = new Set<(state: ConnectionState) => void>();
  private reconnectDelay = RECONNECT_BASE_MS;
  private closedByUser = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly authHandlers = new Set<() => void>();

  constructor(private readonly url: string) {}

  connect(): void {
    if (this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.closedByUser = false;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.closedByUser) return;
    this.reconnectTimer = undefined;
    this.emitState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws || this.closedByUser) return;
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.emitState("open");
    };
    ws.onmessage = (msgEvent) => {
      if (this.ws !== ws || this.closedByUser) return;
      let msg: {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message?: string; code?: number };
      };
      try {
        msg = JSON.parse(String(msgEvent.data));
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      } catch {
        return;
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const pending = this.pending.get(String(msg.id));
        if (!pending) return;
        this.pending.delete(String(msg.id));
        clearTimeout(pending.timer);
        if (msg.error)
          pending.reject(
            new ProtocolRequestError(
              msg.error.message ?? "request failed",
              "response",
              msg.error.code,
            ),
          );
        else pending.resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const handler of this.notificationHandlers) {
          handler(msg.method, msg.params ?? {});
        }
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.emitState("closed");
      this.failAllPending(new ProtocolRequestError("connection closed", "transport"));
      if (event.code === 4401 || event.code === 4403) {
        this.closedByUser = true;
        for (const handler of this.authHandlers) handler();
      }
      if (!this.closedByUser) {
        // Reconnect with backoff — the serve host may be restarting; sessions
        // persist on disk so the UI can simply re-list once we're back.
        this.reconnectTimer = setTimeout(() => this.openSocket(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      }
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  close(): void {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.failAllPending(new ProtocolRequestError("connection closed", "transport"));
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  onAuthLost(handler: () => void): () => void {
    this.authHandlers.add(handler);
    return () => this.authHandlers.delete(handler);
  }

  /** Correlated request; rejects on protocol error / timeout / disconnect. */
  request<T>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ProtocolRequestError("not connected", "not-sent"));
    }
    const id = `web-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new ProtocolRequestError(`request timed out: ${method}`, "timeout"));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new ProtocolRequestError(
            cause instanceof Error ? cause.message : "send failed",
            "not-sent",
          ),
        );
      }
    });
  }

  /** Runs finish at turn end; correlate errors without timing out long work. */
  run(params: {
    sessionId: string;
    task: string;
    cwd?: string;
    uploadIds?: string[];
    clientMessageId?: string;
    displayText?: string;
  }): Promise<unknown> {
    return this.request("agent/run", params, 0);
  }

  listSessions(): Promise<{ type: string; data: SessionSummary[] }> {
    return this.request("agent/query", { type: "sessions" });
  }

  sessionDetail(sessionId: string): Promise<{
    type: string;
    data: SessionDetailData;
  }> {
    return this.request("agent/query", { type: "session_detail", sessionId });
  }

  approve(payload: ApprovalRequestPayload, approved: boolean, answer?: string): Promise<unknown> {
    return this.request("agent/approve", {
      sessionId: payload.sessionId ?? "",
      ...(payload.connectionId ? { connectionId: payload.connectionId } : {}),
      ...(payload.generation !== undefined ? { generation: payload.generation } : {}),
      requestId: payload.requestId,
      decision: approved ? { approved: true, ...(answer ? { answer } : {}) } : { approved: false },
    });
  }

  cancel(sessionId: string): Promise<unknown> {
    return this.request("agent/cancel", { sessionId });
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
