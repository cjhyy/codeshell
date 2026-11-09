/**
 * Mid-run Goal controls for an Engine's single in-flight run: the borrowed
 * goal identities the judge reads, the goal-stop hook registration, the
 * goal-level progress meter, and the edit/pause/delete operations that act
 * on them. The Engine still owns the run lifecycle — it arms these slots via
 * {@link LiveGoalControl.slots} and releases them in the run's `finally` —
 * while everything that changes the live goal state from outside the run
 * goes through this class.
 */
import type { Dispose } from "../composition/lifetime.js";
import {
  goalConfigFromLifecycle,
  isGoalLifecycleCurrent,
  isSameGoalVersion,
  type GoalConfig,
  type GoalExtension,
  type PersistedGoalTerminationReason,
} from "../goal/lifecycle.js";
import type { HookHandler } from "../hooks/registry.js";
import type { SessionBundle, SessionManager } from "../session/session-manager.js";
import type { SessionState } from "../types.js";
import {
  applyRunGoalUpdate,
  type createRunGoalProgressMeter,
  type GoalRunSlots,
  type GoalStopHookHandler,
} from "./run-goal.js";
import type { TurnLoop } from "./turn-loop.js";

/** What the live goal controls need from the Engine that owns the run. */
export interface LiveGoalHost {
  sessionManager(): SessionManager;
  /** The in-flight run's TurnLoop; null when idle. */
  turnLoop(): TurnLoop | null;
  /** The in-flight top-level run's session bundle; null when idle. */
  liveSession(): SessionBundle | null;
  /** Session of the current/most-recent run. */
  lastSessionId(): string | undefined;
  /** Tool selection owned by the running loop when it runs on `state`. */
  ownToolSelection(state: SessionState): SessionState["toolSelection"] | undefined;
  /** Effective ceilings the live run should adopt for `goal`. */
  runLimits(goal: GoalConfig): { maxTurns: number; maxStopBlocks: number };
  /** Register the goal-stop hook for the live run (sets {@link LiveGoalControl.registration}). */
  registerHook(handler: HookHandler): void;
  persistGoalTerminal(
    state: SessionState,
    goal: GoalConfig,
    reason: PersistedGoalTerminationReason,
  ): boolean;
}

export class LiveGoalControl {
  /** Goal-level round/time meter of the in-flight top-level run (null when idle). */
  meter: ReturnType<typeof createRunGoalProgressMeter> | null = null;
  /**
   * The goal-stop hook of the in-flight goal run, exposed so clear() can
   * unregister it mid-run (the closure holds the now-cleared goal and would
   * otherwise keep re-blocking the stop). Null when no goal run is active.
   */
  hook: GoalStopHookHandler | null = null;
  /** Whether {@link hook} is currently registered (pause detaches it). */
  hookAttached = false;
  /** Disposer of the current goal-stop hook registration. */
  registration: Dispose | undefined;
  /** Mutable goal view consumed by the running judge after edits/resume. */
  runtimeGoal: GoalConfig | null = null;
  /** Mutable terminal snapshot kept in sync with a mid-run objective edit. */
  persistedRunGoal: GoalConfig | null = null;

  constructor(private readonly host: LiveGoalHost) {}

  /** Accessors handed to resolveRunGoal/armRunGoalHook while a run is built. */
  slots(): GoalRunSlots {
    return {
      getActiveRuntimeGoal: () => this.runtimeGoal,
      setActiveRuntimeGoal: (g) => {
        this.runtimeGoal = g;
      },
      getActivePersistedRunGoal: () => this.persistedRunGoal,
      setActivePersistedRunGoal: (g) => {
        this.persistedRunGoal = g;
      },
      getActiveGoalHook: () => this.hook,
      setActiveGoalHook: (h) => {
        this.hook = h;
      },
      setActiveGoalHookAttached: (a) => {
        this.hookAttached = a;
      },
    };
  }

  /** Forget the live goal identities if `handler` is still the live hook. */
  release(handler: GoalStopHookHandler | null): void {
    if (this.hook !== handler) return;
    this.hook = null;
    this.hookAttached = false;
    this.runtimeGoal = null;
    this.persistedRunGoal = null;
  }

