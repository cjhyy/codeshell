import type { CronJobLifecycleEvent } from "@cjhyy/code-shell-core/internal";
import { createHash } from "node:crypto";
import type { GatewayControlEventInput } from "./im-gateway-control-server.js";

const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/**
 * Translate the environment-neutral Cron lifecycle into the same channel-neutral
 * event contract used by Mimi tasks and tunnel notifications. Delivery policy
 * (live watcher versus direct adapter) remains owned by ImGatewayService.
 */
export function automationLifecycleNotification(
  event: CronJobLifecycleEvent,
): GatewayControlEventInput | undefined {
  if (event.type === "job_start") return undefined;
  const deliveryKey = createHash("sha256")
    .update("automation-lifecycle\0")
    .update(event.job.id)
    .update("\0")
    .update(String(event.job.runCount))
    .update("\0")
    .update(event.type)
    .update("\0")
    .update(String(event.scheduledFor ?? ""))
    .digest("hex");
  const name = clean(event.job.name, 120) || event.job.id;
  const duration = formatDuration(event.durationMs);
  if (event.type === "job_missed") {
    const scheduledFor = formatScheduledTime(event.scheduledFor, event.job.timezone);
    const nextRun = formatScheduledTime(event.job.nextRun, event.job.timezone);
    return {
      deliveryKey,
      type: "automation.missed",
      title: "定时任务已错过",
      text: `定时任务「${name}」${scheduledFor ? `错过了 ${scheduledFor} 的执行时间` : "错过了本次执行时间"}，本次不会补跑${nextRun ? `；下次执行时间为 ${nextRun}` : ""}。设备当时可能处于休眠，或 CodeShell 未在运行。`,
    };
  }
  if (event.type === "job_cancelled") {
    return {
      deliveryKey,
      type: "automation.cancelled",
      title: "自动化任务已取消",
      text: `定时任务「${name}」已取消${duration}。`,
    };
  }
  if (event.type === "job_stopped") {
    const reason = clean(event.reason ?? "任务已自动停用", 2_000) || "任务已自动停用";
    return {
      deliveryKey,
      type: "automation.stopped",
      title: "自动化任务已停止",
      text: `定时任务「${name}」已停止${duration}：${reason}`,
    };
  }
  if (event.type === "job_error") {
    const error = clean(event.error ?? "未知错误", 2_000) || "未知错误";
    return {
      deliveryKey,
      type: "automation.failed",
      title: "自动化任务失败",
      text: `定时任务「${name}」执行失败${duration}：${error}`,
    };
  }
  return {
    deliveryKey,
    type: "automation.completed",
    title: "自动化任务完成",
    text: `定时任务「${name}」已完成${duration}。可在 CodeShell 中查看完整结果。`,
  };
}

function clean(value: string, maximum: number): string {
  return Array.from(value.replace(CONTROL_CHARACTER_RE, " ").replace(/\s+/gu, " ").trim())
    .slice(0, maximum)
    .join("");
}

function formatDuration(durationMs: number | undefined): string {
  if (!Number.isFinite(durationMs) || (durationMs ?? -1) < 0) return "";
  const seconds = Math.max(0, Math.round((durationMs ?? 0) / 1_000));
  return `（用时 ${seconds} 秒）`;
}

function formatScheduledTime(value: number | undefined, timezone: string | undefined): string {
  if (!Number.isFinite(value)) return "";
  try {
    return new Date(value as number).toLocaleString("zh-CN", {
      ...(timezone ? { timeZone: timezone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(value as number).toLocaleString("zh-CN", { hour12: false });
  }
}
