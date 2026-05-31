import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAutomation } from "./index.js";
import { CronStore } from "./store.js";
import type { CronRunRequest } from "./runner.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "start-automation-"));
  file = join(dir, "cron.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("startAutomation", () => {
  test("returns a handle with a scheduler and stop()", () => {
    const store = new CronStore(file);
    const handle = startAutomation({ store, runner: async () => ({ text: "", reason: "completed" }) });
    expect(typeof handle.stop).toBe("function");
    expect(handle.scheduler).toBeDefined();
    handle.stop();
  });

  test("a created job fires the injected runner with the read-only contract", async () => {
    const store = new CronStore(file);
    const calls: CronRunRequest[] = [];
    const handle = startAutomation({
      store,
      runner: async (req) => {
        calls.push(req);
        return { text: "ok", reason: "completed" };
      },
    });
    handle.scheduler.create("nightly", "20", "summarize repo"); // 20ms interval
    await sleep(60);
    handle.stop();
    await sleep(10);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].prompt).toBe("summarize repo");
    expect(calls[0].permissionMode).toBe("default");
  });

  test("loads persisted jobs on start (restart survival)", () => {
    // First lifetime: persist a job, then stop.
    const a = startAutomation({ store: new CronStore(file), runner: async () => ({ text: "", reason: "completed" }) });
    const job = a.scheduler.create("persisted", "1h", "p");
    a.stop();
    // Second lifetime: a fresh facade over the same store restores it.
    const b = startAutomation({ store: new CronStore(file), runner: async () => ({ text: "", reason: "completed" }) });
    expect(b.scheduler.get(job.id)?.name).toBe("persisted");
    b.stop();
  });

  test("stop() halts all timers (no further runner calls)", async () => {
    const store = new CronStore(file);
    let count = 0;
    const handle = startAutomation({ store, runner: async () => { count++; return { text: "", reason: "completed" }; } });
    handle.scheduler.create("x", "20", "p");
    await sleep(50);
    handle.stop();
    const after = count;
    await sleep(60);
    expect(count).toBe(after); // no ticks after stop()
  });
});
