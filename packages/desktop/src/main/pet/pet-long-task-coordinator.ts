import { createHash } from "node:crypto";
import {
  buildPetLongTaskContext,
  petLongTaskResumePrompt,
  type PetLongTask,
  type PetLongTaskArtifact,
  type PetLongTaskClosureDecision,
  type PetLongTaskCompletionTarget,
  type PetLongTaskContinuationDecision,
  type PetLongTaskContext,
  type PetLongTaskControlRequest,
  type PetLongTaskControlResult,
  type PetLongTaskPhase,
  type PetLongTaskSnapshot,
  type PetLongTaskTransition,
} from "@cjhyy/code-shell-pet";
import type { PetAutoDelegation } from "./pet-dispatch-service.js";
import type { PetWorkDelegationLaunch } from "./pet-work-delegation-host.js";
import {
  petDelegationClientMessageId,
  petDelegationSessionId,
} from "./pet-work-delegation-host.js";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  PetStateAggregator,
} from "./pet-state-aggregator.js";
import { PetLongTaskStore } from "./pet-long-task-store.js";
import type { WorkerFrameMeta } from "@cjhyy/code-shell-server/worker";
import { ErrorCodes } from "@cjhyy/code-shell-core";
import {
  closingOutcome,
  runningOutcome,
  topLevelEvent,
  type SessionOutcome,
} from "./session-outcome.js";

const MAX_PET_LONG_TASK_SUMMARY_LENGTH = 8_000;
const PROJECTION_LAUNCH_GRACE_MS = 2_000;

interface PetLongTaskWorker {
  hasLiveWorker(): boolean;
  requestWorker(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    options: { meta: WorkerFrameMeta },
  ): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }>;
}

interface PetLongTaskCoordinatorOptions {
  store: PetLongTaskStore;
  projection: Pick<PetStateAggregator, "getSnapshot" | "subscribe">;
  worker: PetLongTaskWorker;
  launcher: { start(delegation: PetAutoDelegation): Promise<PetWorkDelegationLaunch> };
  now?: () => number;
  onTaskClosed?: (task: PetLongTask) => Promise<void>;
  /**
   * A delegation's worker run was accepted: a new launch or continuation
   * (not an idempotent replay), a resume, or a retry, whose failed attempt
   * spent the previous rule. Failures are reported and never fail the launch.
   */
  onDelegationStarted?: (task: PetLongTask) => Promise<void>;
  onTaskWorkMemory?: (task: PetLongTask) => Promise<void>;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

export interface PetLongTaskLaunch extends PetWorkDelegationLaunch {
  taskId: string;
}

export interface PetSessionWatchInput {
  originClientMessageId: string;
  requestedAt: number;
  sessionId: string;
  objective: string;
  workspacePath: string | null;
  completionTarget: PetLongTaskCompletionTarget;
}

export interface PetSessionWatchResult {
  task: PetLongTask;
  alreadyWatching: boolean;
}

function taskIdFor(clientMessageId: string): string {
  return `pet-task-${createHash("sha256").update(clientMessageId).digest("hex").slice(0, 24)}`;
}

function watchTaskIdFor(clientMessageId: string, sessionId: string): string {
  return `pet-watch-${createHash("sha256")
    .update(clientMessageId)
    .update("\0")
    .update(sessionId)
    .digest("hex")
    .slice(0, 24)}`;
}

function isTerminal(task: PetLongTask): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}

/**
 * One authoritative completionKind → interruption reason mapping shared by the
 * worker-stream and projection observation paths, so the two can never drift.
 */
function interruptReasonForCompletionKind(kind: string): string {
  switch (kind) {
    case "background_wait":
      return "The work session yielded until its background result notification arrives";
    case "goal_control_stop":
      return "Goal driving stopped; the durable Work Session can continue without it";
    default:
      return "The work session reached its run limit before a final response";
  }
}

function isWaitingForBackgroundResult(task: PetLongTask): boolean {
  const latest = task.events.at(-1);
  return (
    task.status === "waiting" &&
    task.phase === "waiting-worker" &&
    latest?.kind === "waiting" &&
    latest.phase === "waiting-worker"
  );
}

function wasClosedWhileWaitingForBackgroundResult(task: PetLongTask): boolean {
  if (task.status !== "completed" || task.resultSummary) return false;
  let completedIndex = -1;
  for (let index = task.events.length - 1; index >= 0; index -= 1) {
    if (task.events[index]?.kind === "completed") {
      completedIndex = index;
      break;
    }
  }
  if (completedIndex < 1) return false;
  let priorLifecycle: PetLongTask["events"][number] | undefined;
  for (let index = completedIndex - 1; index >= 0; index -= 1) {
    const event = task.events[index];
    if (
      event &&
      [
        "started",
        "progress",
        "waiting",
        "resumed",
        "interrupted",
        "completed",
        "failed",
        "cancelled",
      ].includes(event.kind)
    ) {
      priorLifecycle = event;
      break;
    }
  }
  return (
    (priorLifecycle?.kind === "interrupted" &&
      priorLifecycle.message === interruptReasonForCompletionKind("background_wait")) ||
    (priorLifecycle?.kind === "waiting" && priorLifecycle.phase === "waiting-worker")
  );
}

function isControllable(task: PetLongTask): boolean {
  return !isTerminal(task);
}

/**
 * Cancelling an already-gone Session is idempotent success: there is no live
 * run left to orphan, so the durable Mimi task can safely be closed.
 */
