import { describe, expect, test } from "bun:test";
import {
  bindCronToEngine,
  CronScheduler,
  type CronJobLifecycleEvent,
} from "@cjhyy/code-shell-core/internal";
import { ErrorCodes } from "@cjhyy/code-shell-core";
import { makeCronRunnerWithResume } from "./automation-host.js";
import { automationLifecycleNotification } from "./automation-notification.js";
import {
  createAutomationResumeTurn,
  type AutomationResumeBridge,
} from "./automation-resume-turn.js";

type Outcome = Awaited<ReturnType<AutomationResumeBridge["requestWorker"]>>;
type Call = { method: string; params: Record<string, unknown>; options: Record<string, unknown> };

function fakeBridge(answer: (call: Call) => Promise<Outcome>) {
  const calls: Call[] = [];
  const bridge: AutomationResumeBridge = {
    requestWorker: (method, params, _timeoutMs, options) => {
      const call = { method, params, options: options as Record<string, unknown> };
      calls.push(call);
      return answer(call);
    },
  };
  return { bridge, calls };
}

function setup(bridge: AutomationResumeBridge) {
  const scheduler = new CronScheduler();
  scheduler.setExecutionEnabled(false);
  const events: CronJobLifecycleEvent[] = [];
  scheduler.setJobEventListener((event) => events.push(event));
  const missing: unknown[] = [];
  bindCronToEngine(
    scheduler,
    makeCronRunnerWithResume(
      async () => {
        throw new Error("a resume job must not run headless");
      },
      createAutomationResumeTurn({
        bridge: () => bridge,
        notifyMissingTarget: async (job) => {
          missing.push(job);
        },
      }),
      async () => ({ ok: true, authority: { cwd: "/fixture", projectId: "p", rootId: "r" } }),
    ),
  );
  const job = scheduler.create("续接任务", "1h", "check the build", {
    cwd: "/fixture",
    projectId: "p",
    rootId: "r",
    resumeSessionId: "s-bound",
  });
  return { scheduler, events, job, missing };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("automation resume turn", () => {
  test("a worker rejection is reported as a failure, not a completion", async () => {
    const { bridge } = fakeBridge(async () => ({
      ok: false,
      code: -32603,
      message: "worker failed to initialize model",
    }));
    const { scheduler, events, job } = setup(bridge);
    expect(scheduler.runNow(job.id)).toBe(true);
    await tick();
    expect(events.map((event) => event.type)).toEqual(["job_start", "job_error"]);
    const notification = automationLifecycleNotification(events[1]!);
    expect(notification?.type).toBe("automation.failed");
    expect(notification?.text).toContain("worker failed to initialize model");
    scheduler.stopAll();
  });

  test("a long accepted turn keeps the job running so it cannot be queued again", async () => {
    let finish!: (outcome: Outcome) => void;
    const { bridge, calls } = fakeBridge(
      (call) =>
        new Promise<Outcome>((resolve) => {
          if (call.method === "agent/run") finish = resolve;
        }),
    );
    const { scheduler, events, job } = setup(bridge);
    expect(scheduler.runNow(job.id)).toBe(true);
    await tick();
    // The request tracks the turn to completion, not a fixed round budget.
    expect(calls[0]?.options).toMatchObject({
      waitForRunCompletion: true,
      failFast: true,
      settleOnExit: true,
    });
    expect(calls[0]?.params).toMatchObject({ sessionId: "s-bound", requireExisting: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.map((event) => event.type)).toEqual(["job_start"]);
    scheduler.runNow(job.id);
    await tick();
    expect(calls.filter((call) => call.method === "agent/run")).toHaveLength(1);
    expect(job.runCount).toBe(1);
    finish({ ok: true, result: { text: "done", reason: "completed" } });
    await tick();
    expect(events.map((event) => event.type)).toEqual(["job_start", "job_end"]);
    scheduler.stopAll();
  });

  test("a worker that exits mid-turn fails the run", async () => {
    const { bridge } = fakeBridge(async () => ({
      ok: false,
      message: "the agent worker exited before responding",
    }));
    const { scheduler, events, job } = setup(bridge);
    scheduler.runNow(job.id);
    await tick();
    expect(events.map((event) => event.type)).toEqual(["job_start", "job_error"]);
    scheduler.stopAll();
  });

  test("a deleted bound conversation stops the job", async () => {
    const { bridge } = fakeBridge(async () => ({
      ok: false,
      code: ErrorCodes.SessionNotFound,
      message: "session not found",
    }));
    const { scheduler, events, job, missing } = setup(bridge);
    scheduler.runNow(job.id);
    await tick();
    expect(events.map((event) => event.type)).toEqual(["job_start", "job_stopped"]);
    expect(missing).toHaveLength(1);
    expect(scheduler.get(job.id)?.enabled).toBe(false);
    scheduler.stopAll();
  });

  test("aborting the scheduler run cancels the injected turn", async () => {
    let finish!: (outcome: Outcome) => void;
    const { bridge, calls } = fakeBridge((call) => {
      if (call.method === "agent/cancel") {
        finish({ ok: true, result: { text: "", reason: "aborted_streaming" } });
        return Promise.resolve({ ok: true, result: { cancelled: true } });
      }
      return new Promise<Outcome>((resolve) => {
        finish = resolve;
      });
    });
    const { scheduler, events, job } = setup(bridge);
    scheduler.runNow(job.id);
    await tick();
    expect(await scheduler.abort(job.id)).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["agent/run", "agent/cancel"]);
    expect(calls[1]?.params).toEqual({ sessionId: "s-bound" });
    expect(events.map((event) => event.type)).toEqual(["job_start", "job_cancelled"]);
    scheduler.stopAll();
  });
});
