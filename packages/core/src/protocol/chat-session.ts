import type { Engine, EngineResult } from "../engine/engine.js";
import type { ModelEntry } from "../llm/model-pool.js";
import type { StreamEvent } from "../types.js";
import type { PermissionMode, SessionKind } from "../types.js";
import { isAbortError } from "../llm/client-base.js";
import type { InputAttachmentMeta, PendingApprovalMetadata } from "./types.js";
import type { ApprovalRouter } from "../tool-system/permission.js";
import type { RunBehaviorMode } from "../engine/run-types.js";
import type { LegacyPetWorkspaceOption } from "../types.js";
import { isSameGoalInstance, type GoalConfig } from "../goal/lifecycle.js";

export interface ChatSessionOptions {
  id: string;
  engine: Engine;
  onStream?: (event: StreamEvent) => void;
}

export interface PendingApprovalEntry {
  resolve: (decision: unknown) => void;
  metadata: PendingApprovalMetadata;
}

export interface TurnOpts {
  /** Working directory override for this turn. If omitted, Engine uses its
   *  configured cwd. */
  cwd?: string;
  onStream?: (event: StreamEvent) => void;
  /** Goal mode for this turn — forwarded to engine.run (loop-until-done).
   *  String objective or full GoalConfig (objective + optional budgets). */
  goal?: string | import("../goal/lifecycle.js").GoalConfig;
  /** Marks this turn as a synthetic system-reminder injection (background-job
   *  completion notification) rather than the user's own input — persisted so
   *  the disk reader skips it as a user bubble on replay. See Engine.run. */
  injected?: boolean;
  /** Stable id for this user-intent; forwarded to Engine.run for idempotency. */
  clientMessageId?: string;
  /** Structured input attachments for this turn. */
  attachments?: InputAttachmentMeta[];
  /** Permission mode snapshot for this queued turn only. */
  permissionMode?: PermissionMode;
  /** Plan-mode snapshot for this queued turn only. */
  planMode?: boolean;
  /** Named behavior profile snapshot for this queued turn only. */
  behaviorMode?: RunBehaviorMode;
  /** Generic per-run parameters consumed by the active behavior profile. */
  profileParams?: Record<string, unknown>;
  /** Digital human to bind durably to this Work Session. */
  workspaceProfile?: string;
  /** @deprecated Compat alias for `profileParams.runtimeContext`. */
  petRuntimeContext?: string;
  /** @deprecated Compat alias for `profileParams.workspaces`. */
  petWorkspaces?: LegacyPetWorkspaceOption[];
  /** Durable classification used only when the Engine creates the session. */
  kind?: SessionKind;
  /** Connection owner router for permission prompts in this turn. */
  approvalRouter?: ApprovalRouter;
}

interface QueuedTurn {
  task: string;
  opts: TurnOpts;
  resolve: (r: EngineResult) => void;
  reject: (e: unknown) => void;
  /** Stable Goal instance for a queued synthetic resume turn. */
  goalResumeId?: string;
  /** Evaluated only when this entry reaches the head of the queue. */
  guard?: () => boolean;
  onSkipped?: () => void;
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
   * Per-session approval callbacks and resolver-free metadata indexed by requestId.
   * `readonly` guards the Map reference (preventing reassignment); the
   * contents are mutated by `.set()` / `.delete()` as approvals come and go.
   * The resolver stays process-local; only metadata is eligible for Pet snapshots.
   */
  readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
  lastActivityAt = Date.now();

  private queue: QueuedTurn[] = [];
  private active: QueuedTurn | null = null;
  private exclusiveOperation = false;
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
  /**
   * Sticky flag: the user cancelled (Stop) and has not started a new turn
   * since. cancel() leaves the session idle (active=null), so isBusy() can't
   * distinguish "naturally idle" from "user just stopped me". A background-job
   * completion that lands in this window must NOT auto-resume the session —
   * that would defeat the Stop. Cleared the moment a real turn is enqueued
   * (the user is engaging again) so normal wakeups resume working afterward.
   */
  private cancelledSinceLastTurn = false;
  private settlePromise: Promise<void> = Promise.resolve();
  private resolveSettled: (() => void) | null = null;

  constructor(opts: ChatSessionOptions) {
    this.id = opts.id;
    this.engine = opts.engine;
    this.defaultOnStream = opts.onStream;
  }

