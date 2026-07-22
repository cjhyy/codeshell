import { createHash } from "node:crypto";
import {
  buildPetLongTaskContext,
  petLongTaskResumePrompt,
  type PetLongTask,
  type PetLongTaskArtifact,
  type PetLongTaskClosureDecision,
  type PetLongTaskContinuationDecision,
  type PetLongTaskContext,
  type PetLongTaskControlRequest,
  type PetLongTaskControlResult,
  type PetLongTaskPhase,
  type PetLongTaskSnapshot,
} from "@cjhyy/code-shell-pet";
import type { PetAutoDelegation } from "./pet-dispatch-service.js";
import type { PetWorkDelegationLaunch } from "./pet-work-delegation-host.js";
import { petDelegationSessionId } from "./pet-work-delegation-host.js";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  PetStateAggregator,
} from "./pet-state-aggregator.js";
import { PetLongTaskStore } from "./pet-long-task-store.js";

const MAX_PET_LONG_TASK_SUMMARY_LENGTH = 8_000;

interface PetLongTaskWorker {
  hasLiveWorker(): boolean;
  requestWorker(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }>;
}

interface PetLongTaskCoordinatorOptions {
  store: PetLongTaskStore;
  projection: Pick<PetStateAggregator, "getSnapshot" | "subscribe">;
  worker: PetLongTaskWorker;
  launcher: { start(delegation: PetAutoDelegation): Promise<PetWorkDelegationLaunch> };
  now?: () => number;
  onTaskClosed?: (task: PetLongTask) => Promise<void>;
  onBackgroundError?: (operation: string, error: unknown) => void;
}

export interface PetLongTaskLaunch extends PetWorkDelegationLaunch {
  taskId: string;
}

function taskIdFor(clientMessageId: string): string {
  return `pet-task-${createHash("sha256").update(clientMessageId).digest("hex").slice(0, 24)}`;
}

function isTerminal(task: PetLongTask): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}

function isControllable(task: PetLongTask): boolean {
  return !isTerminal(task);
}

