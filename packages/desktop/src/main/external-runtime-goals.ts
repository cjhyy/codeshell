import { randomUUID } from "node:crypto";
import { SessionManager, type GoalConfig, type StreamEvent } from "@cjhyy/code-shell-core";

// These count provider turns, each of which already contains its own tool loop.
export const EXTERNAL_GOAL_DEFAULT_TURNS = 12;
export const EXTERNAL_GOAL_DEFAULT_STOP_BLOCKS = 3;
export const EXTERNAL_GOAL_DEFAULT_TIME_MS = 30 * 60_000;
export const EXTERNAL_GOAL_TOOLS = ["get_goal", "complete_goal", "cancel_goal"] as const;

export interface ExternalGoalUpdate {
  objective?: string;
  paused?: boolean;
  expectedGoalId: string;
  expectedRevision: number;
}

export interface ExternalGoalExtension {
  addTurns?: number;
  addTokenBudget?: number;
  addTimeBudgetMs?: number;
  addStopBlocks?: number;
}

export interface ExternalGoalRun {
  sessionId: string;
  goal: GoalConfig;
  startedAtMs: number;
  turns: number;
  tokensUsed: number;
  maxTurns: number;
  maxStopBlocks: number;
  tokenBudget?: number;
  timeBudgetMs: number;
  stopBlocks: number;
  lastOutput?: string;
  stopped: boolean;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameVersion(left: GoalConfig | undefined, right: GoalConfig): boolean {
  return !!left && left.goalId === right.goalId && left.revision === right.revision;
}

function goalInput(raw: string | GoalConfig): GoalConfig {
  const value = typeof raw === "string" ? { objective: raw } : raw;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.objective !== "string" ||
    !value.objective.trim() ||
    value.objective.length > 64 * 1024
  ) {
    throw new Error("A non-empty, bounded goal objective is required");
  }
  const goal: GoalConfig = { objective: value.objective.trim() };
  for (const key of ["tokenBudget", "timeBudgetMs", "maxTurns", "maxStopBlocks"] as const) {
    if (value[key] !== undefined) {
      if (!positiveInteger(value[key])) throw new Error(`Invalid goal ${key}`);
      goal[key] = value[key];
    }
  }
  return goal;
}

/** Canonical persistence and version fences; no provider-specific state files. */
export class ExternalRuntimeGoals {
  private readonly manager = new SessionManager();
  private readonly runs = new Map<string, ExternalGoalRun>();