  enqueueTurn(task: string, opts: TurnOpts): Promise<EngineResult> {
    this.lastActivityAt = Date.now();
    // The user (or a wakeup the guard already let through) is starting a turn —
    // clear the post-Stop suppression so future background-job completions
    // wake the session again.
    this.cancelledSinceLastTurn = false;
    return new Promise((resolve, reject) => {
      this.queue.push({ task, opts, resolve, reject });
      this.pump();
    });
  }

  /**
   * Run session maintenance (for example context-package summarization) under
   * the same per-session mutex as turns. Existing activity fails fast; turns
   * arriving after the lock is acquired remain queued until maintenance has
   * persisted its final usage/state update.
   */
  async runExclusive<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active || this.exclusiveOperation || this.queue.length > 0) {
      throw new Error("source session is still producing or has queued turns");
    }
    this.lastActivityAt = Date.now();
    this.exclusiveOperation = true;
    this.settlePromise = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
    this.controller = new AbortController();
    try {
      return await operation(this.controller.signal);
    } finally {
      this.lastActivityAt = Date.now();
      this.resolveSettled?.();
      this.resolveSettled = null;
      this.controller = null;
      this.exclusiveOperation = false;
      this.applyPendingModelSwitchAtRunBoundary();
      if (this.queue.length > 0) void this.pump();
    }
  }

  /**
   * True when the user hit Stop and hasn't started a new turn since. The server
   * consults this before auto-waking an idle session on a background-job
   * completion, so a download finishing right after Stop doesn't restart the
   * agent the user just halted.
   */
  wasCancelledSinceLastTurn(): boolean {
    return this.cancelledSinceLastTurn;
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
    // Suppress auto-wakeup until the user engages again (see the field doc).
    this.cancelledSinceLastTurn = true;
    this.controller?.abort();
    // Drain queued turns as cancelled
    const drained = this.queue.splice(0);
    for (const t of drained) {
      t.reject(new Error("cancelled: session aborted before turn ran"));
    }
  }

  isBusy(): boolean {
    return this.active !== null || this.exclusiveOperation;
  }

  /** Resolves after the active engine.run() has completed its pump finally. */
  get settled(): Promise<void> {
    return this.settlePromise;
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
  }): {
    maxTurns: number;
    tokenBudget?: number;
    timeBudgetMs?: number;
    maxStopBlocks: number;
  } | null {
    return this.engine.extendGoalRun(opts);
  }

  /**
   * Read this session's persisted active goal (state.goalLifecycle), or undefined
   * when none. Cheap — reads only state.json. The host calls this on session
   * load to re-surface the goal block + Cancel button after a reload.
   */
  getGoal(): import("../goal/lifecycle.js").GoalConfig | undefined {
    return this.engine.getGoal(this.id);
  }

  /**
   * Clear this session's persisted active goal (CC /goal clear). Works idle or
   * mid-run. Returns true if a goal was actually cleared.
   */
  clearGoal(expected?: { goalId?: string; revision?: number }): boolean {
    return this.engine.clearGoal(this.id, expected);
  }

  /** Edit or pause/resume this session's persistent goal. */
  updateGoal(patch: {
    objective?: string;
    paused?: boolean;
    expectedGoalId?: string;
    expectedRevision?: number;
  }): import("../goal/lifecycle.js").GoalConfig | undefined {
    return this.engine.updateGoal(this.id, patch);
  }

  /** Whether a paused Goal can reuse this run's already Goal-capable prompt/tools. */
  canResumeGoalInPlace(): boolean {
    return this.engine.canResumeGoalInPlace(this.id);
  }

  /**
   * Queue the synthetic turn which actually drives an idle/dormant Goal after
   * Resume. The version guard is checked at queue head, so a later edit/delete
   * cannot leave a stale "resume" turn behind another user turn.
   */
  enqueueGoalResumeTurn(goal: GoalConfig, opts: Omit<TurnOpts, "goal"> = {}): Promise<boolean> {
    this.lastActivityAt = Date.now();
    this.cancelledSinceLastTurn = false;
    return new Promise<boolean>((resolve, reject) => {
      // Resume is level-triggered, not an instruction that should accumulate.
      // While another turn owns the session, pause -> resume can otherwise
      // leave multiple continuation turns for the same Goal instance queued.
      // Supersede only pending entries; an already-active resume is governed by
      // the live TurnLoop control path.
      if (goal.goalId) {
        for (let index = this.queue.length - 1; index >= 0; index--) {
          const pending = this.queue[index];
          if (pending?.goalResumeId !== goal.goalId) continue;
          this.queue.splice(index, 1);
          pending.onSkipped?.();
        }
      }
      this.queue.push({
        task: "<system-reminder>\n用户已恢复持久目标。请读取当前持久目标并继续执行。\n</system-reminder>",
        opts: { ...opts, injected: true },
        ...(goal.goalId ? { goalResumeId: goal.goalId } : {}),
        guard: () => {
          const current = this.engine.getGoal(this.id);
          // Edits retain the same user-owned goalId and should update the
          // queued resume, not cancel it. Pause/delete/replacement must skip.
          return current?.paused !== true && isSameGoalInstance(current, goal);
        },
        onSkipped: () => resolve(false),
        resolve: () => resolve(true),
        reject,
      });
      void this.pump();
    });
  }

  /**
   * Switch this session's active model (per-session, not worker-global).
   * Applies immediately when idle; defers to the next run boundary when a
   * turn is in flight so a hot switch never mutates the model under a
   * running LLM client.
   */
  requestModelSwitch(key: string): ModelEntry {
    if (this.isBusy()) {
      const pool = this.engine.getModelPool();
      const entry = pool.get(key);
      if (!entry) throw new Error(`Model not found: ${key}`);
      this.pendingModel = key;
      return entry;
    }
    return this.applyModelSwitch(key);
  }

  /**
   * Perform the actual model switch for this session: rotate the engine's model
   * and reset the session's cumulative usage on disk — a different model has a
   * different prompt cache, so the old cache-hit stats no longer apply. The
   * renderer zeroes its own cumulative display when it issues the switch (it's
   * renderer-initiated), so no stream event is needed here. Shared by the idle
   * path and the deferred run-boundary path.
   */
  private applyModelSwitch(key: string): ModelEntry {
    const entry = this.engine.switchModel(key);
    this.engine.resetSessionUsage(this.id);
    return entry;
  }

  /** Apply and clear a deferred switch before another run may start. */
  private applyPendingModelSwitchAtRunBoundary(): void {
    const key = this.pendingModel;
    this.pendingModel = null;
    if (key === null) return;
    try {
      this.applyModelSwitch(key);
    } catch {
      // requestModelSwitch already returned when the switch was queued. A
      // run-boundary persistence failure must not become an unhandled pump
      // rejection or prevent the session from settling/continuing.
    }
  }

  queueDepth(): number {
    return this.queue.length;
  }

  private async pump(): Promise<void> {
    if (this.active || this.exclusiveOperation) return;
    let next: QueuedTurn | undefined;
    while ((next = this.queue.shift())) {
      let allowed = true;
      try {
        allowed = next.guard?.() ?? true;
      } catch {
        allowed = false;
      }
      if (allowed) break;
      next.onSkipped?.();
      next = undefined;
    }
    if (!next) return;
    this.active = next;
    this.settlePromise = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
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
        injected: next.opts.injected,
        clientMessageId: next.opts.clientMessageId,
        attachments: next.opts.attachments,
        permissionMode: next.opts.permissionMode,
        planMode: next.opts.planMode,
        behaviorMode: next.opts.behaviorMode,
        profileParams: next.opts.profileParams,
        workspaceProfile: next.opts.workspaceProfile,
        petRuntimeContext: next.opts.petRuntimeContext,
        petWorkspaces: next.opts.petWorkspaces,
        kind: next.opts.kind,
        approvalRouter: next.opts.approvalRouter,
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
      // close() must never be held hostage by run-boundary cleanup. Resolve
      // before model switching or any other operation that may throw.
      this.resolveSettled?.();
      this.resolveSettled = null;
      this.active = null;
      this.controller = null;
      this.cancelledActive = false;
      // Run boundary: apply any model switch that was deferred because it was
      // requested mid-run. Done here (not in pump) so it still applies when
      // no further turn is queued.
      this.applyPendingModelSwitchAtRunBoundary();
      // Drain the next turn even if deferred model switching failed.
      if (this.queue.length > 0) {
        // Let the just-settled turn's resolve/reject handlers publish their
        // terminal lifecycle before a queued turn can synchronously emit its
        // session_started event. This preserves external QueryGuard ordering.
        queueMicrotask(() => void this.pump());
      }
    }
  }
}