function topLevelEvent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  return typeof event.type === "string" && event.agentId === undefined ? event : null;
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
  const match = /\bsaved to\s+(.+?)(?:\r?\n|$)/iu.exec(output);
  const reference = match?.[1]?.trim().replace(/^`|`$/gu, "");
  if (!reference || !/\.(?:png|jpe?g|gif|webp)$/iu.test(reference)) return [];
  return [{ kind: "file", label: "Generated image", reference: reference.slice(0, 2_048) }];
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

  constructor(private readonly options: PetLongTaskCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.options.store.load();
    for (const task of this.options.store.getSnapshot().tasks) {
      if (isTerminal(task) && !task.closureRecordedAt) await this.notifyClosed(task);
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

  async recordClosureDecision(
    taskId: string,
    decision: Pick<PetLongTaskClosureDecision, "key" | "text"> & {
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
      objective: delegation.task,
      workspacePath: delegation.workspacePath,
      sessionId,
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

  /** Observe the exact, top-level session stream retained by AgentBridge. */
  async observeSessionEvent(sessionId: string, value: unknown): Promise<void> {
    const event = topLevelEvent(value);
    if (!event) return;
    const task = this.options.store.activeForSession(sessionId);
    if (!task || task.status === "paused" || task.status === "cancelled") return;
    const at = this.now();
    switch (event.type) {
      case "stream_request_start":
        if (task.status === "queued" || task.status === "interrupted") {
          await this.options.store.transition(task.id, { kind: "started", at });
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
          await this.options.store.transition(task.id, { kind: "artifact", at, artifacts });
        }
        return;
      }
      case "assistant_message": {
        const summary = extractText(event.message);
        if (summary) {
          await this.options.store.transition(task.id, {
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
        if (status === "met") {
          const current = this.options.store.get(task.id);
          if (!current || current.status === "paused" || current.status === "cancelled") return;
          const completed = await this.options.store.transition(task.id, {
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
        if (status === "exhausted") {
          const failed = await this.options.store.transition(task.id, {
            kind: "failed",
            at,
            error: gaps ?? "The Goal continuation limit was exhausted before completion",
          });
          await this.notifyClosed(failed);
          return;
        }
        if (status === "not_met" || status === "approaching_limit") {
          await this.options.store.transition(task.id, {
            kind: "checkpoint",
            at,
            summary: gaps ?? "The goal is not complete yet; the worker is continuing",
            nextAction: "Close the remaining goal gaps",
          });
        }
        return;
      }
      case "goal_cleared": {
        if (task.verificationMode === "goal") {
          await this.options.store.transition(task.id, {
            kind: "verification-changed",
            at,
            mode: "turn",
          });
        }
        return;
      }
      case "turn_complete": {
        const current = this.options.store.get(task.id);
        if (!current || current.status === "paused" || current.status === "cancelled") return;
        if (event.reason === "completed") {
          if (event.completionKind === "background_wait") {
            await this.options.store.transition(task.id, {
              kind: "interrupted",
              at,
              reason: "The work session yielded until its background result notification arrives",
            });
            return;
          }
          if (event.completionKind === "goal_control_stop") {
            await this.options.store.transition(task.id, {
              kind: "interrupted",
              at,
              reason: "Goal driving stopped; the durable Work Session can continue without it",
            });
            return;
          }
          if (event.completionKind === "limit_stop") {
            await this.options.store.transition(task.id, {
              kind: "interrupted",
              at,
              reason: "The work session reached its run limit before a final response",
            });
            return;
          }
          if (current.verificationMode === "turn") {
            const completed = await this.options.store.transition(task.id, {
              kind: "completed",
              at,
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
          await this.options.store.transition(task.id, {
            kind: "interrupted",
            at,
            reason: "The work session stopped without a verified Goal-complete signal",
          });
        } else if (event.reason === "aborted_streaming" || event.reason === "aborted_tools") {
          await this.options.store.transition(task.id, {
            kind: "interrupted",
            at,
            reason: "The work session stopped before the objective was complete",
          });
        } else {
          const failed = await this.options.store.transition(task.id, {
            kind: "failed",
            at,
            error: `Work session ended: ${String(event.reason ?? "unknown")}`,
          });
          await this.notifyClosed(failed);
        }
        return;
      }
      case "error": {
        const failed = await this.options.store.transition(task.id, {
          kind: "failed",
          at,
          error: typeof event.error === "string" ? event.error : "Work session failed",
        });
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
      if (task?.status === "waiting") {
        await this.options.store.transition(task.id, {
          kind: "resumed",
          at: event.observedAt,
          message: "The pending decision was resolved",
        });
      }
      return;
    }
    if (event.kind !== "session-upsert") return;
    const task = this.options.store.activeForSession(event.session.agentSessionId);
    if (!task || task.status === "paused") return;
    if (event.session.completionKind) {
      const reason =
        event.session.completionKind === "background_wait"
          ? "The work session yielded until its background result notification arrives"
          : event.session.completionKind === "goal_control_stop"
            ? "Goal driving stopped; the durable Work Session can continue without it"
            : "The work session reached its run limit before a final response";
      await this.options.store.transition(task.id, {
        kind: "interrupted",
        at: event.observedAt,
        reason,
      });
      return;
    }
    if (event.session.terminal) {
      if (event.session.terminal.status === "completed") {
        if (task.verificationMode === "turn") {
          const completed = await this.options.store.transition(task.id, {
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
          await this.options.store.transition(task.id, {
            kind: "interrupted",
            at: event.session.terminal.at,
            reason: "The Session ended without a retained Goal-complete signal; verify or retry",
          });
        }
      } else if (event.session.terminal.status === "cancelled") {
        const cancelled = await this.options.store.transition(task.id, {
          kind: "cancelled",
          at: event.session.terminal.at,
          reason: "The work session was stopped before completion",
        });
        await this.notifyClosed(cancelled);
      } else {
        const failed = await this.options.store.transition(task.id, {
          kind: "failed",
          at: event.session.terminal.at,
          error: event.session.summary ?? "The work session failed",
        });
        await this.notifyClosed(failed);
      }
      return;
    }
    if (event.session.pendingDecisionCount > 0) {
      await this.options.store.transition(task.id, {
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
    const sessions = new Map(snapshot.sessions.map((session) => [session.agentSessionId, session]));
    for (const task of this.options.store.activeTasks()) {
      if (task.status === "paused") continue;
      const session = sessions.get(task.sessionId);
      if (!session) {
        if (task.status !== "interrupted") {
          await this.options.store.transition(task.id, {
            kind: "interrupted",
            at: snapshot.observedAt || this.now(),
            reason: "The durable work session is not currently live",
          });
        }
        continue;
      }
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
    await this.options.store.transition(task.id, { kind: "progress", at, phase, summary });
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
        .requestWorker("agent/cancel", { sessionId: paused.sessionId }, 15_000)
        .catch((error) => this.options.onBackgroundError?.("pause-cancel", error));
    }
    return { ok: true, task: this.options.store.get(task.id) ?? paused };
  }

  private async pausePersistedGoal(task: PetLongTask): Promise<void> {
    const state = await this.options.worker.requestWorker(
      "agent/goalGet",
      { sessionId: task.sessionId },
      10_000,
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
      await this.options.launcher.start({
        clientMessageId: `${task.originClientMessageId}:resume:${resumed.revision}`,
        task: petLongTaskResumePrompt(resumed),
        ...(resumed.verificationMode === "goal" ? { goalObjective: resumed.objective } : {}),
        workspacePath: resumed.workspacePath,
        targetSessionId: resumed.sessionId,
      });
      return { ok: true, task: this.options.store.get(task.id) ?? resumed };
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
    });
    try {
      await this.options.launcher.start({
        clientMessageId: `${task.originClientMessageId}:retry:${retrying.attempt}`,
        task: petLongTaskResumePrompt(retrying),
        ...(retrying.verificationMode === "goal" ? { goalObjective: retrying.objective } : {}),
        workspacePath: retrying.workspacePath,
        targetSessionId: retrying.sessionId,
      });
      const started = await this.options.store.transition(task.id, {
        kind: "started",
        at: this.now(),
        message: `Retry attempt ${retrying.attempt} started`,
      });
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
    const cancelled = await this.options.store.transition(task.id, {
      kind: "cancelled",
      at: this.now(),
      reason: "Cancelled by user",
    });
    if (this.options.worker.hasLiveWorker()) {
      await this.options.worker
        .requestWorker("agent/cancel", { sessionId: cancelled.sessionId }, 15_000)
        .catch((error) => this.options.onBackgroundError?.("cancel-run", error));
      await this.options.worker
        .requestWorker("agent/goalClear", { sessionId: cancelled.sessionId }, 10_000)
        .catch((error) => this.options.onBackgroundError?.("cancel-goal", error));
    }
    await this.notifyClosed(cancelled);
    return { ok: true, task: this.options.store.get(task.id) ?? cancelled };
  }

  private async notifyClosed(task: PetLongTask): Promise<void> {
    if (!isTerminal(task) || task.closureRecordedAt) return;
    const key = `${task.id}:${task.attempt}:${task.status}`;
    const existing = this.closedNotifications.get(key);
    if (existing) return existing;
    const operation = (async () => {
      try {
        await this.options.onTaskClosed?.(task);
        await this.options.store.transition(task.id, {
          kind: "closure-recorded",
          at: this.now(),
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
