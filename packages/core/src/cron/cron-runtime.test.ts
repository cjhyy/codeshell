import { describe, test, expect } from "bun:test";
import { CronScheduler, type CronJob } from "./scheduler.js";
import { bindCronToEngine, type CronRunRequest } from "./cron-runtime.js";
import { HeadlessApprovalBackend } from "../tool-system/permission.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("bindCronToEngine", () => {
  test("registers an executor on the scheduler", () => {
    const sched = new CronScheduler();
    let registered = false;
    // Spy: setExecutor should be called exactly once during binding.
    const orig = sched.setExecutor.bind(sched);
    sched.setExecutor = (fn) => {
      registered = true;
      orig(fn);
    };
    bindCronToEngine(sched, async () => ({ text: "", reason: "completed" }));
    expect(registered).toBe(true);
  });

  test("a triggered job runs with the job prompt and a read-only backend", async () => {
    const sched = new CronScheduler();
    const calls: CronRunRequest[] = [];
    bindCronToEngine(sched, async (req) => {
      calls.push(req);
      return { text: "ok", reason: "completed" };
    });

    const job = sched.create("nightly", "20", "summarize the repo"); // 20ms
    await sleep(60);
    sched.delete(job.id);
    await sleep(10);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const first = calls[0];
    expect(first.prompt).toBe("summarize the repo");
    expect(first.job.name).toBe("nightly");
    // Contract from the plan: cron runs read-only until the sandbox lands.
    // It must use permissionMode "default" (NOT a non-existent
    // "approve-read-only" mode) plus an explicit read-only approval backend,
    // so the classifier's acceptEdits Write/Edit auto-allow rules are never added.
    expect(first.permissionMode).toBe("default");
    expect(first.approvalBackend).toBeInstanceOf(HeadlessApprovalBackend);
  });

  test("the read-only backend denies writes and approves reads", async () => {
    const sched = new CronScheduler();
    let backend: HeadlessApprovalBackend | undefined;
    bindCronToEngine(sched, async (req) => {
      backend = req.approvalBackend as HeadlessApprovalBackend;
      return { text: "", reason: "completed" };
    });
    const job = sched.create("x", "20", "p");
    await sleep(40);
    sched.delete(job.id);
    await sleep(10);

    expect(backend).toBeDefined();
    const read = await backend!.requestApproval({
      toolName: "Read",
      args: {},
      description: "",
      riskLevel: "low",
    });
    const write = await backend!.requestApproval({
      toolName: "Write",
      args: {},
      description: "",
      riskLevel: "medium",
    });
    expect(read.approved).toBe(true);
    expect(write.approved).toBe(false);
  });

  test("a runner that throws does not break the scheduler's tick loop", async () => {
    const sched = new CronScheduler();
    let count = 0;
    bindCronToEngine(sched, async () => {
      count++;
      throw new Error("boom");
    });
    const job = sched.create("flaky", "20", "p");
    await sleep(80);
    sched.delete(job.id);
    await sleep(10);
    // It kept ticking despite the runner throwing each time.
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// Type-only sanity: a CronJob is what the runner receives.
const _typecheck = (j: CronJob): string => j.prompt;
void _typecheck;
