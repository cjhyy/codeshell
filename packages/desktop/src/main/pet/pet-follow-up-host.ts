import { createHash } from "node:crypto";
import { isPetFollowUpMutationPayload } from "@cjhyy/code-shell-pet";
import type { PetHostActionContext } from "./pet-dispatch-service.js";
import type { PetFollowUpService } from "./pet-follow-up-service.js";
import type { PetRegisteredFollowUpStore } from "./pet-registered-follow-up-store.js";
import type { PetLongTaskStore } from "./pet-long-task-store.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";

/** Slot identity is host-authored; model-provided titles never identify an operation. */
export function petFollowUpOperationKey(context: PetHostActionContext): string {
  return `followup-registration:${createHash("sha256")
    .update(
      JSON.stringify([
        context.originClientMessageId,
        context.actionIndex ?? 0,
        context.completionTarget?.channel ?? "desktop",
        context.completionTarget?.target ?? null,
        context.senderId ?? context.completionTarget?.senderId ?? null,
      ]),
    )
    .digest("hex")}`;
}

export function createPetFollowUpHost(deps: {
  store: PetRegisteredFollowUpStore;
  service: PetFollowUpService;
  tasks: PetLongTaskStore;
  sessions(): readonly DesktopPetSession[];
}) {
  return async (
    payload: Record<string, unknown>,
    context?: PetHostActionContext,
  ): Promise<Record<string, unknown>> => {
    if (!isPetFollowUpMutationPayload(payload)) throw new Error("invalid follow-up request");
    if (payload.action === "register") {
      if (!context)
        throw new Error("follow-up registration requires an authenticated current turn");
      await deps.store.load();
      const operationKey = petFollowUpOperationKey(context);
      const existing = deps.store.findByOperationKey(operationKey);
      // A replay must resolve the original operation even after its task disappeared.
      let taskId = existing?.taskId ?? payload.taskId;
      if (!existing && payload.intent === "resume") {
        const source = deps
          .sessions()
          .find((row) => row.agentSessionId === payload.sourceSessionId);
        if (!source || source.external)
          throw new Error("续办来源已不存在或不受当前 Host 支持，请重新选择原任务");
        const task = taskId
          ? deps.tasks.get(taskId)
          : deps.tasks
              .getSnapshot()
              .tasks.find(
                (row) =>
                  row.sessionId === payload.sourceSessionId &&
                  !["completed", "failed", "cancelled"].includes(row.status),
              );
        if (taskId && (!task || task.sessionId !== payload.sourceSessionId))
          throw new Error("续办任务与来源 Session 不匹配");
        taskId = task?.id;
      }
      const { action: _action, ...definition } = payload;
      const row = await deps.store.register({
        ...definition,
        operationKey,
        ...(taskId ? { taskId } : {}),
        ...(context.completionTarget ? { completionTarget: context.completionTarget } : {}),
      });
      return {
        action: "register",
        followUpId: row.id,
        title: row.title,
        revision: row.revision,
        wakeAt: row.wakeAt,
        timezone: row.timezone,
        intent: row.intent,
        status: row.status,
        wakeState: row.wake.status,
      };
    }
    if (payload.action === "reschedule") {
      const row = await deps.store.reschedule(payload.followUpId, payload.expectedRevision, {
        wakeAt: payload.wakeAt,
        timezone: payload.timezone,
        ...(payload.missedPolicy ? { missedPolicy: payload.missedPolicy } : {}),
        ...(payload.catchUpUntil !== undefined ? { catchUpUntil: payload.catchUpUntil } : {}),
      });
      return {
        action: payload.action,
        followUpId: row.id,
        title: row.title,
        revision: row.revision,
        wakeAt: row.wakeAt,
        timezone: row.timezone,
        wakeState: row.wake.status,
      };
    }
    if (payload.action === "cancel") {
      const row = await deps.store.cancel(payload.followUpId, payload.expectedRevision);
      return {
        action: payload.action,
        followUpId: row.id,
        title: row.title,
        revision: row.revision,
        status: row.status,
      };
    }
    return { ...(await deps.service.mutate(payload)) };
  };
}