  /**
   * Edit or pause/resume a persisted goal. Mid-run edits use the same step-gap
   * delivery seam as Steer: the current model/tool call is not aborted, and the
   * updated objective is injected before the next model step. Pausing detaches
   * the goal judge and stops this run before another model request is started.
   */
  update(
    sessionId: string,
    patch: {
      objective?: string;
      paused?: boolean;
      expectedGoalId?: string;
      expectedRevision?: number;
    },
  ): GoalConfig | undefined {
    const { host } = this;
    const sessionManager = host.sessionManager();
    if (!sessionId || !sessionManager.exists(sessionId)) return undefined;
    const liveSession = host.liveSession();
    const live = liveSession?.state.sessionId === sessionId ? liveSession : null;
    const liveLifecycle = live?.state.goalLifecycle;
    const before =
      liveLifecycle && isGoalLifecycleCurrent(liveLifecycle)
        ? goalConfigFromLifecycle(liveLifecycle)
        : sessionManager.readActiveGoal(sessionId);
    if (!before) return undefined;
    if (patch.expectedGoalId !== undefined && before.goalId !== patch.expectedGoalId) {
      return undefined;
    }
    if (patch.expectedRevision !== undefined && (before.revision ?? 1) !== patch.expectedRevision) {
      return undefined;
    }
    const updated = sessionManager.updateActiveGoal(sessionId, {
      ...patch,
      expectedGoalId: patch.expectedGoalId ?? before.goalId,
      expectedRevision: patch.expectedRevision ?? before.revision ?? 1,
    });
    if (!updated) return undefined;
    const next = updated.goal;
    if (live) {
      rebaseLiveStateAfterGoalUpdate(live.state, updated.state, host.ownToolSelection(live.state));
    }

    const turnLoop = host.turnLoop();
    const resumesDormantGoal =
      turnLoop !== null &&
      live !== null &&
      before.paused === true &&
      next.paused !== true &&
      this.runtimeGoal === null &&
      this.hook !== null;
    if (resumesDormantGoal) {
      // This ordinary run was constructed while the persisted Goal was paused:
      // its system prompt, visible tools and ToolContext are goal-less and
      // cannot be safely hot-swapped. Stop it at the next step boundary; the
      // protocol's conditional resume turn will rebuild a fully Goal-capable
      // run from the now-unpaused persisted state.
      turnLoop.updateGoal(undefined);
    }
    const controlsThisRun =
      turnLoop !== null &&
      live !== null &&
      isSameGoalVersion(before, this.runtimeGoal ?? undefined);
    if (controlsThisRun) {
      const instruction = applyRunGoalUpdate(before, next, this.runtimeGoal, this.persistedRunGoal);

      if (next.paused === true) {
        if (next.goalId) this.meter?.pause(next.goalId);
        if (this.hook && this.hookAttached) {
          void this.registration?.();
          this.registration = undefined;
          this.hookAttached = false;
        }
        turnLoop.updateGoal(undefined);
      } else {
        if (next.goalId) this.meter?.begin(next.goalId);
        turnLoop.updateGoal(next, instruction, host.runLimits(next));
        if (this.hook && !this.hookAttached) {
          host.registerHook(this.hook);
          this.hookAttached = true;
        }
      }
    }
    return next;
  }

