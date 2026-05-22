/**
 * RunManager — the top-level coordinator for managed agent runs.
 *
 * It does NOT replace Engine. It wraps Engine.run() to provide:
 *   - Submit / queue / start / resume / cancel lifecycle
 *   - State machine validation
 *   - Event sourcing (append-only run events)
 *   - Checkpoint and approval coordination
 *   - Waiting states: waiting_input / waiting_approval with suspend/resume
 *   - Attach (live stream subscription)
 *   - Run locking, heartbeat, and crash recovery (Phase 4)
 */

import { nanoid } from "nanoid";
import { logger } from "../logging/logger.js";
import type { ApprovalRequest, StreamEvent } from "../types.js";
import type { RunStore } from "./RunStore.js";
import { RunQueue } from "./RunQueue.js";
import { EngineRunner, type EngineRunnerConfig, type RunExecutionHandle, type RunExecutor } from "./EngineRunner.js";
import { CheckpointWriter } from "./CheckpointWriter.js";
import { ArtifactTracker } from "./ArtifactTracker.js";
import { RunLock } from "./RunLock.js";
import { Heartbeat } from "./Heartbeat.js";
import { NoopEvaluator, type Evaluator, type EvaluatorContext } from "./Evaluator.js";
import type { RunLifecycleHooks } from "./RunApprovalBackend.js";
import type {
  RunSnapshot,
  RunEvent,
  RunStatus,
  RunApproval,
  SubmitRunInput,
  ResumeRunInput,
  ListRunsQuery,
  RunStreamCallback,
  RunStreamEvent,
  RunCheckpoint,
  DetachFn,
  RunExecutionContext,
} from "./types.js";
import { VALID_TRANSITIONS } from "./types.js";

export interface RunManagerConfig {
  store: RunStore;
  /**
   * Execution backend. Two ways to provide:
   *   - `EngineRunnerConfig` object → creates built-in EngineRunner (calls LLM Engine)
   *   - `RunExecutor` instance → custom executor (any backend: CI/CD, ETL, etc.)
   */
  executor: RunExecutor | EngineRunnerConfig;
  concurrency?: number;
  /** Base directory for runs (used by lock and heartbeat). */
  runsDir?: string;
  /** Heartbeat interval in ms. Default: 5000 */
  heartbeatIntervalMs?: number;
  /** Stale lock timeout in ms. Default: 60000 */
  staleLockMs?: number;
  /** Optional evaluator to run on completion. Default: NoopEvaluator */
  evaluator?: Evaluator;
  /** Tags applied to every submitted run unless already present. */
  defaultTags?: string[];
  /** Metadata merged into every submitted run. Submit input wins on conflicts. */
  defaultMetadata?: Record<string, unknown>;
}

export class RunManager {
  private readonly store: RunStore;
  private readonly queue: RunQueue;
  private readonly runner: RunExecutor;
  private readonly lock: RunLock;
  private readonly heartbeat: Heartbeat;
  private readonly evaluator: Evaluator;
  private readonly defaultTags: string[];
  private readonly defaultMetadata: Record<string, unknown>;
  private readonly subscribers = new Map<string, Set<RunStreamCallback>>();
  private readonly abortControllers = new Map<string, AbortController>();
  /** Active execution handles — used to resolve pending approvals/input while Engine is suspended */
  private readonly executionHandles = new Map<string, RunExecutionHandle>();

  constructor(config: RunManagerConfig) {
    this.store = config.store;
    this.queue = new RunQueue({ concurrency: config.concurrency ?? 1 });
    // Accept either a RunExecutor instance or an EngineRunnerConfig
    this.runner = isRunExecutor(config.executor)
      ? config.executor
      : new EngineRunner(config.executor);
    this.lock = new RunLock({
      runsDir: config.runsDir,
      staleMs: config.staleLockMs,
    });
    this.heartbeat = new Heartbeat({
      runsDir: config.runsDir,
      intervalMs: config.heartbeatIntervalMs,
    });
    this.evaluator = config.evaluator ?? new NoopEvaluator();
    this.defaultTags = config.defaultTags ?? [];
    this.defaultMetadata = config.defaultMetadata ?? {};

    // Wire queue executor
    this.queue.setExecutor((runId) => this.executeRun(runId));
  }

