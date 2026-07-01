import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler } from "./scheduler.js";
import { CronStore } from "./store.js";

// #8: a "continue this conversation" job carries resumeSessionId so the fired
// run resumes an existing codeshell session instead of starting a fresh one.
// These cover the two things the scheduler owns: accepting the field on create,
// and surviving a persist → reload round-trip (JSON snapshot).

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-resume-"));
  file = join(dir, "cron.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("CronScheduler resumeSessionId (#8 continue-this-conversation)", () => {
  test("create stores resumeSessionId on the job when passed", () => {
    const sched = new CronScheduler();
    const job = sched.create("continue", "10m", "接着做", {
      resumeSessionId: "sess-abc123",
    });
    expect(job.resumeSessionId).toBe("sess-abc123");
    sched.stopAll();
  });

  test("resumeSessionId is undefined when the option is omitted (standalone default)", () => {
    const sched = new CronScheduler();
    const job = sched.create("standalone", "10m", "daily report");
    expect(job.resumeSessionId).toBeUndefined();
    sched.stopAll();
  });

  test("resumeSessionId survives a persist → reload round-trip", () => {
    const a = new CronScheduler(new CronStore(file));
    const j = a.create("continue", "1h", "接着做", { resumeSessionId: "sess-xyz" });
    a.stopAll();

    // New process: fresh scheduler from the same store.
    const b = new CronScheduler(new CronStore(file));
    b.loadJobs();
    const restored = b.get(j.id);
    expect(restored?.resumeSessionId).toBe("sess-xyz");
    b.stopAll();
  });

  test("a standalone job reloads with no resumeSessionId (no phantom field)", () => {
    const a = new CronScheduler(new CronStore(file));
    const j = a.create("standalone", "1h", "report");
    a.stopAll();

    const b = new CronScheduler(new CronStore(file));
    b.loadJobs();
    expect(b.get(j.id)?.resumeSessionId).toBeUndefined();
    b.stopAll();
  });
});
