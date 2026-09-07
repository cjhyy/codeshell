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

  for (const persisted of [false, true]) {
    const mode = persisted ? "persisted" : "in-memory";

    test(`${mode} updates bind, rebind, retain, and clear the execution Session`, () => {
      const sched = new CronScheduler(persisted ? new CronStore(file) : undefined);
      const job = sched.create("update binding", "1h", "report");
      const assertBinding = (expected: string | undefined) => {
        expect(sched.get(job.id)?.resumeSessionId).toBe(expected);
        if (persisted) {
          const reloaded = new CronScheduler(new CronStore(file));
          reloaded.loadJobs({ arm: false });
          expect(reloaded.get(job.id)?.resumeSessionId).toBe(expected);
          reloaded.stopAll();
        }
      };
      sched.update(job.id, { resumeSessionId: "session-a" });
      assertBinding("session-a");
      sched.update(job.id, { resumeSessionId: "session-b" });
      assertBinding("session-b");
      sched.update(job.id, { prompt: "updated report" });
      assertBinding("session-b");
      sched.update(job.id, { resumeSessionId: null });
      assertBinding(undefined);
      sched.stopAll();
    });

    test(`${mode} binding changes fail atomically while executing, then work after completion`, async () => {
      const sched = new CronScheduler(persisted ? new CronStore(file) : undefined);
      const job = sched.create("running", "1h", "original", { resumeSessionId: "session-a" });
      let finish!: () => void;
      const execution = new Promise<void>((resolve) => {
        finish = resolve;
      });
      sched.setExecutor(async (running) => {
        expect(running.resumeSessionId).toBe("session-a");
        await execution;
        expect(running.resumeSessionId).toBe("session-a");
      });
      sched.runNow(job.id);
      try {
        for (const resumeSessionId of ["session-b", null]) {
          expect(() => sched.update(job.id, { resumeSessionId, prompt: "must not apply" })).toThrow(
            /running.*binding/,
          );
        }
        for (const workspacePatch of [
          { cwd: "/another-workspace" },
          { projectId: "another-project", rootId: "another-root" },
        ]) {
          expect(() =>
            sched.update(job.id, { ...workspacePatch, prompt: "must not apply" }),
          ).toThrow(/running.*binding/);
        }
        expect(sched.get(job.id)?.prompt).toBe("original");
        expect(
          sched.update(job.id, { resumeSessionId: "session-a", prompt: "allowed" })?.prompt,
        ).toBe("allowed");
      } finally {
        finish();
        await sched.abort(job.id);
        sched.stopAll();
      }
      expect(sched.update(job.id, { resumeSessionId: "session-b" })?.resumeSessionId).toBe(
        "session-b",
      );
      sched.stopAll();
    });
    test(`${mode} rebinding a stopped job retains its disabled state until explicitly resumed`, () => {
      const sched = new CronScheduler(persisted ? new CronStore(file) : undefined);
      const job = sched.create("stopped", "1h", "report", { resumeSessionId: "missing-session" });
      sched.disableWithReason(job.id, "resume target was deleted");
      expect(sched.update(job.id, { resumeSessionId: "valid-session" })).toMatchObject({
        resumeSessionId: "valid-session",
        enabled: false,
        disabledReason: "resume target was deleted",
      });
      sched.resume(job.id);
      expect(sched.get(job.id)?.enabled).toBe(true);
      expect(sched.get(job.id)?.disabledReason).toBeUndefined();
      sched.stopAll();
    });
  }

  test("invalid binding values cannot replace a valid job definition", () => {
    const sched = new CronScheduler();
    const job = sched.create("valid", "1h", "original", { resumeSessionId: "session-a" });
    for (const resumeSessionId of ["", "a\0b", "a".repeat(513), 42]) {
      expect(() => sched.update(job.id, { resumeSessionId, prompt: "invalid" } as any)).toThrow(
        /resumeSessionId/,
      );
    }
    expect(sched.get(job.id)).toMatchObject({ prompt: "original", resumeSessionId: "session-a" });
    sched.stopAll();
  });
});
