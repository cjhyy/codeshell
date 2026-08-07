import { describe, expect, test } from "bun:test";
import type { CronJobLifecycleEvent } from "@cjhyy/code-shell-core/internal";
import { automationLifecycleNotification } from "./automation-notification.js";

function event(
  type: CronJobLifecycleEvent["type"],
  extra: Partial<CronJobLifecycleEvent> = {},
): CronJobLifecycleEvent {
  return {
    type,
    job: {
      id: "job-1",
      name: "每日检查",
      schedule: "1d",
      prompt: "inspect",
      enabled: true,
      runCount: 1,
      createdAt: 1,
    },
    ...extra,
  };
}

describe("automationLifecycleNotification", () => {
  test("ignores starts and maps every terminal Cron state without platform coupling", () => {
    expect(automationLifecycleNotification(event("job_start"))).toBeUndefined();
    const completed = automationLifecycleNotification(event("job_end", { durationMs: 1_400 }));
    expect(completed).toMatchObject({
      type: "automation.completed",
      title: "自动化任务完成",
      text: "定时任务「每日检查」已完成（用时 1 秒）。可在 CodeShell 中查看完整结果。",
    });
    expect(completed?.deliveryKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      automationLifecycleNotification(event("job_cancelled", { durationMs: 2_600 })),
    ).toMatchObject({
      type: "automation.cancelled",
      title: "自动化任务已取消",
      text: "定时任务「每日检查」已取消（用时 3 秒）。",
    });
    expect(
      automationLifecycleNotification(
        event("job_stopped", {
          durationMs: 800,
          reason: "续接目标会话已删除\u0000，请重新选择",
        }),
      ),
    ).toMatchObject({
      type: "automation.stopped",
      title: "自动化任务已停止",
      text: "定时任务「每日检查」已停止（用时 1 秒）：续接目标会话已删除 ，请重新选择",
    });
    expect(
      automationLifecycleNotification(
        event("job_error", { durationMs: 500, error: "bad\u0000token" }),
      ),
    ).toMatchObject({
      type: "automation.failed",
      title: "自动化任务失败",
      text: "定时任务「每日检查」执行失败（用时 1 秒）：bad token",
    });
    const missed = automationLifecycleNotification(
      event("job_missed", {
        scheduledFor: Date.parse("2026-08-07T01:00:00.000Z"),
        observedAt: Date.parse("2026-08-07T03:00:00.000Z"),
        job: {
          ...event("job_missed").job,
          timezone: "Asia/Shanghai",
          nextRun: Date.parse("2026-08-08T01:00:00.000Z"),
        },
      }),
    );
    expect(missed).toMatchObject({
      type: "automation.missed",
      title: "定时任务已错过",
    });
    expect(missed?.text).toContain("2026/08/07 09:00");
    expect(missed?.text).toContain("本次不会补跑");
    expect(missed?.text).toContain("2026/08/08 09:00");
    expect(automationLifecycleNotification(event("job_end"))?.deliveryKey).toBe(
      completed?.deliveryKey,
    );
    expect(
      automationLifecycleNotification(
        event("job_missed", { scheduledFor: Date.parse("2026-08-07T01:00:00.000Z") }),
      )?.deliveryKey,
    ).not.toBe(
      automationLifecycleNotification(
        event("job_missed", { scheduledFor: Date.parse("2026-08-08T01:00:00.000Z") }),
      )?.deliveryKey,
    );
    expect(
      automationLifecycleNotification(
        event("job_end", { job: { ...event("job_end").job, runCount: 2 } }),
      )?.deliveryKey,
    ).not.toBe(completed?.deliveryKey);
  });
});