  /**
   * Clear a session's persisted active goal (CC `/goal clear`). Works whether
   * the session is idle or its goal run is in flight: it wipes
   * `state.goalLifecycle` (so the next bare send won't re-inherit it) and, if a
   * goal hook is currently registered for this engine, unregisters it so an
   * in-flight run can stop instead of being re-blocked by the now-cleared goal.
   * Returns true if a goal was actually cleared. Idempotent — clearing a
   * session with no active goal is a no-op returning false.
   */
  clear(sessionId: string, expected?: { goalId?: string; revision?: number }): boolean {
    const { host } = this;
    const sessionManager = host.sessionManager();
    if (!sessionManager.exists(sessionId)) return false;
    // Prefer the LIVE run's bundle when it's this session so the domain update
    // rebases the exact state object used by subsequent progress writes.
    const liveSession = host.liveSession();
    const live = liveSession && liveSession.state.sessionId === sessionId ? liveSession : null;
    const session = live ?? sessionManager.resume(sessionId);
    const lifecycle = session.state.goalLifecycle;
    const currentGoal =
      lifecycle && isGoalLifecycleCurrent(lifecycle)
        ? goalConfigFromLifecycle(lifecycle)
        : undefined;
    const had = currentGoal !== undefined;
    let controlsThisRun = false;
    if (
      had &&
      ((expected?.goalId !== undefined && currentGoal?.goalId !== expected.goalId) ||
        (expected?.revision !== undefined && (currentGoal?.revision ?? 1) !== expected.revision))
    ) {
      return false;
    }
    if (had) {
      const clearedGoal = currentGoal!;
      const turnLoop = host.turnLoop();
      controlsThisRun =
        turnLoop !== null &&
        live !== null &&
        isSameGoalVersion(clearedGoal, this.runtimeGoal ?? undefined);
      if (!host.persistGoalTerminal(session.state, clearedGoal, "user_cleared")) return false;
      // A cross-writer edit may have won between the expected-version check
      // above and saveGoalTerminal's conflict merge. In that case the old
      // revision's tombstone is durable but the newer active revision remains;
      // report a stale delete, and never stop/detach the run that owns it.
      if (session.state.goalLifecycle && isGoalLifecycleCurrent(session.state.goalLifecycle)) {
        return false;
      }
      // A paused Goal inherited by an ordinary run is only dormant persisted
      // state; deleting it must not cancel that unrelated conversation.
      if (controlsThisRun) {
        if (clearedGoal.goalId) this.meter?.pause(clearedGoal.goalId);
        turnLoop!.updateGoal(undefined);
      }
    }
    // If THIS session's goal run is in flight, drop its stop hook so the
    // current run can terminate (the closure-held goal would otherwise keep
    // re-blocking). The run's own `finally` also unregisters; double-unregister
    // is safe (set delete is idempotent).
    if (
      had &&
      this.hook &&
      host.lastSessionId() === sessionId &&
      (controlsThisRun || this.runtimeGoal === null)
    ) {
      if (this.hookAttached) void this.registration?.();
      this.registration = undefined;
      this.release(this.hook);
    }
    return had;
  }
}

/**
 * Extend the in-flight run's turn ceiling and/or goal budgets. A
 * behavior-profile ceiling caps added turns; goal budgets may still grow.
 */
export function extendLiveGoalRun(
  turnLoop: TurnLoop | null,
  profileMaxTurns: number | undefined,
  opts: GoalExtension,
): ReturnType<TurnLoop["extend"]> | null {
  if (!turnLoop) return null;
  if (
    profileMaxTurns !== undefined &&
    typeof opts.addTurns === "number" &&
    Number.isFinite(opts.addTurns) &&
    opts.addTurns > 0 &&
    opts.addTurns <= Number.MAX_SAFE_INTEGER
  ) {
    // An empty extension is a no-op that returns the live ceilings. Goal
    // budgets may still grow, but a behavior-profile ceiling cannot.
    const currentMaxTurns = turnLoop.extend({}).maxTurns;
    return turnLoop.extend({
      ...opts,
      addTurns: Math.min(opts.addTurns, profileMaxTurns - currentMaxTurns),
    });
  }
  return turnLoop.extend(opts);
}

/**
 * Adopt the exact persisted snapshot that won a Goal-control CAS without
 * discarding counters which the current run has advanced since its previous
 * heartbeat. Merely copying the new stateRevision is unsafe: the next
 * whole-state save would then be allowed to publish stale title/workspace
 * metadata over a concurrent field-level writer.
 */
export function rebaseLiveStateAfterGoalUpdate(
  live: SessionState,
  persisted: SessionState,
  ownToolSelection: SessionState["toolSelection"] | undefined,
): void {
  const runOwned = {
    status: live.status,
    summary: live.summary,
    toolSelection: ownToolSelection ?? live.toolSelection,
    tokenUsage: live.tokenUsage,
    contextUsageAnchor: live.contextUsageAnchor,
    cacheUsageVersion: live.cacheUsageVersion,
    cumulativePromptTokens: live.cumulativePromptTokens,
    cumulativeCacheReadTokens: live.cumulativeCacheReadTokens,
    cumulativeCacheCreationTokens: live.cumulativeCacheCreationTokens,
    turnCount: live.turnCount,
    turnSeq: live.turnSeq,
    completedThroughEventId: live.completedThroughEventId,
    completedSnapshotVersion: live.completedSnapshotVersion,
    invokedSkills: live.invokedSkills,
    costState: live.costState,
  } satisfies Partial<SessionState>;

  // Optional fields deleted by another writer must disappear locally too;
  // clear before assigning rather than leaving stale own-properties behind.
  for (const key of Object.keys(live)) {
    delete (live as unknown as Record<string, unknown>)[key];
  }
  Object.assign(live, persisted, runOwned);
}
