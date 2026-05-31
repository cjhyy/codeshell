import { describe, test, expect, beforeEach } from "bun:test";
import { CronScheduler } from "@cjhyy/code-shell-core";
import {
  setAutomationScheduler,
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
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

  test("update changes prompt + schedule and returns the new summary", () => {
    const job = createAutomation({ name: "j", schedule: "1h", prompt: "old" });
    const updated = updateAutomation(job.id, { prompt: "new", schedule: "0 9 * * 1-5", timezone: "UTC" });
    expect(updated?.prompt).toBe("new");
    expect(updated?.schedule).toBe("0 9 * * 1-5");
    expect(updated?.timezone).toBe("UTC");
    expect(getAutomation(job.id)?.prompt).toBe("new");
    sched.stopAll();
  });

  test("update rejects an invalid schedule (throws, job unchanged)", () => {
    const job = createAutomation({ name: "j", schedule: "1h", prompt: "p" });
    expect(() => updateAutomation(job.id, { schedule: "99 9 * * *" })).toThrow();
    expect(getAutomation(job.id)?.schedule).toBe("1h");
    sched.stopAll();
  });

  test("update returns null for unknown id", () => {
    expect(updateAutomation("nope", { prompt: "x" })).toBeNull();
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
