import type { GoalConfig } from "@cjhyy/code-shell-core";
import type { ExternalRuntimeService } from "./external-runtime-service.js";

const GOAL_METHODS = new Set([
  "agent/goalGet",
  "agent/goalUpdate",
  "agent/goalDelete",
  "agent/goalClear",
  "agent/goalExtend",
]);
const MAX_OBJECTIVE_CHARS = 64 * 1024;
export const EXTERNAL_COMPACT_UNSUPPORTED =
  "Codex and Claude Code sessions manage their own context; CodeShell cannot compact them.";

export interface GoalRpcRequest {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

export type ExternalGoalRpcHandler = (
  request: GoalRpcRequest,
  callerWebContentsId: number,
) => Promise<Record<string, unknown>> | undefined;

function objective(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_OBJECTIVE_CHARS) {
    throw new Error("a non-empty, bounded goal objective is required");
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

/** Renderer input cannot supply the identity or timestamp of a durable goal. */
export function parseExternalGoalInput(value: unknown): GoalConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return { objective: objective(value) };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid external runtime goal");
  }
  const raw = value as Record<string, unknown>;
  const goal: GoalConfig = { objective: objective(raw.objective) };
  for (const key of ["maxTurns", "maxStopBlocks", "tokenBudget", "timeBudgetMs"] as const) {
    if (raw[key] !== undefined) goal[key] = positiveInteger(raw[key], key);
  }
  return goal;
}

function expectedVersion(params: Record<string, unknown>) {
  if (
    typeof params.expectedGoalId !== "string" ||
    !params.expectedGoalId.trim() ||
    params.expectedGoalId.length > 128
  ) {
    throw new Error("expectedGoalId is required");
  }
  return {
    expectedGoalId: params.expectedGoalId,
    expectedRevision: positiveInteger(params.expectedRevision, "expectedRevision"),
  };
}

/**
 * Consume external Goal RPCs (and refuse native compaction) before the native
 * worker sees them. A handled failure is still a reply: falling through could
 * resume the wrong runtime or misreport a compaction.
 */
export function createExternalGoalRpcHandler(deps: {
  isExternalSession(sessionId: string): boolean;
  authorize(sessionId: string, callerWebContentsId: number): void | Promise<void>;
  prepareResume(sessionId: string, callerWebContentsId: number): Promise<void>;
  service(): Pick<ExternalRuntimeService, "getGoal" | "updateGoal" | "deleteGoal" | "extendGoal">;
}): ExternalGoalRpcHandler {
  return (request, callerWebContentsId) => {
    const params = request.params ?? {};
    const sessionId = params.sessionId;
    const compact = request.method === "agent/query" && params.type === "compact";
    if (!compact && !GOAL_METHODS.has(request.method ?? "")) return undefined;
    if (typeof sessionId !== "string" || !deps.isExternalSession(sessionId)) return undefined;
    // The native Engine would "compact" a transcript the Codex / Claude thread
    // never reads, reporting success while the provider keeps its context.
    // Neither adapter exposes provider-side compaction, so refuse honestly.
    if (compact) {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: EXTERNAL_COMPACT_UNSUPPORTED },
      });
    }
    return (async () => {
      try {
        await deps.authorize(sessionId, callerWebContentsId);
        const service = deps.service();
        let result: unknown;
        switch (request.method) {
          case "agent/goalGet":
            result = await service.getGoal(sessionId, callerWebContentsId);
            break;
          case "agent/goalUpdate": {
            const expected = expectedVersion(params);
            if (params.paused !== undefined && typeof params.paused !== "boolean") {
              throw new Error("paused must be a boolean");
            }
            const update = {
              ...expected,
              ...(params.objective !== undefined ? { objective: objective(params.objective) } : {}),
              ...(typeof params.paused === "boolean" ? { paused: params.paused } : {}),
            };
            if (update.objective === undefined && update.paused === undefined) {
              throw new Error("goal update requires an objective or paused state");
            }
            // Reject stale UI before starting a runtime. The service repeats
            // the CAS at persistence to fence races during asynchronous ensure.
            const current = await service.getGoal(sessionId, callerWebContentsId);
            if (
              current.goalId !== expected.expectedGoalId ||
              current.revision !== expected.expectedRevision
            ) {
              result = { ok: true, updated: false };
              break;
            }
            if (update.paused === false) await deps.prepareResume(sessionId, callerWebContentsId);
            result = await service.updateGoal(sessionId, update, callerWebContentsId);
            break;
          }
          case "agent/goalDelete": {
            const deleted = await service.deleteGoal(
              sessionId,
              expectedVersion(params),
              callerWebContentsId,
            );
            result = { ok: deleted.ok, deleted: deleted.cleared };
            break;
          }
          case "agent/goalClear":
            result = await service.deleteGoal(sessionId, {}, callerWebContentsId);
            break;
          case "agent/goalExtend": {
            const limits: {
              addTurns?: number;
              addTokenBudget?: number;
              addTimeBudgetMs?: number;
              addStopBlocks?: number;
            } = {};
            for (const key of [
              "addTurns",
              "addTokenBudget",
              "addTimeBudgetMs",
              "addStopBlocks",
            ] as const) {
              if (params[key] !== undefined) limits[key] = positiveInteger(params[key], key);
            }
            if (Object.keys(limits).length === 0)
              throw new Error("at least one goal extension is required");
            result = await service.extendGoal(sessionId, limits, callerWebContentsId);
            break;
          }
        }
        return { jsonrpc: "2.0", id: request.id, result };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
        };
      }
    })();
  };
}
