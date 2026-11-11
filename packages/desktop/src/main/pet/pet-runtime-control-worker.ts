import type { WorkerFrameMeta } from "@cjhyy/code-shell-server/worker";
import type { ExternalRuntimeService } from "../external-runtime-service.js";

export interface PetRuntimeControlWorker {
  hasLiveWorker(sessionId?: string): boolean;
  requestWorker(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    options: { meta: WorkerFrameMeta },
  ): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }>;
}

type ControlService = Pick<
  ExternalRuntimeService,
  "hasSession" | "getGoal" | "updateGoal" | "deleteGoal" | "stop"
>;

function expectedGoalVersion(params: Record<string, unknown>) {
  if (
    typeof params.expectedGoalId !== "string" ||
    !params.expectedGoalId.trim() ||
    params.expectedGoalId.length > 128
  ) {
    throw new Error("expectedGoalId is required");
  }
  if (
    typeof params.expectedRevision !== "number" ||
    !Number.isSafeInteger(params.expectedRevision) ||
    params.expectedRevision <= 0
  ) {
    throw new Error("expectedRevision must be a positive safe integer");
  }
  return { expectedGoalId: params.expectedGoalId, expectedRevision: params.expectedRevision };
}

/** Keep Mimi's durable task controls on the Session's persisted runtime. */
export function createPetRuntimeControlWorker(options: {
  worker: PetRuntimeControlWorker;
  isExternal(sessionId: string): boolean;
  service(): ControlService | null;
}): PetRuntimeControlWorker {
  return {
    hasLiveWorker(sessionId) {
      if (sessionId && options.isExternal(sessionId)) return options.service() !== null;
      return sessionId === undefined
        ? options.worker.hasLiveWorker()
        : options.worker.hasLiveWorker(sessionId);
    },
    async requestWorker(method, params, timeoutMs, requestOptions) {
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !options.isExternal(sessionId)) {
        return options.worker.requestWorker(method, params, timeoutMs, requestOptions);
      }
      try {
        const service = options.service();
        if (!service) throw new Error("The external runtime control service is unavailable");
        let result: unknown;
        switch (method) {
          case "agent/cancel":
            await service.stop(sessionId);
            result = { cancelled: true };
            break;
          case "agent/goalGet":
            result = await service.getGoal(sessionId);
            break;
          case "agent/goalUpdate": {
            const expected = expectedGoalVersion(params);
            if (params.paused !== undefined && typeof params.paused !== "boolean") {
              throw new Error("paused must be a boolean");
            }
            let objective: string | undefined;
            if (params.objective !== undefined) {
              if (
                typeof params.objective !== "string" ||
                !params.objective.trim() ||
                params.objective.length > 64 * 1024
              ) {
                throw new Error("A non-empty, bounded goal objective is required");
              }
              objective = params.objective.trim();
            }
            if (objective === undefined && params.paused === undefined) {
              throw new Error("Goal update requires an objective or paused state");
            }
            const current = await service.getGoal(sessionId);
            if (
              current.goalId !== expected.expectedGoalId ||
              current.revision !== expected.expectedRevision ||
              (params.paused === false && !service.hasSession(sessionId))
            ) {
              // A cold runtime must be relaunched by the coordinator. Merely
              // unpausing persistence would leave the ledger running without work.
              result = { ...current, updated: false };
              break;
            }
            result = await service.updateGoal(sessionId, {
              ...expected,
              ...(objective !== undefined ? { objective } : {}),
              ...(typeof params.paused === "boolean" ? { paused: params.paused } : {}),
            });
            break;
          }
          case "agent/goalClear": {
            const expected =
              params.expectedGoalId !== undefined || params.expectedRevision !== undefined
                ? expectedGoalVersion(params)
                : {};
            result = await service.deleteGoal(sessionId, expected);
            break;
          }
          default:
            throw new Error(`External runtime task control does not support ${method}`);
        }
        return { ok: true, result };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