  constructor(
    private readonly emit: (sessionId: string, event: StreamEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  read(sessionId: string): GoalConfig | undefined {
    return this.manager.readActiveGoal(sessionId);
  }

  get(sessionId: string) {
    const goal = this.read(sessionId);
    return {
      ok: true as const,
      goal: goal?.objective ?? null,
      ...(goal?.goalId ? { goalId: goal.goalId } : {}),
      ...(goal?.revision ? { revision: goal.revision } : {}),
      paused: goal?.paused === true,
    };
  }

  running(sessionId: string): ExternalGoalRun | undefined {
    return this.runs.get(sessionId);
  }

  start(sessionId: string, explicit?: string | GoalConfig, disabled = false) {
    if (disabled) return undefined;
    const stored = this.read(sessionId);
    let goal = stored;
    if (explicit !== undefined) {
      goal = goalInput(explicit);
      goal.goalId = randomUUID();
      goal.revision = 1;
      goal.setAtMs =
        stored?.objective === goal.objective ? (stored.setAtMs ?? this.now()) : this.now();
      const state = this.manager.readSessionState(sessionId);
      if (!state || !this.manager.saveActiveGoal(state, goal, { replaceCurrent: !!stored })) {
        throw new Error("Could not persist the external runtime goal");
      }
      this.emit(sessionId, {
        type: "goal_set",
        goalId: goal.goalId,
        revision: goal.revision,
        objective: goal.objective,
        replaced: !!stored,
      });
    }
    if (!goal || goal.paused) return undefined;
    const run: ExternalGoalRun = {
      sessionId,
      goal: { ...goal },
      startedAtMs: this.now(),
      turns: 0,
      tokensUsed: 0,
      maxTurns: goal.maxTurns ?? EXTERNAL_GOAL_DEFAULT_TURNS,
      maxStopBlocks: goal.maxStopBlocks ?? EXTERNAL_GOAL_DEFAULT_STOP_BLOCKS,
      tokenBudget: goal.tokenBudget,
      timeBudgetMs: goal.timeBudgetMs ?? EXTERNAL_GOAL_DEFAULT_TIME_MS,
      stopBlocks: 0,
      stopped: false,
    };
    this.runs.set(sessionId, run);
    return run;
  }

  isCurrent(run: ExternalGoalRun): boolean {
    const current = this.read(run.sessionId);
    return (
      this.runs.get(run.sessionId) === run &&
      !run.stopped &&
      !current?.paused &&
      sameVersion(current, run.goal)
    );
  }

  stop(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (run) run.stopped = true;
  }

  end(run: ExternalGoalRun): void {
    if (this.runs.get(run.sessionId) === run) this.runs.delete(run.sessionId);
  }

  update(sessionId: string, patch: ExternalGoalUpdate) {
    if (!patch.expectedGoalId || !positiveInteger(patch.expectedRevision)) {
      throw new Error("Goal controls require the current goalId and revision");
    }
    if (patch.objective !== undefined) goalInput(patch.objective);
    if (patch.paused !== undefined && typeof patch.paused !== "boolean") {
      throw new Error("Invalid goal pause state");
    }
    if (patch.objective === undefined && patch.paused === undefined) {
      throw new Error("A goal update is required");
    }
    const updated = this.manager.updateActiveGoal(sessionId, patch);
    if (!updated) return { ...this.get(sessionId), updated: false };
    this.stop(sessionId);
    this.emitUpdated(sessionId, updated.goal);
    return { ...this.get(sessionId), updated: true };
  }

  delete(sessionId: string, expected?: { expectedGoalId?: string; expectedRevision?: number }) {
    if (
      expected &&
      (expected.expectedGoalId !== undefined || expected.expectedRevision !== undefined) &&
      (!expected.expectedGoalId || !positiveInteger(expected.expectedRevision))
    ) {
      throw new Error("Goal deletion requires the current goalId and revision");
    }
    const goal = this.read(sessionId);
    const cleared = this.manager.clearActiveGoal(sessionId, {
      goalId: expected?.expectedGoalId ?? goal?.goalId,
      revision: expected?.expectedRevision ?? goal?.revision,
    });
    if (cleared) {
      this.stop(sessionId);
      this.emit(sessionId, {
        type: "goal_cleared",
        goalId: goal?.goalId,
        revision: goal?.revision,
      });
    }
    return { ok: true as const, cleared };
  }

  extend(sessionId: string, extension: ExternalGoalExtension) {
    const keys = ["addTurns", "addTokenBudget", "addTimeBudgetMs", "addStopBlocks"] as const;
    if (!keys.some((key) => extension[key] !== undefined)) {
      throw new Error("At least one goal extension is required");
    }
    for (const key of keys) {
      if (extension[key] !== undefined && !positiveInteger(extension[key])) {
        throw new Error(`Invalid goal extension ${key}`);
      }
    }
    const run = this.runs.get(sessionId);
    if (!run || !this.isCurrent(run)) throw new Error("No active external goal run to extend");
    const add = (current: number, delta = 0) => Math.min(Number.MAX_SAFE_INTEGER, current + delta);
    run.maxTurns = add(run.maxTurns, extension.addTurns);
    run.maxStopBlocks = add(run.maxStopBlocks, extension.addStopBlocks);
    if (extension.addTokenBudget) {
      run.tokenBudget = add(run.tokenBudget ?? run.tokensUsed, extension.addTokenBudget);
    }
    run.timeBudgetMs = add(run.timeBudgetMs, extension.addTimeBudgetMs);
    return {
      ok: true as const,
      limits: {
        maxTurns: run.maxTurns,
        maxStopBlocks: run.maxStopBlocks,
        ...(run.tokenBudget !== undefined ? { tokenBudget: run.tokenBudget } : {}),
        timeBudgetMs: run.timeBudgetMs,
      },
    };
  }

  remainingTime(run: ExternalGoalRun): number {
    return Math.max(0, run.timeBudgetMs - (this.now() - run.startedAtMs));
  }

  afterTurn(run: ExternalGoalRun, tokens: number, output: string): boolean {
    run.turns++;
    if (Number.isFinite(tokens) && tokens > 0) run.tokensUsed += tokens;
    run.stopBlocks = run.lastOutput === output ? run.stopBlocks + 1 : 0;
    run.lastOutput = output;
    if (!this.isCurrent(run)) return false;
    const limit =
      run.tokenBudget !== undefined && run.tokensUsed >= run.tokenBudget
        ? "达到本轮 token 预算"
        : this.remainingTime(run) === 0
          ? "达到本轮时间预算"
          : run.turns >= run.maxTurns
            ? "达到本轮自动继续次数上限"
            : run.stopBlocks >= run.maxStopBlocks
              ? "连续多轮没有新的进展"
              : undefined;
    if (limit) {
      this.pause(run, limit);
      return false;
    }
    const remaining = run.maxTurns - run.turns;
    this.emit(run.sessionId, {
      type: "goal_progress",
      goalId: run.goal.goalId,
      revision: run.goal.revision,
      status: remaining <= 2 ? "approaching_limit" : "not_met",
      round: run.turns,
      gaps: "外部运行器尚未声明目标完成，继续处理。",
      ...(remaining <= 2 ? { turnsRemaining: remaining, nearest: "turns" as const } : {}),
    });
    return true;
  }

  pause(run: ExternalGoalRun, reason: string): void {
    if (!this.isCurrent(run)) return;
    const result = this.update(run.sessionId, {
      paused: true,
      expectedGoalId: run.goal.goalId!,
      expectedRevision: run.goal.revision!,
    });
    if (result.updated) {
      this.emit(run.sessionId, {
        type: "goal_progress",
        goalId: result.goalId,
        revision: result.revision,
        status: "not_met",
        round: run.turns,
        gaps: `${reason}；目标已暂停，可继续。`,
      });
    }
  }

  settle(sessionId: string, status: "completed" | "cancelled", args: Record<string, unknown>) {
    const run = this.runs.get(sessionId);
    if (
      !run ||
      !this.isCurrent(run) ||
      args.goalId !== run.goal.goalId ||
      args.revision !== run.goal.revision
    ) {
      return {
        ok: false,
        message: "Goal changed or is not running; read get_goal before retrying.",
      };
    }
    if (
      status === "cancelled" &&
      (args.confirm !== true || typeof args.reason !== "string" || !args.reason.trim())
    ) {
      return { ok: false, message: "Cancellation requires confirm=true and the user's reason." };
    }
    const state = this.manager.readSessionState(sessionId);
    if (!state || this.manager.saveGoalTerminalOutcome(state, run.goal, status) !== "persisted") {
      return { ok: false, message: "Goal changed or could not be saved; no completion recorded." };
    }
    run.stopped = true;
    if (status === "completed") {
      this.emit(sessionId, {
        type: "goal_progress",
        goalId: run.goal.goalId,
        revision: run.goal.revision,
        status: "met",
        round: run.turns + 1,
        ...(typeof args.summary === "string" ? { gaps: args.summary } : {}),
      });
    } else {
      this.emit(sessionId, {
        type: "goal_cleared",
        goalId: run.goal.goalId,
        revision: run.goal.revision,
      });
    }
    return { ok: true, status };
  }

  instruction(run: ExternalGoalRun): string {
    return [
      "<codeshell_goal>",
      `Goal: ${run.goal.objective}`,
      `goalId: ${run.goal.goalId}; revision: ${run.goal.revision}; setAtMs: ${run.goal.setAtMs}.`,
      "Continue useful work toward this persisted goal. A normal final reply does not complete it.",
      "Only when the objective is fully achieved, call mcp__codeshell_tools__complete_goal with this goalId and revision and a completion summary.",
      "Only if the user explicitly cancels it, call mcp__codeshell_tools__cancel_goal with this goalId, revision, confirm=true and the user's reason.",
      "Use mcp__codeshell_tools__get_goal to check the current identity. Do not call the runtime's separate create_goal/update_goal tools for this CodeShell goal.",
      `This run allows ${run.maxTurns} provider turns and ${run.timeBudgetMs} ms${run.tokenBudget ? `, with ${run.tokenBudget} tokens` : ""}. If it pauses, do not claim completion.`,
      "</codeshell_goal>",
    ].join("\n");
  }

  private emitUpdated(sessionId: string, goal: GoalConfig): void {
    this.emit(sessionId, {
      type: "goal_updated",
      goalId: goal.goalId,
      revision: goal.revision,
      objective: goal.objective,
      paused: goal.paused === true,
    });
  }
}
