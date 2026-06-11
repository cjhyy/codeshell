// packages/core/src/automation/runner.permission.test.ts
import { describe, test, expect } from "bun:test";
import { bindCronToEngine, type CronRunRequest } from "./runner.js";
import { CronScheduler } from "./scheduler.js";
import { CronStore } from "./store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function schedulerWith(level: "read-only" | "workspace-write" | "full") {
  const store = new CronStore(join(mkdtempSync(join(tmpdir(), "cron-")), "cron.json"));
  const scheduler = new CronScheduler(store);
  scheduler.create("t", "0 0 * * *", "p", { cwd: "/tmp", permissionLevel: level });
  return scheduler;
}

describe("bindCronToEngine — permission tier wiring", () => {
  test("workspace-write job approves a Write tool (not forced read-only)", async () => {
    let captured: CronRunRequest | undefined;
    const scheduler = schedulerWith("workspace-write");
    bindCronToEngine(scheduler, async (req) => { captured = req; return { text: "", reason: "completed" }; });
    await scheduler.runNow(scheduler.list()[0].id);
    const decision = await captured!.approvalBackend.requestApproval({ toolName: "Write" } as never);
    expect(decision.approved).toBe(true);
  });

  test("read-only job denies a Write tool", async () => {
    let captured: CronRunRequest | undefined;
    const scheduler = schedulerWith("read-only");
    bindCronToEngine(scheduler, async (req) => { captured = req; return { text: "", reason: "completed" }; });
    await scheduler.runNow(scheduler.list()[0].id);
    const decision = await captured!.approvalBackend.requestApproval({ toolName: "Write" } as never);
    expect(decision.approved).toBe(false);
  });

  // §5.6 #9: the request must carry the policy's sandboxMode so the host runner
  // can confine the run's writes/shell — previously dropped, leaving sandbox
  // defense unwired.
  test("request carries a sandboxMode + the abort signal for the host runner", async () => {
    let captured: CronRunRequest | undefined;
    const scheduler = schedulerWith("full");
    bindCronToEngine(scheduler, async (req) => { captured = req; return { text: "", reason: "completed" }; });
    await scheduler.runNow(scheduler.list()[0].id);
    expect(captured!.sandboxMode).toBe("auto");
    // §5.6 #11: signal is threaded through so CronScheduler.abort can cancel.
    expect(captured!.signal).toBeInstanceOf(AbortSignal);
  });
});
