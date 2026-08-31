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
  payload: unknown;
}

async function deliver(
  notifier: DesktopNotificationSink | null,
  input: DesktopNotificationInput,
  failureEvent: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await notifier?.notify(input);
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
  const payload = envelope.payload as { status?: unknown; description?: unknown };
  if (
    (payload.status !== "completed" &&
      payload.status !== "failed" &&
      payload.status !== "cancelled") ||
    typeof payload.description !== "string"
  ) {
    return;
  }
  const completed = payload.status === "completed";
  const cancelled = payload.status === "cancelled";
  void deliver(
    notifier,
    {
      key: envelope.id,
      title: completed ? "自动化任务完成" : cancelled ? "自动化任务已取消" : "自动化任务失败",
      body: payload.description,
    },
    "desktop_notification.background_result.failed",
    { envelopeId: envelope.id },
  );
}