  // ─── Submit ────────────────────────────────────────────────────

  async submit(input: SubmitRunInput): Promise<RunSnapshot> {
    const now = Date.now();
    const runId = nanoid(16);

    const snapshot: RunSnapshot = {
      runId,
      objective: input.objective,
      preset: input.preset ?? "terminal-coding",
      cwd: input.cwd ?? process.cwd(),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      parentRunId: input.parentRunId ?? null,
      sessionId: null,
      childSessionIds: [],
      attemptCount: 0,
      latestCheckpointId: null,
      latestApprovalId: null,
      summary: null,
      error: null,
      tags: [...new Set([...this.defaultTags, ...(input.tags ?? [])])],
      metadata: { ...this.defaultMetadata, ...(input.metadata ?? {}) },
    };

    await this.store.create(snapshot);
    await this.emitRunEvent(runId, "run_created", { objective: input.objective });
    await this.emitRunEvent(runId, "run_queued", {});

    logger.info("run.submitted", { runId, objective: input.objective.slice(0, 120) });

    // Enqueue for execution
    this.queue.enqueue(runId);

    return snapshot;
  }

  // ─── Start (manual, bypasses queue) ────────────────────────────

  async start(runId: string): Promise<void> {
    const run = await this.getOrThrow(runId);
    if (run.status !== "queued") {
      throw new Error(`Cannot start run ${runId}: current status is ${run.status}`);
    }
    if (!this.queue.isPending(runId) && !this.queue.isActive(runId)) {
      this.queue.enqueue(runId);
    }
  }

  // ─── Resume ────────────────────────────────────────────────────

  async resume(runId: string, input?: ResumeRunInput): Promise<void> {
    const run = await this.getOrThrow(runId);

    if (
      run.status !== "waiting_input" &&
      run.status !== "waiting_approval" &&
      run.status !== "blocked"
    ) {
      throw new Error(`Cannot resume run ${runId}: current status is ${run.status}`);
    }

    const handle = this.executionHandles.get(runId);

    // Case 1: Engine is still suspended (in-process waiting)
    // Resolve the pending promise so Engine continues
    if (handle) {
      if (run.status === "waiting_approval" && input?.approvalDecision) {
        const { approvalId, approved, reason } = input.approvalDecision;

        // Persist the approval decision
        const approval = await this.store.getApproval(runId, approvalId);
        if (approval && approval.status === "pending") {
          approval.status = approved ? "approved" : "rejected";
          approval.resolvedAt = Date.now();
          await this.store.saveApproval(approval);
          await this.emitRunEvent(runId, "approval_resolved", {
            approvalId,
            approved,
            reason,
          });
        }

        // Transition back to running and resolve the suspended Engine
        await this.transition(run, "queued");
        await this.transition(run, "running");
        await this.emitRunEvent(runId, "run_resumed", {});
        handle.resolveApproval(approved, reason);
        return;
      }

      if (run.status === "waiting_input" && input?.userInput) {
        await this.transition(run, "queued");
        await this.transition(run, "running");
        await this.emitRunEvent(runId, "run_resumed", { userInput: input.userInput });
        handle.resolveInput(input.userInput);
        return;
      }
    }

    // Case 2: No active handle (process restarted, or blocked state)
    // Re-queue the run for a fresh execution attempt
    if (input?.approvalDecision) {
      const { approvalId, approved, reason } = input.approvalDecision;
      const approval = await this.store.getApproval(runId, approvalId);
      if (approval && approval.status === "pending") {
        approval.status = approved ? "approved" : "rejected";
        approval.resolvedAt = Date.now();
        await this.store.saveApproval(approval);
        await this.emitRunEvent(runId, "approval_resolved", {
          approvalId,
          approved,
          reason,
        });
      }
    }

    await this.transition(run, "queued");
    await this.emitRunEvent(runId, "run_resumed", {
      userInput: input?.userInput,
    });

    this.queue.enqueue(runId);
  }