function isMissingSessionCancelOutcome(
  outcome: { ok: true; result: unknown } | { ok: false; message: string; code?: number },
): boolean {
  return !outcome.ok && outcome.code === ErrorCodes.SessionClosed;
}

/** Earliest timestamp that can belong to the current retry/reuse attempt. */
function currentAttemptStartedAt(task: PetLongTask): number {
  const retryAt = [...task.events].reverse().find((event) => event.kind === "retrying")?.at;
  return Math.max(task.createdAt, retryAt ?? task.createdAt, task.startedAt ?? task.createdAt);
}

function projectionPredatesCurrentAttempt(
  task: PetLongTask,
  session: DesktopPetProjectionSnapshot["sessions"][number],
): boolean {
  const sessionAt = session.terminal?.at ?? session.lastActivityAt;
  return sessionAt < currentAttemptStartedAt(task);
}

/**
 * A run that ended as an ordinary completed turn, with no special boundary:
 * it did work, only acknowledged, or its Goal parked it. Whether that closes
 * the task depends on how the task is verified, not on which of these it was.
 */
function isOrdinaryCompletion(outcome: SessionOutcome): boolean {
  return (
    outcome.kind === "idle" ||
    (outcome.kind === "done" && outcome.scope === "turn") ||
    (outcome.kind === "blocked" && outcome.reason !== "limit")
  );
}

function matchesRun(
  task: PetLongTask,
  identity: { runId?: unknown; clientMessageId?: unknown },
): boolean {
  return (
    task.clientMessageId === identity.clientMessageId &&
    (task.runId ? task.runId === identity.runId : !!task.clientMessageId)
  );
}

function runFence(task: PetLongTask) {
  return { attempt: task.attempt, runId: task.runId, clientMessageId: task.clientMessageId };
}

function extractText(value: unknown): string | undefined {
  const collect = (input: unknown): string[] => {
    if (typeof input === "string") return [input];
    if (!Array.isArray(input)) return [];
    return input.flatMap((block) => {
      if (typeof block === "string") return [block];
      if (!block || typeof block !== "object") return [];
      const record = block as Record<string, unknown>;
      return typeof record.text === "string" ? [record.text] : [];
    });
  };
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const text = collect(record.content ?? record.text)
    .join("\n")
    .replace(/\s+/gu, " ")
    .trim();
  return text ? text.slice(0, MAX_PET_LONG_TASK_SUMMARY_LENGTH) : undefined;
}

function generatedImageArtifacts(value: unknown): PetLongTaskArtifact[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const event = value as Record<string, unknown>;
  const result = event.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const record = result as Record<string, unknown>;
  if (record.toolName !== "GenerateImage" || record.isError === true || record.error) return [];
  const output = [record.transcriptResult, record.displayResult, record.result].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  if (!output) return [];
  const match = /\bsaved to\s+([^\r\n]+?\.(?:png|jpe?g|gif|webp))(?=$|\s)/iu.exec(output);
  const reference = match?.[1]?.trim().replace(/^`|`$/gu, "");
  return reference
    ? [{ kind: "file", label: "Generated image", reference: reference.slice(0, 2_048) }]
    : [];
}

function safeToolName(event: Record<string, unknown>): string {
  const toolCall = event.toolCall;
  if (!toolCall || typeof toolCall !== "object") return "tool";
  const name = (toolCall as Record<string, unknown>).toolName;
  return typeof name === "string"
    ? name.replace(/[^\p{L}\p{N}_.:@/-]+/gu, " ").slice(0, 80)
    : "tool";
}

function projectionPhase(phase: string | undefined): PetLongTaskPhase {
  if (phase === "waiting-decision") return "waiting-user";
  if (phase === "finalizing") return "finalizing";
  return "executing";
}

/**
 * Host coordinator that turns DelegateWork into a durable, resumable task.
 * Core Goal mode drives the work session; this layer records Pet-specific
 * lifecycle, reconciles worker/disk state, and exposes explicit controls.
 */
