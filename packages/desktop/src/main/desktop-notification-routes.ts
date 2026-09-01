import { createHash } from "node:crypto";
import type { CronJob, CronJobLifecycleEvent } from "@cjhyy/code-shell-core/internal";

import { automationLifecycleNotification } from "./automation-notification.js";
import { dlog } from "./desktop-logger.js";
import type { DesktopNotificationInput, DesktopNotificationOutcome } from "./desktop-notifier.js";
import type { GatewayControlEventInput } from "./im-gateway-control-server.js";

export interface DesktopNotificationSink {
  notify(input: DesktopNotificationInput): Promise<DesktopNotificationOutcome>;
}

interface BackgroundResultEnvelope {
  kind: string;
  id: string;
  from?: { sessionId?: unknown };
  to?: { sessionId?: unknown };
  payload: unknown;
}

async function deliver(
  notifier: DesktopNotificationSink | null,
  input: DesktopNotificationInput,
  failureEvent: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const outcome = await notifier?.notify(input);
    if (outcome === "failed") dlog("main", failureEvent, { ...details, outcome });
  } catch (error) {
    dlog("main", failureEvent, { ...details, error: String(error) });
  }
}

export function notifyPetTaskClosure(
  notifier: DesktopNotificationSink | null,
  input: { deliveryKey: string; title: string; message: string; taskId: string },
): Promise<void> {
  return deliver(
    notifier,
    { key: input.deliveryKey, title: input.title, body: input.message },
    "desktop_notification.pet_closure.failed",
    { taskId: input.taskId },
  );
}

export function notifyMissingAutomationResumeTarget(
  notifier: DesktopNotificationSink | null,
  job: CronJob | undefined,
): Promise<void> {
  const notification = job
    ? automationLifecycleNotification({
        type: "job_stopped",
        job,
        reason: "续接的对话已被删除,已停止该定时任务",
      })
    : undefined;
  if (!notification?.deliveryKey) return Promise.resolve();
  return deliver(
    notifier,
    {
      key: notification.deliveryKey,
      title: "定时任务已停止",
      body: "续接的对话已被删除,该定时任务已自动停用。可在自动化面板查看或删除。",
      urgent: true,
    },
    "desktop_notification.automation_stopped.failed",
    { jobId: job?.id },
  );
}

export function notifyMissedAutomation(
  notifier: DesktopNotificationSink | null,
  notification: GatewayControlEventInput,
  event: CronJobLifecycleEvent,
): void {
  if (event.type !== "job_missed" || !notification.deliveryKey) return;
  void deliver(
    notifier,
    {
      key: notification.deliveryKey,
      title: notification.title ?? "定时任务已错过",
      body: notification.text,
      urgent: true,
    },
    "desktop_notification.automation_missed.failed",
    { jobId: event.job.id },
  );
}

export function notifyBackgroundResult(
  notifier: DesktopNotificationSink | null,
  envelope: BackgroundResultEnvelope,
): void {
  if (envelope.kind !== "result") return;
  if (!envelope.payload || typeof envelope.payload !== "object") return;
  const payload = envelope.payload as {
    workId?: unknown;
    workKind?: unknown;
    status?: unknown;
    description?: unknown;
    finishedAt?: unknown;
  };
  if (
    (payload.status !== "completed" &&
      payload.status !== "failed" &&
      payload.status !== "cancelled") ||
    typeof payload.description !== "string" ||
    typeof payload.workId !== "string" ||
    typeof payload.workKind !== "string" ||
    typeof payload.finishedAt !== "number" ||
    !Number.isFinite(payload.finishedAt) ||
    typeof envelope.from?.sessionId !== "string" ||
    typeof envelope.to?.sessionId !== "string"
  ) {
    return;
  }
  const completed = payload.status === "completed";
  const cancelled = payload.status === "cancelled";
  const deliveryKey = createHash("sha256")
    .update("background-result\0")
    .update(envelope.from.sessionId)
    .update("\0")
    .update(envelope.to.sessionId)
    .update("\0")
    .update(payload.workKind)
    .update("\0")
    .update(payload.workId)
    .update("\0")
    .update(payload.status)
    .update("\0")
    .update(String(payload.finishedAt))
    .digest("hex");
  void deliver(
    notifier,
    {
      key: deliveryKey,
      title: completed ? "自动化任务完成" : cancelled ? "自动化任务已取消" : "自动化任务失败",
      body: payload.description,
    },
    "desktop_notification.background_result.failed",
    { envelopeId: envelope.id, deliveryKey },
  );
}