  // ─── Cancel ────────────────────────────────────────────────────

  async cancel(runId: string, reason?: string): Promise<void> {
    const run = await this.getOrThrow(runId);

    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new Error(`Cannot cancel run ${runId}: already in terminal state ${run.status}`);
    }

    // Abort active execution
    const ac = this.abortControllers.get(runId);
    if (ac) ac.abort();

    // If Engine is suspended on approval/input, reject it so the promise resolves
    const handle = this.executionHandles.get(runId);
    if (handle) {
      if (handle.hasPendingApproval()) {
        handle.resolveApproval(false, "run cancelled");
      }
      if (handle.hasPendingInput()) {
        handle.resolveInput("(run cancelled)");
      }
    }

    // Remove from pending queue
    this.queue.cancel(runId);

    await this.transition(run, "cancelled");
    run.finishedAt = Date.now();
    await this.store.update(run);
    await this.emitRunEvent(runId, "run_cancelled", { reason });

    logger.info("run.cancelled", { runId, reason });
  }

  // ─── Query ─────────────────────────────────────────────────────

  async get(runId: string): Promise<RunSnapshot | null> {
    return this.store.get(runId);
  }

  async list(query?: ListRunsQuery): Promise<RunSnapshot[]> {
    return this.store.list(query);
  }

  async getEvents(runId: string): Promise<RunEvent[]> {
    return this.store.listEvents(runId);
  }

  // ─── Attach (live stream) ──────────────────────────────────────

  attach(runId: string, cb: RunStreamCallback): DetachFn {
    if (!this.subscribers.has(runId)) {
      this.subscribers.set(runId, new Set());
    }
    this.subscribers.get(runId)!.add(cb);

    return () => {
      const subs = this.subscribers.get(runId);
      if (subs) {
        subs.delete(cb);
        if (subs.size === 0) this.subscribers.delete(runId);
      }
    };
  }

  // ─── Crash Recovery ─────────────────────────────────────────────

  /**
   * Scan for runs stuck in "running" state and recover them.
   *
   * Call this on process startup. For each "running" run:
   *   - If heartbeat is stale AND process is dead → reset to "queued" or "blocked"
   *   - If heartbeat is recent OR process is alive → skip (still executing)
   *
   * Returns the IDs of recovered runs.
   */
  async recover(): Promise<string[]> {
    const runs = await this.store.list({ status: "running" });
    const recovered: string[] = [];

    for (const run of runs) {
      const processAlive = this.heartbeat.isProcessAlive(run.runId);
      const stale = this.heartbeat.isStale(run.runId);

      if (processAlive && !stale) {
        // Still actively running in another process — leave it alone
        logger.info("run.recover.skip", { runId: run.runId, reason: "process alive" });
        continue;
      }

      // Process is dead or heartbeat is stale — recover
      logger.info("run.recover.resetting", {
        runId: run.runId,
        processAlive,
        stale,
      });

      // Force-unlock the stale lock
      await this.lock.forceUnlock(run.runId);

      // Decide recovery action based on attempt count
      if (run.attemptCount >= 3) {
        // Too many retries — mark as blocked
        run.error = "Exceeded max recovery attempts (3)";
        run.status = "blocked";
        run.updatedAt = Date.now();
        await this.store.update(run);
        await this.emitRunEvent(run.runId, "run_blocked", {
          error: run.error,
          recovered: true,
        });
        logger.warn("run.recover.blocked", { runId: run.runId });
      } else {
        // Re-queue for retry
        run.status = "queued";
        run.updatedAt = Date.now();
        await this.store.update(run);
        await this.emitRunEvent(run.runId, "run_resumed", { recovered: true });
        this.queue.enqueue(run.runId);
        logger.info("run.recover.requeued", { runId: run.runId });
      }

      recovered.push(run.runId);
    }

    // Also check waiting runs with stale heartbeats (process died while waiting)
    for (const status of ["waiting_input", "waiting_approval"] as const) {
      const waitingRuns = await this.store.list({ status });
      for (const run of waitingRuns) {
        const stale = this.heartbeat.isStale(run.runId);
        if (stale && !this.heartbeat.isProcessAlive(run.runId)) {
          // The process died while the run was waiting — it stays in waiting
          // state but we clean up the lock so it can be resumed
          await this.lock.forceUnlock(run.runId);
          logger.info("run.recover.unlock_waiting", { runId: run.runId, status });
        }
      }
    }

    return recovered;
  }

  /**
   * Graceful shutdown — stop all heartbeats and release all locks.
   */
  async shutdown(): Promise<void> {
    this.heartbeat.stopAll();
    await this.lock.releaseAll();
    logger.info("run.shutdown");
  }

  // ─── Internal: Execute a run ───────────────────────────────────

  private async executeRun(runId: string): Promise<void> {
    const run = await this.getOrThrow(runId);

    // Acquire run lock — prevents concurrent execution by multiple workers
    const acquired = await this.lock.acquire(runId);
    if (!acquired) {
      logger.warn("run.lock.failed", { runId, reason: "already locked by another worker" });
      return;
    }

    // Start heartbeat so crash recovery can detect liveness
    this.heartbeat.start(runId);

    // Transition to running
    await this.transition(run, "running");
    run.startedAt = run.startedAt ?? Date.now();
    run.attemptCount += 1;
    await this.store.update(run);
    await this.emitRunEvent(runId, "run_started", { attempt: run.attemptCount });

    // Create abort controller for this execution
    const ac = new AbortController();
    this.abortControllers.set(runId, ac);

    // Create checkpoint writer and artifact tracker
    const checkpointWriter = new CheckpointWriter({
      runId,
      objective: run.objective,
      store: this.store,
    });
    const artifactTracker = new ArtifactTracker({ runId, store: this.store });

    // Build lifecycle hooks so Engine can notify us about approval/input needs
    const lifecycleHooks: RunLifecycleHooks = {
      onApprovalNeeded: async (request: ApprovalRequest) => {
        return this.handleApprovalNeeded(runId, request);
      },
      onInputNeeded: async (question: string) => {
        await this.handleInputNeeded(runId, question);
      },
    };

    const context: RunExecutionContext = {
      signal: ac.signal,
      onStream: async (event: StreamEvent) => {
        // Feed events to checkpoint writer and artifact tracker
        await checkpointWriter.onStreamEvent(event);
        await artifactTracker.onStreamEvent(event);

        // Forward to run subscribers
        this.notifySubscribers(runId, { type: "engine_stream", event });
      },
    };

    try {
      const { result, handle } = await this.runner.execute(
        run,
        context,
        lifecycleHooks,
        // Store handle BEFORE Engine.run() awaits, so resume() can resolve
        // pending approvals/input while Engine is suspended
        (h) => this.executionHandles.set(runId, h),
      );

      // Refresh run state (may have been updated during execution)
      const current = await this.getOrThrow(runId);

      // If the run was moved to a waiting state during execution, don't finalize
      if (
        current.status === "waiting_input" ||
        current.status === "waiting_approval" ||
        current.status === "cancelled"
      ) {
        return;
      }

      // Link session
      if (result.sessionId && current.sessionId !== result.sessionId) {
        current.sessionId = result.sessionId;
        checkpointWriter.setSessionId(result.sessionId);
        await this.emitRunEvent(runId, "session_linked", {
          sessionId: result.sessionId,
        });
      }

      // Write final checkpoint with accumulated data from writer/tracker
      const checkpoint: RunCheckpoint = {
        checkpointId: nanoid(12),
        runId,
        createdAt: Date.now(),
        phase: "final",
        objective: current.objective,
        summary: result.text.slice(0, 500),
        nextAction: null,
        linkedSessionId: result.sessionId,
        touchedTools: checkpointWriter.getTouchedTools(),
        touchedArtifacts: artifactTracker.getRecordedPaths(),
        waitingFor: null,
        evaluator: null,
        metadata: { turnCount: result.turnCount, reason: result.reason },
      };
      await this.store.saveCheckpoint(checkpoint);
      current.latestCheckpointId = checkpoint.checkpointId;
      await this.emitRunEvent(runId, "checkpoint_written", {
        checkpointId: checkpoint.checkpointId,
        phase: "final",
      });

      // Run evaluator on the final checkpoint
      const artifacts = await this.store.listArtifactRefs(runId);
      const evalContext: EvaluatorContext = { run: current, checkpoint, artifacts };
      try {
        const evalResult = await this.evaluator.evaluate(evalContext);
        checkpoint.evaluator = {
          status: evalResult.verdict === "passed" ? "passed" : "failed",
          findings: evalResult.findings,
        };
        await this.store.saveCheckpoint(checkpoint);
      } catch (evalErr) {
        logger.warn("run.evaluator_error", {
          runId,
          error: evalErr instanceof Error ? evalErr.message : String(evalErr),
        });
      }

      // Determine terminal state — evaluator verdict can override
      const engineSuccess = result.reason === "completed";
      const evalFailed = checkpoint.evaluator?.status === "failed";
      const isSuccess = engineSuccess && !evalFailed;
      current.summary = result.text.slice(0, 500);

      if (isSuccess) {
        await this.transition(current, "completed");
        current.finishedAt = Date.now();
        await this.store.update(current);
        await this.emitRunEvent(runId, "run_completed", {
          turnCount: result.turnCount,
          reason: result.reason,
          evaluator: checkpoint.evaluator,
        });
        logger.info("run.completed", { runId, turnCount: result.turnCount });
      } else {
        current.error = evalFailed
          ? `Evaluator failed: ${checkpoint.evaluator?.findings.join("; ")}`
          : `Engine terminated: ${result.reason}`;
        await this.transition(current, "failed");
        current.finishedAt = Date.now();
        await this.store.update(current);
        await this.emitRunEvent(runId, "run_failed", {
          reason: evalFailed ? "evaluator_failed" : result.reason,
          error: current.error,
          evaluator: checkpoint.evaluator,
        });
        logger.warn("run.failed", { runId, reason: evalFailed ? "evaluator" : result.reason });
      }
    } catch (err) {
      const current = await this.store.get(runId);
      if (!current) return;

      // If aborted (cancelled), state is already handled
      if (ac.signal.aborted) return;

      const errorMsg = err instanceof Error ? err.message : String(err);
      current.error = errorMsg;
      await this.transition(current, "blocked");
      await this.store.update(current);
      await this.emitRunEvent(runId, "run_blocked", { error: errorMsg });
      logger.error("run.blocked", { runId, error: errorMsg });
    } finally {
      this.abortControllers.delete(runId);
      this.executionHandles.delete(runId);
      this.heartbeat.stop(runId);
      await this.lock.release(runId);
    }
  }

  // ─── Lifecycle: Approval Needed ────────────────────────────────

  private async handleApprovalNeeded(
    runId: string,
    request: ApprovalRequest,
  ): Promise<{ approvalId: string }> {
    const approvalId = nanoid(12);
    const run = await this.getOrThrow(runId);

    // Create approval record
    const approval: RunApproval = {
      approvalId,
      runId,
      createdAt: Date.now(),
      resolvedAt: null,
      status: "pending",
      category: "tool",
      title: `Approve: ${request.toolName}`,
      description: request.description,
      payload: { toolName: request.toolName, args: request.args, riskLevel: request.riskLevel },
    };
    await this.store.saveApproval(approval);
    run.latestApprovalId = approvalId;

    // Write waiting checkpoint
    const checkpoint: RunCheckpoint = {
      checkpointId: nanoid(12),
      runId,
      createdAt: Date.now(),
      phase: "waiting_approval",
      objective: run.objective,
      summary: `Awaiting approval for ${request.toolName}: ${request.description}`,
      nextAction: null,
      linkedSessionId: run.sessionId,
      touchedTools: [],
      touchedArtifacts: [],
      waitingFor: { kind: "approval", approvalId },
      evaluator: null,
      metadata: {},
    };
    await this.store.saveCheckpoint(checkpoint);
    run.latestCheckpointId = checkpoint.checkpointId;

    // Transition to waiting_approval
    await this.transition(run, "waiting_approval");
    await this.emitRunEvent(runId, "approval_requested", {
      approvalId,
      toolName: request.toolName,
      description: request.description,
      riskLevel: request.riskLevel,
    });
    await this.emitRunEvent(runId, "checkpoint_written", {
      checkpointId: checkpoint.checkpointId,
      phase: "waiting_approval",
    });

    logger.info("run.waiting_approval", { runId, approvalId, tool: request.toolName });

    return { approvalId };
  }

  // ─── Lifecycle: Input Needed ───────────────────────────────────

  private async handleInputNeeded(runId: string, question: string): Promise<void> {
    const run = await this.getOrThrow(runId);

    // Write waiting checkpoint
    const checkpoint: RunCheckpoint = {
      checkpointId: nanoid(12),
      runId,
      createdAt: Date.now(),
      phase: "waiting_input",
      objective: run.objective,
      summary: `Awaiting user input: ${question.slice(0, 200)}`,
      nextAction: null,
      linkedSessionId: run.sessionId,
      touchedTools: [],
      touchedArtifacts: [],
      waitingFor: { kind: "input", prompt: question },
      evaluator: null,
      metadata: {},
    };
    await this.store.saveCheckpoint(checkpoint);
    run.latestCheckpointId = checkpoint.checkpointId;

    // Transition to waiting_input
    await this.transition(run, "waiting_input");
    await this.emitRunEvent(runId, "checkpoint_written", {
      checkpointId: checkpoint.checkpointId,
      phase: "waiting_input",
      question,
    });

    logger.info("run.waiting_input", { runId, question: question.slice(0, 120) });
  }

  // ─── State Machine ─────────────────────────────────────────────

  private async transition(run: RunSnapshot, to: RunStatus): Promise<void> {
    const allowed = VALID_TRANSITIONS[run.status];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid run state transition: ${run.status} -> ${to} (run ${run.runId})`,
      );
    }
    run.status = to;
    run.updatedAt = Date.now();
    await this.store.update(run);

    this.notifySubscribers(run.runId, {
      type: "run_status_changed",
      run: { ...run },
    });
  }

  // ─── Event Sourcing ────────────────────────────────────────────

  private async emitRunEvent(
    runId: string,
    type: RunEvent["type"],
    data: Record<string, unknown>,
  ): Promise<void> {
    const event: RunEvent = {
      eventId: nanoid(12),
      runId,
      type,
      timestamp: Date.now(),
      data,
    };
    await this.store.appendEvent(event);

    this.notifySubscribers(runId, { type: "run_event", event });
  }

  // ─── Subscribers ───────────────────────────────────────────────

  private notifySubscribers(runId: string, event: RunStreamEvent): void {
    const subs = this.subscribers.get(runId);
    if (!subs) return;
    for (const cb of subs) {
      try {
        cb(event);
      } catch (err) {
        // Remove broken subscriber to prevent repeated errors
        subs.delete(cb);
        logger.warn("run.subscriber_error", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private async getOrThrow(runId: string): Promise<RunSnapshot> {
    const run = await this.store.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }
}

// ─── Type guard ─────────────────────────────────────────────────

function isRunExecutor(obj: RunExecutor | EngineRunnerConfig): obj is RunExecutor {
  return obj != null && typeof (obj as RunExecutor).execute === "function";
}
