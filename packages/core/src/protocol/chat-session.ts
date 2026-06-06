import type { Engine, EngineResult } from "../engine/engine.js";
import type { StreamEvent } from "../types.js";
import { isAbortError } from "../llm/client-base.js";

export interface ChatSessionOptions {
  id: string;
  engine: Engine;
  onStream?: (event: StreamEvent) => void;
}

export interface TurnOpts {
  /** Working directory override for this turn. If omitted, Engine uses its
   *  configured cwd. */
  cwd?: string;
  onStream?: (event: StreamEvent) => void;
  /** Goal mode for this turn — forwarded to engine.run (loop-until-done).
   *  String objective or full GoalConfig (objective + optional budgets). */
  goal?: string | import("../engine/goal.js").GoalConfig;
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
  /**
   * Model-pool key requested via requestModelSwitch while a turn was in
   * flight. Applied at the next run boundary (before the next turn starts) so
   * we never swap the model out from under a running LLM client — the bug the
   * session-isolation research flagged. null = nothing pending.
   */
  private pendingModel: string | null = null;
  /**
   * Set by cancel() so the in-flight turn's abort error resolves as a clean
   * "cancelled" result instead of rejecting (which the RPC layer would surface
   * as a scary red Error in the UI for what was a user-initiated Stop). The
   * onboarding flow cancels + immediately re-runs the same task; without this
   * the cancelled first run popped "Error: Request cancelled".
   */
  private cancelledActive = false;

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
    // Mark the in-flight turn as user-cancelled so pump()'s catch resolves it
    // as a clean aborted result rather than rejecting (→ UI Error).
    if (this.active) this.cancelledActive = true;
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

  /**
   * Extend the in-flight goal run's turn/budget ceilings (TODO 3.1). Delegates
   * to the engine, which forwards to the active TurnLoop. Returns null when no
   * run is active (or the run has no extendable loop). Mirrors the cancel()
   * mid-run control path.
   */
  extendGoalRun(opts: {
    addTurns?: number;
    addTokenBudget?: number;
    addTimeBudgetMs?: number;
    addStopBlocks?: number;
  }): { maxTurns: number; tokenBudget?: number; timeBudgetMs?: number; maxStopBlocks: number } | null {
    return this.engine.extendGoalRun(opts);
  }

  /**
   * Switch this session's active model (per-session, not worker-global).
   * Applies immediately when idle; defers to the next run boundary when a
   * turn is in flight so a hot switch never mutates the model under a
   * running LLM client.
   */
  requestModelSwitch(key: string): void {
    if (this.isBusy()) {
      this.pendingModel = key;
      return;
    }
    this.engine.switchModel(key);
  }

  queueDepth(): number {
    return this.queue.length;
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.cancelledActive = false;
    this.controller = new AbortController();
    try {
      const onStream = next.opts.onStream ?? this.defaultOnStream;
      const result = await this.engine.run(next.task, {
        cwd: next.opts.cwd,
        sessionId: this.id,
        signal: this.controller.signal,
        onStream,
        goal: next.opts.goal,
      });
      this.lastActivityAt = Date.now();
      next.resolve(result);
    } catch (err) {
      // A user-initiated cancel (Stop, or the onboarding cancel+rerun flow)
      // aborts the in-flight run. That's not a failure — resolve it as a clean
      // aborted result so the RPC layer doesn't surface "Error: Request
      // cancelled" in the UI. Only abort errors on a cancelled turn are
      // swallowed this way; a genuine error still rejects.
      if (this.cancelledActive && (isAbortError(err) || this.controller?.signal.aborted)) {
        next.resolve({
          text: "",
          reason: "aborted_streaming",
          sessionId: this.id,
          turnCount: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
      } else {
        next.reject(err);
      }
    } finally {
      this.active = null;
      this.controller = null;
      this.cancelledActive = false;
      // Run boundary: apply any model switch that was deferred because it was
      // requested mid-run. Done here (not in pump) so it still applies when
      // no further turn is queued.
      if (this.pendingModel !== null) {
        this.engine.switchModel(this.pendingModel);
        this.pendingModel = null;
      }
      // Drain the next turn if one is waiting.
      if (this.queue.length > 0) void this.pump();
    }
  }
}
