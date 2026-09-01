import { describe, expect, it } from "bun:test";
import type { CronJob, CronJobLifecycleEvent } from "@cjhyy/code-shell-core/internal";

import {
  notifyBackgroundResult,
  notifyMissingAutomationResumeTarget,
  notifyMissedAutomation,
  notifyPetTaskClosure,
  type DesktopNotificationSink,
} from "./desktop-notification-routes.js";
import type { DesktopNotificationInput } from "./desktop-notifier.js";

function fixture(): { sink: DesktopNotificationSink; calls: DesktopNotificationInput[] } {
  const calls: DesktopNotificationInput[] = [];
  return {
    calls,
    sink: {
      async notify(input) {
        calls.push(input);
        return "shown";
      },
    },
  };
}

function cronJob(): CronJob {
  return {
    id: "cron-1",
    name: "Review roadmap",
    runCount: 2,
  } as CronJob;
}

describe("desktop notification routes", () => {
  it("routes a Mimi closure with its durable delivery key", async () => {
    const { sink, calls } = fixture();
    await notifyPetTaskClosure(sink, {
      deliveryKey: "closure-1",
      title: "done",
      message: "result",
      taskId: "task-1",
    });
    expect(calls).toEqual([{ key: "closure-1", title: "done", body: "result" }]);
  });

  it("marks a missing automation resume target urgent", async () => {
    const { sink, calls } = fixture();
    await notifyMissingAutomationResumeTarget(sink, cronJob());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.urgent).toBe(true);
    expect(calls[0]?.key).toHaveLength(64);
  });

  it("only turns missed lifecycle events into urgent desktop notices", async () => {
    const { sink, calls } = fixture();
    const job = cronJob();
    const event = { type: "job_missed", job } as CronJobLifecycleEvent;
    notifyMissedAutomation(
      sink,
      { deliveryKey: "missed-1", type: "automation.missed", text: "missed" },
      event,
    );
    await Promise.resolve();
    expect(calls).toEqual([
      { key: "missed-1", title: "定时任务已错过", body: "missed", urgent: true },
    ]);
  });

  it("maps background terminal status without notifying progress", async () => {
    const { sink, calls } = fixture();
    notifyBackgroundResult(sink, {
      kind: "progress",
      id: "progress-1",
      from: { sessionId: "child" },
      to: { sessionId: "parent" },
      payload: {
        workId: "work-1",
        workKind: "agent",
        status: "completed",
        description: "ignored",
        finishedAt: 100,
      },
    });
    notifyBackgroundResult(sink, {
      kind: "result",
      id: "result-1",
      from: { sessionId: "child" },
      to: { sessionId: "parent" },
      payload: {
        workId: "work-1",
        workKind: "agent",
        status: "cancelled",
        description: "stopped",
        finishedAt: 100,
      },
    });
    await Promise.resolve();
    expect(calls).toEqual([
      { key: expect.stringMatching(/^[a-f0-9]{64}$/), title: "自动化任务已取消", body: "stopped" },
    ]);
  });

  it("uses one semantic receipt key across duplicate envelope ids", async () => {
    const { sink, calls } = fixture();
    const payload = {
      workId: "work-stable",
      workKind: "shell",
      status: "completed",
      description: "done",
      finishedAt: 123,
    };
    notifyBackgroundResult(sink, {
      kind: "result",
      id: "first-envelope",
      from: { sessionId: "worker" },
      to: { sessionId: "owner" },
      payload,
    });
    notifyBackgroundResult(sink, {
      kind: "result",
      id: "replayed-envelope",
      from: { sessionId: "worker" },
      to: { sessionId: "owner" },
      payload,
    });
    await Promise.resolve();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBe(calls[1]?.key);
  });
});
