import type { Engine, EngineResult } from "../engine/engine.js";
import type { StreamEvent } from "../types.js";

export interface ChatSessionOptions {
  id: string;
  engine: Engine;
  onStream?: (event: StreamEvent) => void;
}

export interface TurnOpts {
  onStream?: (event: StreamEvent) => void;
}

interface QueuedTurn {
  task: string;
  opts: TurnOpts;
  resolve: (r: EngineResult) => void;
  reject: (e: unknown) => void;
}

/**
 * One ChatSession per UI chat tab. Owns a single Engine, an AbortController
 * for the active turn, and a FIFO queue so a fast second send waits for the
 * first turn to finish instead of being silently rejected.
 */
export class ChatSession {
  readonly id: string;
  readonly engine: Engine;
  /**
   * Per-session approval callbacks indexed by tool-call requestId.
   * `readonly` guards the Map reference (preventing reassignment); the
   * contents are mutated by `.set()` / `.delete()` as approvals come and go.
   * Task 10 will register entries here when the Engine raises an approval
   * request and clean them up on response.
   */
  readonly pendingApprovals = new Map<string, (decision: unknown) => void>();
  lastActivityAt = Date.now();

  private queue: QueuedTurn[] = [];
  private active: QueuedTurn | null = null;
  private controller: AbortController | null = null;
  private readonly defaultOnStream?: (event: StreamEvent) => void;

  constructor(opts: ChatSessionOptions) {
    this.id = opts.id;
    this.engine = opts.engine;
    this.defaultOnStream = opts.onStream;
  }

  enqueueTurn(task: string, opts: TurnOpts): Promise<EngineResult> {
    this.lastActivityAt = Date.now();
    return new Promise((resolve, reject) => {
      this.queue.push({ task, opts, resolve, reject });
      this.pump();
    });
  }

  /**
   * Abort the in-flight turn and drain queued turns.
   *
   * Relies on `engine.run()` honouring the `AbortSignal`. If `engine.run` were
   * to swallow the abort and resolve successfully, the caller of the in-flight
   * `enqueueTurn` would observe success — not a cancellation. The queued turns
   * are always rejected regardless.
   */
  cancel(): void {
    this.controller?.abort();
    // Drain queued turns as cancelled
    const drained = this.queue.splice(0);
    for (const t of drained) {
      t.reject(new Error("cancelled: session aborted before turn ran"));
    }
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  queueDepth(): number {
    return this.queue.length;
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.controller = new AbortController();
    try {
      const onStream = next.opts.onStream ?? this.defaultOnStream;
      const result = await this.engine.run(next.task, {
        sessionId: this.id,
        signal: this.controller.signal,
        onStream,
      });
      this.lastActivityAt = Date.now();
      next.resolve(result);
    } catch (err) {
      next.reject(err);
    } finally {
      this.active = null;
      this.controller = null;
      // Drain the next turn if one is waiting.
      if (this.queue.length > 0) void this.pump();
    }
  }
}
