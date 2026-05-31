import { describe, test, expect, beforeEach } from "bun:test";
import { CronScheduler } from "@cjhyy/code-shell-core";
import {
  setAutomationScheduler,
  listAutomations,
  getAutomation,
  createAutomation,
  deleteAutomation,
  pauseAutomation,
  resumeAutomation,
} from "./automation-service.js";

let sched: CronScheduler;

beforeEach(() => {
  sched = new CronScheduler();
  setAutomationScheduler(sched);
});

describe("automation-service", () => {
  test("listAutomations returns [] when no scheduler is set", () => {
    setAutomationScheduler(null);
    expect(listAutomations()).toEqual([]);
  });

  test("create then list returns a serializable summary", () => {
    const created = createAutomation({
      name: "nightly",
      schedule: "0 9 * * 1-5",
      prompt: "review",
      cwd: "/tmp/proj",
      timezone: "Asia/Shanghai",
      permissionLevel: "read-only",
    });
    expect(created.name).toBe("nightly");
    expect(created.cwd).toBe("/tmp/proj");
    expect(created.permissionLevel).toBe("read-only");
    expect(typeof created.nextRun).toBe("number");

    const list = listAutomations();
    expect(list).toHaveLength(1);
    // Summary is a plain object (no class instance crosses IPC).
    expect(Object.getPrototypeOf(list[0])).toBe(Object.prototype);
    sched.stopAll();
  });

  test("pause/resume flips enabled in the summary", () => {
    const job = createAutomation({ name: "x", schedule: "1h", prompt: "p" });
    expect(pauseAutomation(job.id)).toBe(true);
    expect(getAutomation(job.id)?.enabled).toBe(false);
    expect(resumeAutomation(job.id)).toBe(true);
    expect(getAutomation(job.id)?.enabled).toBe(true);
    sched.stopAll();
  });

  test("delete removes the job", () => {
    const job = createAutomation({ name: "x", schedule: "1h", prompt: "p" });
    expect(deleteAutomation(job.id)).toBe(true);
    expect(getAutomation(job.id)).toBeNull();
  });

  test("create throws on an invalid cron expression", () => {
    expect(() => createAutomation({ name: "bad", schedule: "99 9 * * *", prompt: "p" })).toThrow();
  });
});
