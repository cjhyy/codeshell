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

function notifyResult(
  sink: DesktopNotificationSink,
  payload: Record<string, unknown>,
  sessionId = "owner",
): void {
  notifyBackgroundResult(sink, {
    kind: "result",
    id: "result-1",
    from: { sessionId: "worker" },
    to: { sessionId },
    payload: {
      workId: "work-1",
      workKind: "shell",
      status: "failed",
      description: "Raw agent-facing description should not appear",
      finishedAt: 100,
      ...payload,
    },
  });
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
        name: "整理学习笔记",
        description: "stopped",
        finishedAt: 100,
      },
    });
    await Promise.resolve();
    expect(calls).toEqual([
      {
        key: expect.stringMatching(/^[a-f0-9]{64}$/),
        title: "后台任务已取消",
        body: "整理学习笔记 · 任务已取消",
        sessionId: "parent",
      },
    ]);
  });

  it("identifies signal termination without claiming deliberate cancellation", async () => {
    const { sink, calls } = fixture();
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      notifyResult(sink, {
        command: "/usr/bin/node /project/server.js --token secret-value",
        signal,
        error: `Background shell work-1 exited with signal ${signal}. Use BashOutput("work-1") to inspect.`,
      });
    }
    await Promise.resolve();
    expect(calls.map((call) => call.title)).toEqual(["后台命令已终止", "后台命令已终止"]);
    expect(calls[0]?.body).toBe("node server.js · 收到 SIGTERM 信号，进程已终止");
    expect(calls[1]?.body).toBe("node server.js · 收到 SIGKILL 信号，进程已终止");
    expect(calls.every((call) => !/取消|主动|重启/u.test(call.body))).toBe(true);
  });

  it("includes a nonzero exit code and useful redacted error details", async () => {
    const { sink, calls } = fixture();
    notifyResult(sink, {
      command: "node server.js",
      exitCode: 2,
      error: "listen EADDRINUSE; api_key=private-value",
    });
    await Promise.resolve();
    expect(calls[0]).toEqual({
      key: expect.any(String),
      title: "后台命令失败",
      body: "node server.js · 退出码 2 · listen EADDRINUSE; api_key=[REDACTED]",
      sessionId: "owner",
    });
  });

  it("distinguishes the background work kinds and uses their names", async () => {
    const { sink, calls } = fixture();
    for (const workKind of ["agent", "video", "cc"]) {
      notifyResult(sink, { workKind, name: "整理学习笔记", status: "completed" });
    }
    await Promise.resolve();
    expect(calls.map((call) => call.title)).toEqual([
      "后台任务完成",
      "视频任务完成",
      "外部代理任务完成",
    ]);
    expect(calls.every((call) => call.body === "整理学习笔记 · 点击查看结果")).toBe(true);
  });

  it("keeps shell identities useful without exposing command arguments", async () => {
    const { sink, calls } = fixture();
    for (const command of [
      "TOKEN='private environment value' /usr/bin/node '/Users/me/private path/server.js' --token private-token",
      "env PASSWORD=private-password python3 /tmp/worker.py --password private-argument",
      "curl -u user:private-password https://user:private-url-password@example.com",
      "python3 -c 'print(\"private code\")'",
      "bun run study-server --token private-token",
    ]) {
      notifyResult(sink, { command, exitCode: 1 });
    }
    await Promise.resolve();
    expect(calls.map((call) => call.body)).toEqual([
      "node server.js · 退出码 1",
      "python3 worker.py · 退出码 1",
      "curl · 退出码 1",
      "python3 · 退出码 1",
      "bun run study-server · 退出码 1",
    ]);
    expect(calls.every((call) => !call.body.includes("private"))).toBe(true);
  });

  it("identifies a server launched after a simple directory change", async () => {
    const { sink, calls } = fixture();
    notifyResult(sink, {
      command:
        "cd '/Users/admin/Documents/个人学习/代码学习/my-mini-gpt' && /opt/homebrew/bin/python3 learning_server.py --host 127.0.0.1 --port 8123",
      signal: "SIGTERM",
    });
    await Promise.resolve();
    expect(calls[0]?.body).toBe("python3 learning_server.py · 收到 SIGTERM 信号，进程已终止");
    expect(calls[0]?.body).not.toContain("my-mini-gpt");
    expect(calls[0]?.body).not.toContain("127.0.0.1");
  });

  it("bounds names and errors while keeping the failure cause visible", async () => {
    const { sink, calls } = fixture();
    notifyResult(sink, {
      workKind: "agent",
      name: "学习".repeat(100),
      error: "错误".repeat(200),
      exitCode: 1,
    });
    await Promise.resolve();
    expect(Array.from(calls[0]!.body).length).toBeLessThanOrEqual(180);
    expect(calls[0]!.body).toContain("退出码 1");
    expect(calls[0]!.body).toContain("…");
  });

  it("redacts quoted secrets and command text embedded in errors", async () => {
    const { sink, calls } = fixture();
    const command = "node server.js --unknown-private-option private-value";
    notifyResult(sink, {
      command,
      exitCode: 2,
      error: `Failed: ${command}; password="private words"; --token 'private token'`,
    });
    await Promise.resolve();
    expect(calls[0]?.body).toBe(
      "node server.js · 退出码 2 · Failed: node server.js; password=[REDACTED] --token [REDACTED]",
    );
    expect(calls[0]?.body).not.toContain("private");
  });

  it("does not infer a signal from legacy English descriptions", async () => {
    const { sink, calls } = fixture();
    notifyResult(sink, {
      command: "node server.js",
      description: "Background shell exited (signal SIGTERM): node server.js",
    });
    await Promise.resolve();
    expect(calls[0]?.title).toBe("后台命令失败");
    expect(calls[0]?.body).toBe("node server.js · 执行失败，点击查看详情");
  });

  it("does not forward unsafe conversation targets", async () => {
    const { sink, calls } = fixture();
    for (const sessionId of ["../other", "s/other", "s\nother", "x".repeat(257)]) {
      notifyResult(sink, { command: "node server.js", exitCode: 1 }, sessionId);
    }
    await Promise.resolve();
    expect(calls).toEqual([]);
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
      payload: { ...payload, name: "updated label", error: "updated details", exitCode: 1 },
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
