import type { QuickChatForkRequest } from "./agent-bridge-fallback.js";

export interface QuickChatForkLifecycle {
  begin(request: QuickChatForkRequest): boolean;
  settle(request: QuickChatForkRequest & { succeeded: boolean }): Promise<void> | void;
}

export interface QuickChatForkResponseTarget {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: string): void;
}

interface PendingQuickChatFork {
  request: QuickChatForkRequest;
  target: QuickChatForkResponseTarget;
}

export interface QuickChatForkStart {
  wireId: string;
  line: string;
}

let nextQuickChatForkWireId = 1;

/**
 * Gives quick-chat fork RPCs a process-global worker id and routes their reply
 * back to the originating webContents. Renderer-local JSON-RPC ids are only
 * restored at that boundary, so two preload contexts can both use id=1 safely.
 */
export class QuickChatForkRouter {
  private readonly pending = new Map<string, PendingQuickChatFork>();

  constructor(private readonly lifecycle: QuickChatForkLifecycle) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  start(
    request: QuickChatForkRequest,
    target: QuickChatForkResponseTarget,
    originalLine: string,
  ): QuickChatForkStart | null {
    if (!this.lifecycle.begin(request)) {
      this.sendToTarget(
        target,
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.requestId,
          error: { code: -32602, message: "quick-chat claim is no longer active" },
        }),
      );
      return null;
    }

    const wireId = `quick-chat-fork:${target.id}:${nextQuickChatForkWireId++}`;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(originalLine) as Record<string, unknown>;
    } catch {
      void this.lifecycle.settle({ ...request, succeeded: false });
      return null;
    }
    this.pending.set(wireId, { request, target });
    return { wireId, line: JSON.stringify({ ...parsed, id: wireId }) };
  }

  /** Returns null when the line is not a tracked quick-chat fork response. */
  routeWorkerResponse(line: string): Promise<void> | null {
    let response: Record<string, unknown> & {
      id?: unknown;
      result?: { sessionId?: unknown };
      error?: unknown;
    };
    try {
      response = JSON.parse(line) as typeof response;
    } catch {
      return null;
    }
    if (response.id === undefined) return null;
    const wireId = String(response.id);
    const pending = this.pending.get(wireId);
    if (!pending) return null;
    this.pending.delete(wireId);

    const { request, target } = pending;
    this.sendToTarget(target, JSON.stringify({ ...response, id: request.requestId }));
    const succeeded = !response.error && response.result?.sessionId === request.sessionId;
    return Promise.resolve(this.lifecycle.settle({ ...request, succeeded }));
  }

  async fail(wireId: string): Promise<void> {
    const pending = this.pending.get(wireId);
    if (!pending) return;
    this.pending.delete(wireId);
    await this.lifecycle.settle({ ...pending.request, succeeded: false });
  }

  async failAll(): Promise<void> {
    const wireIds = [...this.pending.keys()];
    await Promise.all(wireIds.map((wireId) => this.fail(wireId)));
  }

  private sendToTarget(target: QuickChatForkResponseTarget, line: string): void {
    if (!target.isDestroyed()) target.send("agent:msg", line);
  }
}
