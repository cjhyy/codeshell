/**
 * Goal RPC request/response shaping for AgentServer. Pure functions: the
 * server resolves its live/legacy targets and sends; validation, routing
 * outcome and the agent/goalGet payload live here. Desktop hosts that answer
 * agent/goalGet themselves reuse {@link goalGetPayload} so every host returns
 * the same shape.
 */
import type { GoalConfig, GoalExtension, GoalProgressSnapshot } from "../goal/lifecycle.js";
import { goalExtensionInputError } from "./dispatch.js";
import { ErrorCodes } from "./types.js";

/** Anything whose in-flight Goal run can be extended (ChatSession or a legacy Engine). */
export interface GoalExtendTarget {
  extendGoalRun(ext: GoalExtension): {
    maxTurns: number;
    tokenBudget?: number;
    timeBudgetMs?: number;
    maxStopBlocks: number;
  } | null;
}

export type GoalExtendOutcome =
  | { ok: true; limits: NonNullable<ReturnType<GoalExtendTarget["extendGoalRun"]>> }
  | { ok: false; code: number; message: string };

/**
 * Validate an agent/goalExtend request and apply it to the routed target:
 * the named live session, else the legacy single engine (mirroring cancel).
 */
export function goalExtendOutcome(
  rawParams: unknown,
  resolveSession: (sessionId: string) => GoalExtendTarget | undefined,
  legacy: GoalExtendTarget | null | undefined,
): GoalExtendOutcome {
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return {
      ok: false,
      code: ErrorCodes.InvalidParams,
      message: "goal extension params are required",
    };
  }
  const inputError = goalExtensionInputError(rawParams as Record<string, unknown>);
  if (inputError) return { ok: false, code: ErrorCodes.InvalidParams, message: inputError };
  const params = rawParams as { sessionId?: unknown } & GoalExtension;
  const ext: GoalExtension = {
    addTurns: params.addTurns,
    addTokenBudget: params.addTokenBudget,
    addTimeBudgetMs: params.addTimeBudgetMs,
    addStopBlocks: params.addStopBlocks,
  };
  const session =
    typeof params.sessionId === "string" ? resolveSession(params.sessionId) : undefined;
  const target = session ?? legacy ?? undefined;
  if (!target) {
    return {
      ok: false,
      code: ErrorCodes.SessionClosed,
      message:
        typeof params.sessionId === "string" && params.sessionId
          ? `No such session: ${params.sessionId}`
          : "sessionId is required",
    };
  }
  const limits = target.extendGoalRun(ext);
  return limits
    ? { ok: true, limits }
    : { ok: false, code: ErrorCodes.InvalidParams, message: "No active run to extend" };
}

/**
 * The agent/goalGet payload: the objective (null when none) plus identity,
 * deadline anchor and goal-level progress. Progress is attached only when it
 * belongs to the same goal identity.
 */
export function goalGetPayload(
  goal: GoalConfig | null | undefined,
  progress?: (GoalProgressSnapshot & { goalId: string }) | null,
) {
  const sameGoal = !!goal && !!progress && progress.goalId === goal.goalId;
  return {
    ok: true as const,
    goal: goal ? goal.objective : null,
    ...(goal?.goalId ? { goalId: goal.goalId } : {}),
    ...(goal?.revision ? { revision: goal.revision } : {}),
    ...(goal?.setAtMs ? { setAtMs: goal.setAtMs } : {}),
    paused: goal?.paused === true,
    ...(sameGoal
      ? {
          progress: {
            rounds: progress.rounds,
            activeMs: progress.activeMs,
            ...(progress.runningSinceMs !== undefined
              ? { runningSinceMs: progress.runningSinceMs }
              : {}),
          },
        }
      : {}),
  };
}
