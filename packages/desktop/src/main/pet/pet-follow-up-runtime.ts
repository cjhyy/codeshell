import { createHash } from "node:crypto";
import type { CronScheduler } from "@cjhyy/code-shell-core/internal";
import type { PetRegisteredFollowUp } from "@cjhyy/code-shell-pet";
import type { GatewayControlEventInput } from "../im-gateway-control-server.js";
import type { DesktopNotificationInput, DesktopNotificationOutcome } from "../desktop-notifier.js";
import type { PetDispatchService } from "./pet-dispatch-service.js";
import { createPetFollowUpHost } from "./pet-follow-up-host.js";
import { createPetFollowUpService, type PetFollowUpInbox } from "./pet-follow-up-service.js";
import { PetFollowUpWakeCoordinator } from "./pet-follow-up-wake-coordinator.js";
import type { PetLongTaskCoordinator } from "./pet-long-task-coordinator.js";
import type { PetLongTaskStore } from "./pet-long-task-store.js";
import { PetRegisteredFollowUpStore } from "./pet-registered-follow-up-store.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";
import type { PetSummaryService } from "./pet-summary-service.js";
import type { PetSummaryStore } from "./pet-summary-store.js";

/** Owns follow-up composition; Desktop supplies lifecycle, routing and execution authority. */
export async function createPetFollowUpRuntime(deps: {
  filePath: string;
  sessions(): readonly DesktopPetSession[];
  summaryStore: PetSummaryStore;
  summaryService: PetSummaryService;
  inbox: PetFollowUpInbox;
  tasks: PetLongTaskStore;
  longTasks: Pick<PetLongTaskCoordinator, "control">;
  scheduler(): CronScheduler;
  publish(event: GatewayControlEventInput): Promise<void>;
  notify(input: DesktopNotificationInput): Promise<DesktopNotificationOutcome | undefined>;
  dispatch(): Pick<PetDispatchService, "wakeFollowUp"> | null;
  onError(error: unknown): void;
}) {
  const registeredFollowUps = new PetRegisteredFollowUpStore(deps.filePath);
  const petFollowUps = createPetFollowUpService({
    listSessions: deps.sessions,
    summaryStore: deps.summaryStore,
    summaryService: deps.summaryService,
    inbox: deps.inbox,
    registered: registeredFollowUps,
  });
  const followUpHost = createPetFollowUpHost({
    store: registeredFollowUps,
    service: petFollowUps,
    tasks: deps.tasks,
    sessions: deps.sessions,
  });
  const coordinator = new PetFollowUpWakeCoordinator({
    store: registeredFollowUps,
    scheduler: deps.scheduler,
    notify: async (item, text, key) => {
      const deliveryKey = createHash("sha256").update(key).digest("hex");
      if (item.completionTarget) {
        await deps.publish({
          deliveryKey,
          type: "pet.task.reported",
          title: item.title,
          text,
          target: {
            channel: item.completionTarget.channel,
            target: item.completionTarget.target,
          },
        });
      }
      const outcome = await deps.notify({ key: deliveryKey, title: item.title, body: text });
      if (!item.completionTarget && outcome === "failed")
        throw new Error("桌面提醒未能显示，请在需要跟进中查看");
    },
    resume: async (item) => {
      const source = deps.sessions().find((row) => row.agentSessionId === item.sourceSessionId);
      if (!source || source.external)
        return {
          launched: false,
          text: "原任务已不存在或不受当前 Host 支持，未启动新的任务。请重新选择。",
        };
      if (source.pendingDecisionCount > 0)
        return { launched: false, text: "原任务正在等待你的决定，已保留跟进，未绕过审批。" };
      if (source.runState === "running" || source.runState === "queued")
        return { launched: false, text: "原任务已在运行，未重复启动。" };
      if (item.taskId) {
        const task = deps.tasks.get(item.taskId);
        if (!task || task.sessionId !== item.sourceSessionId)
          return { launched: false, text: "跟进关联的原任务已变化，请核对后再续办。" };
        if (task.status === "paused" || task.status === "interrupted") {
          const result = await deps.longTasks.control({ action: "resume", taskId: task.id });
          if (!result.ok) return { launched: false, text: `未能续办原任务：${result.message}` };
          return {
            launched: true,
            text: "已续办原任务，完成后会报告实际结果。",
            taskId: task.id,
          };
        }
        if (task.status === "waiting")
          return {
            launched: false,
            text: task.waitingFor ?? "原任务仍在等待外部结果或你的决定，未重复启动。",
          };
        if (task.status === "cancelled")
          return { launched: false, text: "原任务已取消，未自动重启。" };
      }
      const dispatch = deps.dispatch();
      if (!dispatch) throw new Error("Mimi dispatch service is unavailable");
      return dispatch.wakeFollowUp(item);
    },
    onError: deps.onError,
  });
  await coordinator.prepare();
  return {
    registeredFollowUps,
    petFollowUps,
    followUpHost,
    coordinator,
    validateContinuation(item: PetRegisteredFollowUp): void {
      const current = registeredFollowUps.get(item.id);
      if (
        !current ||
        current.revision !== item.revision ||
        current.status !== "open" ||
        current.wake.status !== "claimed"
      )
        throw new Error("跟进授权已变化，未自动续办");
      if (item.taskId) {
        const task = deps.tasks.get(item.taskId);
        if (
          !task ||
          task.sessionId !== item.sourceSessionId ||
          ["cancelled", "waiting", "running", "queued"].includes(task.status)
        )
          throw new Error("原任务已取消、正在运行或等待决定，未自动续办");
      }
    },
  };
}