export class PetLongTaskCoordinator {
  private readonly now: () => number;
  private unsubscribeProjection?: () => void;
  private started = false;
  private readonly lastProgressAt = new Map<string, number>();
  private readonly closedNotifications = new Map<string, Promise<void>>();
  private readonly workMemoryNotifications = new Map<string, Promise<void>>();
  private readonly sessionEventQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: PetLongTaskCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.options.store.load();
    for (const task of this.options.store.getSnapshot().tasks) {
      if (!wasClosedWhileWaitingForBackgroundResult(task)) continue;
      const completedAt = task.completedAt ?? task.updatedAt;
      await this.options.store.transition(task.id, {
        kind: "background-wait-recovered",
        // Keep recovery ordered after the old closure without manufacturing a
        // future timestamp that could fence a currently-running Session.
        at: task.updatedAt,
        attemptStartedAt: completedAt + 0.001,
        reason: "The task was closed before its background result arrived",
      });
    }
    for (const task of this.options.store.getSnapshot().tasks) {
      if (
        isTerminal(task) &&
        (!task.closureRecordedAt ||
          (this.options.onTaskWorkMemory !== undefined && !task.workMemoryRecordedAt))
      ) {
        await this.notifyClosed(task);
      }
    }
    this.unsubscribeProjection = this.options.projection.subscribe((event) => {
      void this.observeProjectionEvent(event).catch((error) =>
        this.options.onBackgroundError?.("projection", error),
      );
    });
    await this.reconcile(this.options.projection.getSnapshot());
  }

  stop(): void {
    this.unsubscribeProjection?.();
    this.unsubscribeProjection = undefined;
    this.started = false;
  }

  context(): PetLongTaskContext {
    return buildPetLongTaskContext(this.options.store.getSnapshot().tasks);
  }

  /** Close any watched task whose terminal marker arrived during watch setup. */
  async reconcileNow(): Promise<void> {
    await this.reconcile(this.options.projection.getSnapshot());
  }

  async recordClosureDecision(
    taskId: string,
    decision: Pick<PetLongTaskClosureDecision, "key" | "text"> & {
      replyAttachmentPaths?: string[];
      replyButton?: { text: string; url: string };
      continuation?: PetLongTaskContinuationDecision;
    },
  ): Promise<PetLongTask> {
    return await this.options.store.transition(taskId, {
      kind: "closure-decided",
      at: this.now(),
      ...decision,
    });
  }

  async recordContinuationStarted(
    taskId: string,
    key: string,
    launch: { sessionId: string; taskId?: string },
  ): Promise<PetLongTask> {
    return await this.options.store.transition(taskId, {
      kind: "continuation-started",
      at: this.now(),
      key,
      ...launch,
    });
  }

  async startDelegation(delegation: PetAutoDelegation): Promise<PetLongTaskLaunch> {
    const existing = this.options.store.findByOriginClientMessageId(delegation.clientMessageId);
    if (existing) {
      // A persisted pre-acceptance failure is not a successful launch receipt.
      // In particular, replaying a missing original Session must not turn a
      // refused continuation into a claimed success after a host restart.
      if (existing.status === "failed" && !existing.startedAt && !existing.runId) {
        throw new Error(existing.lastError ?? "The original delegation was not accepted");
      }
      return {
        taskId: existing.id,
        sessionId: existing.sessionId,
        cwd: existing.workspacePath ?? "",
      };
    }
    const sessionId =
      delegation.targetSessionId ?? petDelegationSessionId(delegation.clientMessageId);
    const task = await this.options.store.create({
      id: taskIdFor(delegation.clientMessageId),
      originClientMessageId: delegation.clientMessageId,
      objective: delegation.originalObjective ?? delegation.goalObjective ?? delegation.task,
      workspacePath: delegation.workspacePath,
      sessionId,
      clientMessageId: petDelegationClientMessageId(delegation.clientMessageId),
      verificationMode: delegation.goalObjective ? "goal" : "turn",
      ...(delegation.completionTarget ? { completionTarget: delegation.completionTarget } : {}),
      ...(delegation.continuationDepth ? { continuationDepth: delegation.continuationDepth } : {}),
      at: this.now(),
    });
    try {
      const launch = await this.options.launcher.start(delegation);
      const running = await this.options.store.transition(task.id, {
        kind: "started",
        at: this.now(),
        message: "The worker accepted the long-running task",
      });
      await this.delegationStarted(running);
      return { ...launch, taskId: running.id };
    } catch (error) {
      const failed = await this.options.store.transition(task.id, {
        kind: "failed",
        at: this.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      await this.notifyClosed(failed);
      throw error;
    }
  }

  /** The worker owns the run now; a hook failure must not turn into a failed launch. */
  private async delegationStarted(task: PetLongTask): Promise<void> {
    try {
      await this.options.onDelegationStarted?.(task);
    } catch (error) {
      this.options.onBackgroundError?.("delegationStarted", error);
    }
  }

  /**
   * Adopt an already-running ordinary Work Session into Mimi's durable task
   * ledger so the normal terminal-event and proactive-receipt path can watch it.
   * This does not launch, resume, or otherwise mutate the observed Session.
   */
  async watchSession(input: PetSessionWatchInput): Promise<PetSessionWatchResult> {
    const active = this.options.store.activeForSession(input.sessionId);
    if (active) {
      const target = active.completionTarget;
      if (!target) {
        const task = await this.options.store.transition(active.id, {
          kind: "completion-target-set",
          at: this.now(),
          completionTarget: input.completionTarget,
        });
        return { task, alreadyWatching: false };
      }
      if (
        target?.kind === input.completionTarget.kind &&
        target.channel === input.completionTarget.channel &&
        target.target === input.completionTarget.target
      ) {
        return { task: active, alreadyWatching: true };
      }
      throw new Error("This Session is already managed with a different completion route");
    }

    const snapshot = this.options.projection.getSnapshot();
    const session = snapshot.sessions.find(
      (candidate) => candidate.agentSessionId === input.sessionId,
    );
    if (!session) throw new Error("The selected Work Session is no longer available");
    if (session.terminal) throw new Error("The selected Work Session has already ended");
    if (
      session.runState !== "running" &&
      session.runState !== "queued" &&
      session.pendingDecisionCount === 0 &&
      session.completionKind !== "background_wait"
    ) {
      throw new Error("The selected Work Session is not active");
    }

    const at = input.requestedAt;
    const created = await this.options.store.create({
      id: watchTaskIdFor(input.originClientMessageId, input.sessionId),
      originClientMessageId: input.originClientMessageId,
      objective: input.objective,
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
      runId: session.runId,
      clientMessageId: session.clientMessageId,
      verificationMode: "turn",
      completionTarget: input.completionTarget,
      at,
    });
    let task = await this.options.store.transition(created.id, {
      kind: "started",
      at,
      message: "Mimi subscribed to an existing Work Session",
    });
    if (session.pendingDecisionCount > 0) {
      task = await this.options.store.transition(created.id, {
        kind: "waiting",
        at,
        waitingFor: session.summary ?? "The work session needs a user decision",
      });
    } else if (session.completionKind === "background_wait") {
      task = await this.options.store.transition(created.id, {
        kind: "waiting-worker",
        at,
        waitingFor: interruptReasonForCompletionKind(session.completionKind),
      });
    }
    return { task, alreadyWatching: false };
  }

  async control(request: PetLongTaskControlRequest): Promise<PetLongTaskControlResult> {
    const task = this.options.store.get(request.taskId);
    if (!task) {
      return { ok: false, code: "not-found", message: "The Pet task no longer exists" };
    }
    switch (request.action) {
      case "pause":
        return this.pause(task);
      case "resume":
        return this.resume(task);
      case "retry":
        return this.retry(task);
      case "cancel":
        return this.cancel(task);
    }
  }

  async clearTerminal(): Promise<PetLongTaskSnapshot> {
    const terminal = this.options.store.getSnapshot().tasks.filter((task) => isTerminal(task));
    await Promise.all(terminal.map((task) => this.notifyClosed(task)));
    return this.options.store.clearTerminal();
  }

  async clearTerminalTask(taskId: string): Promise<PetLongTaskSnapshot> {
    const task = this.options.store.get(taskId);
    if (!task) throw new Error("The Pet long task no longer exists");
    if (!isTerminal(task)) throw new Error("Only ended Pet long tasks can be cleared");
    await this.notifyClosed(task);
    return this.options.store.removeTerminal(taskId);
  }

  /**
   * Observe the exact, top-level session stream retained by AgentBridge.
   * `outcomes` is what `SessionOutcomeDeriver` made of this event (see
   * `createSessionOutcomeTap`): it drives every terminal / interrupt
   * transition, while progress, checkpoints and artifacts read the event.
   */
  async observeSessionEvent(
    sessionId: string,
    value: unknown,
    outcomes: readonly SessionOutcome[],
  ): Promise<void> {
    const previous = this.sessionEventQueues.get(sessionId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.applySessionEvent(sessionId, value, outcomes));
    this.sessionEventQueues.set(sessionId, operation);
    try {
      await operation;
    } finally {
      if (this.sessionEventQueues.get(sessionId) === operation)
        this.sessionEventQueues.delete(sessionId);
    }
  }

  private async applySessionEvent(
    sessionId: string,
    value: unknown,
    outcomes: readonly SessionOutcome[],
  ): Promise<void> {
    const event = topLevelEvent(value);
    if (!event) return;
    // What the event means is decided once, by SessionOutcomeDeriver; the
    // outcome → task-state mapping is tabulated in session-outcome.ts.
    const closing = closingOutcome(outcomes);
    const running = runningOutcome(outcomes);
    const task =
      this.options.store.activeForSession(sessionId) ??
      this.options.store.latestForSession(sessionId);
    if (!task || task.status === "paused" || task.status === "cancelled") return;
    const at = this.now();
    if (event.type === "session_started") {
      if (isTerminal(task) || typeof event.runId !== "string" || !event.runId) return;
      if (task.runId && matchesRun(task, event)) return;
      const backgroundResume =
        task.runId && event.previousRunId === task.runId && event.clientMessageId === undefined;
      if (task.runId && !backgroundResume) return;
      if (!backgroundResume && task.clientMessageId !== event.clientMessageId) return;
      await this.options.store.transition(task.id, {
        kind: "run-bound",
        at,
        attempt: task.attempt,
        runId: event.runId,
        clientMessageId:
          typeof event.clientMessageId === "string" ? event.clientMessageId : undefined,
        previousRunId: task.runId,
      });
      return;
    }
    if (!matchesRun(task, event)) return;
    const transition = (input: PetLongTaskTransition) =>
      this.options.store.transition(task.id, { ...runFence(task), ...input });
    if (task.status === "completed") {
      if (!task.runId) return;
      // An assistant_message may precede a Goal rejection or a steer backfill.
      // Only the finalized run payload is safe to publish as a result update.
      if (closing && isOrdinaryCompletion(closing)) {
        const summary = typeof event.text === "string" ? extractText(event) : undefined;
        if (task.verificationMode === "turn" || summary) {
          await transition({
            kind: "result-updated",
            at,
            summary,
            ...(task.verificationMode === "turn" ? { terminalStatus: "completed" as const } : {}),
            attempt: task.attempt,
            runId: task.runId,
          });
        }
      } else if (closing?.kind === "failed") {
        await transition({
          kind: "result-updated",
          at,
          terminalStatus: "failed",
          summary: closing.error,
          attempt: task.attempt,
          runId: task.runId!,
        });
      } else if (running?.kind === "done") {
        // goal_progress(met): the Goal was verified after the task had closed.
        await transition({
          kind: "result-updated",
          at,
          terminalStatus: "completed",
          attempt: task.attempt,
          runId: task.runId!,
        });
      }
      return;
    }
    switch (event.type) {
      case "stream_request_start":
        if (
          task.status === "queued" ||
          task.status === "interrupted" ||
          isWaitingForBackgroundResult(task)
        ) {
          await transition({ kind: "started", at });
        }
        return;
      case "tool_use_start":
        await this.recordProgress(task, at, `Running ${safeToolName(event)}`);
        return;
      case "context_compact":
        await this.recordProgress(task, at, "Compacting context for continued work");
        return;
      case "tool_result": {
        const artifacts = generatedImageArtifacts(event);
        if (artifacts.length > 0) {
          await transition({ kind: "artifact", at, artifacts });
        }
        return;
      }
      case "assistant_message": {
        const summary = extractText(event.message);
        if (summary) {
          await transition({
            kind: "checkpoint",
            at,
            summary,
            nextAction: "Verify the remaining objective and continue if needed",
          });
        }
        return;
      }
      case "goal_progress": {
        const status = event.status;
        const gaps = typeof event.gaps === "string" ? event.gaps : undefined;
        if (running?.kind === "done") {
          const current = this.options.store.get(task.id);
          if (!current || current.status === "paused" || current.status === "cancelled") return;
          const completed = await transition({
            kind: "completed",
            at,
            summary:
              current.resultSummary ??
              current.summary ??
              "The long-running objective was verified complete",
            artifacts: [
              { kind: "result", label: "Completed work session", reference: current.sessionId },
            ],
          });
          await this.notifyClosed(completed);
          return;
        }
        // The Goal this task was driving is closed, so the task has failed;
        // the rule watcher tells the owner the same outcome as "blocked".
        if (running?.kind === "blocked" && running.reason === "goal_exhausted") {
          const failed = await transition({
            kind: "failed",
            at,
            error: gaps ?? "The Goal continuation limit was exhausted before completion",
          });
          await this.notifyClosed(failed);
          return;
        }
        if (status === "not_met" || status === "approaching_limit") {
          await transition({
            kind: "checkpoint",
            at,
            summary: gaps ?? "The goal is not complete yet; the worker is continuing",
            nextAction: "Close the remaining goal gaps",
          });
        }
        return;
      }
      case "goal_cleared": {
        if (running?.kind === "cancelled" && task.verificationMode === "goal") {
          await transition({
            kind: "verification-changed",
            at,
            mode: "turn",
          });
        }
        return;
      }
      case "turn_complete": {
        const current = this.options.store.get(task.id);
        if (!closing || !current || current.status === "paused" || current.status === "cancelled")
          return;
        if (closing.kind === "failed") {
          if (closing.budgetExhausted && typeof event.text === "string" && event.text.trim()) {
            await transition({
              kind: "checkpoint",
              at,
              summary: extractText(event)!,
              nextAction: "Continue the unfinished objective in the existing Session",
            });
          }
          const failed = await transition({
            kind: "failed",
            at,
            error: closing.budgetExhausted
              ? "Work session reached its turn budget (max_turns); the objective is not verified complete"
              : closing.error,
          });
          await this.notifyClosed(failed);
          return;
        }
        // A completion kind from a newer core: nothing is known about the run.
        if (closing.kind === "unrecognized") return;
        if (closing.kind === "aborted") {
          await transition({
            kind: "interrupted",
            at,
            reason: "The work session stopped before the objective was complete",
          });
          return;
        }
        if (closing.kind === "waiting-worker") {
          await transition({
            kind: "waiting-worker",
            at,
            waitingFor: interruptReasonForCompletionKind("background_wait"),
          });
          return;
        }
        if (!isOrdinaryCompletion(closing)) {
          // The run's token budget stopped it (blocked: limit), or Goal driving
          // stopped (done: goal / cancelled close a goal_control_stop run).
          await transition({
            kind: "interrupted",
            at,
            reason: interruptReasonForCompletionKind(
              closing.kind === "blocked" ? "limit_stop" : "goal_control_stop",
            ),
          });
          return;
        }
        if (current.verificationMode === "turn") {
          const completed = await transition({
            kind: "completed",
            at,
            summary: typeof event.text === "string" ? extractText(event) : undefined,
            artifacts: [
              { kind: "result", label: "Completed work session", reference: current.sessionId },
            ],
          });
          await this.notifyClosed(completed);
          return;
        }
        // Core also uses turn_complete(completed) when a Goal stops because
        // its judge prompt is too large or a continuation cap is reached.
        // Only goal_progress(met) is proof that the objective completed.
        await transition({
          kind: "interrupted",
          at,
          reason: "The work session stopped without a verified Goal-complete signal",
        });
        return;
      }
      case "error": {
        if (running?.kind !== "failed") return;
        const failed = await transition({ kind: "failed", at, error: running.error });
        await this.notifyClosed(failed);
      }
    }
  }

  private async observeProjectionEvent(event: DesktopPetProjectionEvent): Promise<void> {
    if (event.kind === "reset") {
      await this.reconcile(this.options.projection.getSnapshot());
      return;
    }
    if (event.kind === "worker-state") {
      if (event.state === "disconnected" || event.state === "reclaimed") {
        for (const task of this.options.store.activeTasks()) {
          if (task.status === "paused" || task.status === "interrupted") continue;
          await this.options.store.transition(task.id, {
            kind: "interrupted",
            at: event.observedAt,
            reason:
              event.state === "disconnected"
                ? "The worker disconnected; durable session state is available for resume"
                : "The worker was reclaimed before task completion was observed",
          });
        }
      }
      return;
    }
    if (event.kind === "pending-upsert") {
      const task = this.options.store.activeForSession(event.pending.agentSessionId);
      if (task && task.status !== "paused") {
        await this.options.store.transition(task.id, {
          kind: "waiting",
          at: event.observedAt,
          waitingFor: event.pending.title,
          message: "The work session needs a user decision",
        });
      }
      return;
    }
    if (event.kind === "pending-remove") {
      const task = this.options.store.activeForSession(event.sessionId);
      if (task?.status === "waiting" && task.phase === "waiting-user") {
        await this.options.store.transition(task.id, {
          kind: "resumed",
          at: event.observedAt,
          message: "The pending decision was resolved",
        });
      }
      return;
    }
    if (event.kind !== "session-upsert") return;
    if (event.session.runState !== "running" && event.session.runState !== "queued")
      await this.sessionEventQueues.get(event.session.agentSessionId);
    const task =
      this.options.store.activeForSession(event.session.agentSessionId) ??
      this.options.store.latestForSession(event.session.agentSessionId);
    if (!task || task.status === "paused") return;
    // Disk reconciliation can replay the terminal/completion marker of a
    // previous attempt that reused this Session. It is historical evidence,
    // not the outcome of the current launch.
    if (projectionPredatesCurrentAttempt(task, event.session)) return;
    if (!matchesRun(task, event.session)) return;
    if (event.session.terminal && !matchesRun(task, event.session.terminal)) return;
    if (isTerminal(task)) {
      await this.notifyClosed(task);
      return;
    }
    const transition = (input: PetLongTaskTransition) =>
      this.options.store.transition(task.id, { ...runFence(task), ...input });
    if (event.session.completionKind) {
      if (event.session.completionKind === "background_wait") {
        await transition({
          kind: "waiting-worker",
          at: event.observedAt,
          waitingFor: interruptReasonForCompletionKind(event.session.completionKind),
        });
      } else {
        await transition({
          kind: "interrupted",
          at: event.observedAt,
          reason: interruptReasonForCompletionKind(event.session.completionKind),
        });
      }
      return;
    }
    if (event.session.terminal) {
      if (event.session.terminal.status === "completed") {
        // A foreground turn that launched detached work writes an ordinary
        // Session terminal before the background command exits. The retained
        // waiting-worker transition is the more specific evidence; the next
        // background notification starts a fresh run and clears this guard.
        if (isWaitingForBackgroundResult(task)) return;
        if (task.verificationMode === "turn") {
          const completed = await transition({
            kind: "completed",
            at: event.session.terminal.at,
            artifacts: [
              { kind: "result", label: "Completed work session", reference: task.sessionId },
            ],
          });
          await this.notifyClosed(completed);
        } else {
          // The safe projection intentionally omits Goal verdict details. A
          // generic completed Session therefore cannot prove a Goal task met
          // its objective; the trusted goal_progress(met) stream closes it.
          await transition({
            kind: "interrupted",
            at: event.session.terminal.at,
            reason: "The Session ended without a retained Goal-complete signal; verify or retry",
          });
        }
      } else if (event.session.terminal.status === "cancelled") {
        const cancelled = await transition({
          kind: "cancelled",
          at: event.session.terminal.at,
          reason: "The work session was stopped before completion",
        });
        await this.notifyClosed(cancelled);
      } else {
        const failed = await transition({
          kind: "failed",
          at: event.session.terminal.at,
          error: event.session.summary ?? "The work session failed",
        });
        await this.notifyClosed(failed);
      }
      return;
    }
    if (event.session.pendingDecisionCount > 0) {
      await transition({
        kind: "waiting",
        at: event.observedAt,
        waitingFor: event.session.summary ?? "A user decision is required",
      });
      return;
    }
    if (event.session.runState === "running" || event.session.runState === "queued") {
      await this.recordProgress(
        task,
        event.observedAt,
        event.session.summary ?? (event.session.runState === "queued" ? "Queued" : "Running"),
        projectionPhase(event.session.phase),
      );
    }
  }

  private async reconcile(snapshot: DesktopPetProjectionSnapshot): Promise<void> {
    for (const task of this.options.store.getSnapshot().tasks) {
      if (isTerminal(task) && !task.closureRecordedAt) await this.notifyClosed(task);
    }
    const sessions = new Map(snapshot.sessions.map((session) => [session.agentSessionId, session]));
    for (const task of this.options.store.activeTasks()) {
      if (task.status === "paused") continue;
      const session = sessions.get(task.sessionId);
      if (!session) {
        const attemptStartedAt = currentAttemptStartedAt(task);
        const observedAt = snapshot.observedAt || this.now();
        // Launcher acceptance and projection publication are separate async
        // paths. A reset in that short gap must not manufacture an interrupted
        // event before the new Session has had a chance to appear.
        if (
          task.status === "queued" ||
          observedAt - attemptStartedAt < PROJECTION_LAUNCH_GRACE_MS
        ) {
          continue;
        }
        if (task.status !== "interrupted") {
          await this.options.store.transition(task.id, {
            kind: "interrupted",
            at: observedAt,
            reason: "The durable work session is not currently live",
          });
        }
        continue;
      }
      if (projectionPredatesCurrentAttempt(task, session)) continue;
      if (session.terminal || session.completionKind) {
        await this.observeProjectionEvent({
          kind: "session-upsert",
          session,
          version: snapshot.version,
          generation: snapshot.generation,
          observedAt: snapshot.observedAt,
        });
        continue;
      }
      const pending = snapshot.pending.find(
        (decision) => decision.agentSessionId === task.sessionId && decision.status === "pending",
      );
      if (pending) {
        await this.options.store.transition(task.id, {
          kind: "waiting",
          at: snapshot.observedAt || this.now(),
          waitingFor: pending.title,
        });
      } else if (session.runState === "running" || session.runState === "queued") {
        if (task.status === "queued" || task.status === "interrupted") {
          await this.options.store.transition(task.id, {
            kind: "started",
            at: snapshot.observedAt || this.now(),
          });
        }
      } else if (task.status !== "interrupted") {
        await this.options.store.transition(task.id, {
          kind: "interrupted",
          at: snapshot.observedAt || this.now(),
          reason: "The worker is idle; resume the durable task to continue",
        });
      }
    }
  }

  private async recordProgress(
    task: PetLongTask,
    at: number,
    summary: string,
    phase: PetLongTaskPhase = "executing",
  ): Promise<void> {
    const previous = this.options.store.get(task.id);
    if (!previous || previous.status === "paused" || previous.status === "cancelled") return;
    const last = this.lastProgressAt.get(task.id) ?? 0;
    if (previous.summary === summary && at - last < 2_000) return;
    this.lastProgressAt.set(task.id, at);
    await this.options.store.transition(task.id, {
      kind: "progress",
      at,
      phase,
      summary,
      ...runFence(task),
    });
  }

  private async pause(task: PetLongTask): Promise<PetLongTaskControlResult> {
    if (!isControllable(task) || task.status === "paused") {
      return { ok: false, code: "invalid-state", message: "This task cannot be paused" };
    }
    const paused = await this.options.store.transition(task.id, {
      kind: "paused",
      at: this.now(),
      reason: "Paused by user",
    });
    if (this.options.worker.hasLiveWorker()) {
      await this.pausePersistedGoal(paused).catch((error) =>
        this.options.onBackgroundError?.("pause-goal", error),
      );
      await this.options.worker
        .requestWorker("agent/cancel", { sessionId: paused.sessionId }, 15_000, {
          meta: { origin: "host", producer: "pet-long-task-pause" },
        })
        .catch((error) => this.options.onBackgroundError?.("pause-cancel", error));
    }
    return { ok: true, task: this.options.store.get(task.id) ?? paused };
  }

  private async pausePersistedGoal(task: PetLongTask): Promise<void> {
    const state = await this.options.worker.requestWorker(
      "agent/goalGet",
      { sessionId: task.sessionId },
      10_000,
      { meta: { origin: "host", producer: "pet-long-task-goal-get" } },
    );
    if (!state.ok) throw new Error(state.message);
    const goal = state.result as {
      goal?: string | null;
      goalId?: string;
      revision?: number;
      paused?: boolean;
    };
    if (!goal.goalId || !goal.revision || goal.paused) return;
    const updated = await this.options.worker.requestWorker(
      "agent/goalUpdate",
      {
        sessionId: task.sessionId,
        paused: true,
        expectedGoalId: goal.goalId,
        expectedRevision: goal.revision,
      },
      10_000,
      { meta: { origin: "host", producer: "pet-long-task-goal-pause" } },
    );
    if (!updated.ok) throw new Error(updated.message);
    const result = updated.result as { updated?: boolean } | undefined;
    if (result?.updated !== true) throw new Error("The persisted Goal changed before pause");
  }

  private async resume(task: PetLongTask): Promise<PetLongTaskControlResult> {
    if (task.status !== "paused" && task.status !== "interrupted") {
      return {
        ok: false,
        code: "invalid-state",
        message: "Only paused or interrupted tasks resume",
      };
    }
    const resumed = await this.options.store.transition(task.id, {
      kind: "resumed",
      at: this.now(),
    });
    try {
      if (this.options.worker.hasLiveWorker() && (await this.resumePersistedGoal(resumed))) {
        return { ok: true, task: this.options.store.get(task.id) ?? resumed };
      }
      await this.options.store.transition(task.id, {
        kind: "run-prepared",
        at: this.now(),
        attempt: resumed.attempt,
        clientMessageId: petDelegationClientMessageId(
          `${task.originClientMessageId}:resume:${resumed.revision}`,
        ),
      });
      await this.options.launcher.start({
        clientMessageId: `${task.originClientMessageId}:resume:${resumed.revision}`,
        task: petLongTaskResumePrompt(resumed),
        ...(resumed.verificationMode === "goal" ? { goalObjective: resumed.objective } : {}),
        workspacePath: resumed.workspacePath,
        targetSessionId: resumed.sessionId,
        ...(resumed.completionTarget ? { completionTarget: resumed.completionTarget } : {}),
        redrive: true,
      });
      const current = this.options.store.get(task.id) ?? resumed;
      await this.delegationStarted(current);
      return { ok: true, task: current };
    } catch (error) {
      const interrupted = await this.options.store.transition(task.id, {
        kind: "interrupted",
        at: this.now(),
        reason: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        code: "worker-error",
        message: interrupted.waitingFor ?? "The task could not resume",
      };
    }
  }

  private async resumePersistedGoal(task: PetLongTask): Promise<boolean> {
    const state = await this.options.worker.requestWorker(
      "agent/goalGet",
      { sessionId: task.sessionId },
      10_000,
      { meta: { origin: "host", producer: "pet-long-task-resume-get" } },
    );
    if (!state.ok) return false;
    const goal = state.result as {
      goal?: string | null;
      goalId?: string;
      revision?: number;
      paused?: boolean;
    };
    if (!goal.goalId || !goal.revision) return false;
    const updated = await this.options.worker.requestWorker(
      "agent/goalUpdate",
      {
        sessionId: task.sessionId,
        paused: false,
        expectedGoalId: goal.goalId,
        expectedRevision: goal.revision,
      },
      10_000,
      { meta: { origin: "host", producer: "pet-long-task-goal-resume" } },
    );
    if (!updated.ok) return false;
    return (updated.result as { updated?: boolean } | undefined)?.updated === true;
  }

  private async retry(task: PetLongTask): Promise<PetLongTaskControlResult> {
    if (task.status !== "failed" && task.status !== "interrupted") {
      return {
        ok: false,
        code: "invalid-state",
        message: "Only failed or interrupted tasks retry",
      };
    }
    const retrying = await this.options.store.transition(task.id, {
      kind: "retrying",
      at: this.now(),
      clientMessageId: petDelegationClientMessageId(
        `${task.originClientMessageId}:retry:${task.attempt + 1}`,
      ),
    });
    try {
      await this.options.launcher.start({
        clientMessageId: `${task.originClientMessageId}:retry:${retrying.attempt}`,
        task: petLongTaskResumePrompt(retrying),
        ...(retrying.verificationMode === "goal" ? { goalObjective: retrying.objective } : {}),
        workspacePath: retrying.workspacePath,
        targetSessionId: retrying.sessionId,
        ...(retrying.completionTarget ? { completionTarget: retrying.completionTarget } : {}),
        // A delegation the worker never accepted never delivered its brief.
        // (A retry clears startedAt, so earlier accepted attempts count too.)
        ...(task.startedAt !== undefined || task.events.some((event) => event.kind === "started")
          ? { redrive: true }
          : {}),
      });
      const started = await this.options.store.transition(task.id, {
        kind: "started",
        at: this.now(),
        message: `Retry attempt ${retrying.attempt} started`,
      });
      // The failed attempt's closure spent the automatic rule; arm it again.
      await this.delegationStarted(started);
      return { ok: true, task: started };
    } catch (error) {
      const failed = await this.options.store.transition(task.id, {
        kind: "failed",
        at: this.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      await this.notifyClosed(failed);
      return {
        ok: false,
        code: "worker-error",
        message: failed.lastError ?? "The retry could not start",
      };
    }
  }

  private async cancel(task: PetLongTask): Promise<PetLongTaskControlResult> {
    if (task.status === "cancelled" || task.status === "completed") {
      return { ok: false, code: "invalid-state", message: "This task is already closed" };
    }
    const hadLiveWorker = this.options.worker.hasLiveWorker();
    if (hadLiveWorker) {
      try {
        const outcome = await this.options.worker.requestWorker(
          "agent/cancel",
          { sessionId: task.sessionId },
          15_000,
          { meta: { origin: "host", producer: "pet-long-task-cancel" } },
        );
        if (!outcome.ok && !isMissingSessionCancelOutcome(outcome)) {
          throw new Error(outcome.message);
        }
      } catch (error) {
        this.options.onBackgroundError?.("cancel-run", error);
        return {
          ok: false,
          code: "worker-error",
          message: `The task is still running because cancellation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    // Commit the ledger terminal only after a live worker acknowledges cancel.
    // With no live worker there is no in-memory run to orphan.
    const cancelled = await this.options.store.transition(task.id, {
      kind: "cancelled",
      at: this.now(),
      reason: "Cancelled by user",
    });
    if (hadLiveWorker) {
      await this.options.worker
        .requestWorker("agent/goalClear", { sessionId: cancelled.sessionId }, 10_000, {
          meta: { origin: "host", producer: "pet-long-task-goal-clear" },
        })
        .catch((error) => this.options.onBackgroundError?.("cancel-goal", error));
    }
    await this.notifyClosed(cancelled);
    return { ok: true, task: this.options.store.get(task.id) ?? cancelled };
  }

  private async notifyClosed(task: PetLongTask): Promise<void> {
    if (!isTerminal(task)) return;
    // Goal verdicts precede end hooks and the Session's idle boundary. Keep the
    // durable closure pending until that exact run has finished; never wait on
    // the per-session stream queue that must process its remaining events.
    const session = this.options.projection
      .getSnapshot()
      .sessions.find((entry) => entry.agentSessionId === task.sessionId);
    if (
      session &&
      matchesRun(task, session) &&
      (session.runState === "running" || session.runState === "queued")
    )
      return;
    const key = `${task.id}:${task.attempt}:${task.status}`;
    if (!task.closureRecordedAt) {
      const existing = this.closedNotifications.get(key);
      if (existing) {
        await existing;
      } else {
        const operation = (async () => {
          try {
            await this.options.onTaskClosed?.(task);
            await this.options.store.transition(task.id, {
              kind: "closure-recorded",
              at: this.now(),
              ...runFence(task),
              status: task.status,
            });
          } catch (error) {
            this.options.onBackgroundError?.("task-closed", error);
          } finally {
            this.closedNotifications.delete(key);
          }
        })();
        this.closedNotifications.set(key, operation);
        await operation;
      }
    }

    const latest = this.options.store.get(task.id) ?? task;
    if (
      latest.attempt === task.attempt &&
      latest.status === task.status &&
      latest.closureRecordedAt &&
      !latest.workMemoryRecordedAt
    ) {
      await this.recordTaskWorkMemory(latest, key);
    }
  }

  private async recordTaskWorkMemory(task: PetLongTask, key: string): Promise<void> {
    if (!this.options.onTaskWorkMemory) return;
    const existing = this.workMemoryNotifications.get(key);
    if (existing) return existing;
    const operation = (async () => {
      try {
        await this.options.onTaskWorkMemory?.(task);
        await this.options.store.transition(task.id, {
          kind: "work-memory-recorded",
          at: this.now(),
          ...runFence(task),
          status: task.status,
        });
      } catch (error) {
        // Keep the dedicated watermark absent. Startup retries only this
        // idempotent distillation step without repeating closure delivery.
        this.options.onBackgroundError?.("task-work-memory", error);
      } finally {
        this.workMemoryNotifications.delete(key);
      }
    })();
    this.workMemoryNotifications.set(key, operation);
    await operation;
  }
}
