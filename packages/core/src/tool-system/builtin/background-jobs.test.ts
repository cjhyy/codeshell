import { describe, it, expect, beforeEach } from "bun:test";
import { backgroundJobRegistry } from "./background-jobs.js";

describe("backgroundJobRegistry", () => {
  beforeEach(() => backgroundJobRegistry.reset());

  it("tracks a running job per session", () => {
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(false);
    backgroundJobRegistry.start("video-1", "s1");
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(true);
    // other session unaffected
    expect(backgroundJobRegistry.hasRunningForSession("s2")).toBe(false);
  });

  it("clears the job on finish", () => {
    backgroundJobRegistry.start("video-1", "s1");
    backgroundJobRegistry.finish("video-1");
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(false);
  });

  it("hasRunningForSession is true while ANY of the session's jobs run", () => {
    backgroundJobRegistry.start("video-1", "s1");
    backgroundJobRegistry.start("video-2", "s1");
    backgroundJobRegistry.finish("video-1");
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(true);
    backgroundJobRegistry.finish("video-2");
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(false);
  });

  it("notifies subscribers on start and finish", () => {
    let n = 0;
    const unsub = backgroundJobRegistry.subscribe(() => n++);
    backgroundJobRegistry.start("video-1", "s1");
    backgroundJobRegistry.finish("video-1");
    unsub();
    backgroundJobRegistry.start("video-2", "s1"); // after unsub — no count
    expect(n).toBe(2);
  });

  it("finish on an unknown job is a no-op (no throw, no notify)", () => {
    let n = 0;
    const unsub = backgroundJobRegistry.subscribe(() => n++);
    backgroundJobRegistry.finish("nope");
    unsub();
    expect(n).toBe(0);
  });

  it("rejects an invalid sessionId (empty string) without tracking", () => {
    backgroundJobRegistry.start("video-1", "");
    expect(backgroundJobRegistry.hasRunningForSession("")).toBe(false);
  });

  // ── Retention (#2/#5): finished jobs stay visible with a result ──────────

  it("retains a finished job with status + finalText (not deleted)", () => {
    backgroundJobRegistry.start("v1", "s1", "Generating video");
    backgroundJobRegistry.finish("v1", { status: "completed", finalText: "https://out.mp4" });
    const jobs = backgroundJobRegistry.listForSession("s1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("completed");
    expect(jobs[0].finalText).toBe("https://out.mp4");
    expect(jobs[0].finishedAt).toBeGreaterThan(0);
    // ...but it's no longer "running", so the engine wait-loop won't park on it.
    expect(backgroundJobRegistry.hasRunningForSession("s1")).toBe(false);
  });

  it("finish defaults to completed when no outcome is given", () => {
    backgroundJobRegistry.start("v1", "s1");
    backgroundJobRegistry.finish("v1");
    expect(backgroundJobRegistry.listForSession("s1")[0].status).toBe("completed");
  });

  it("records failure status + error text", () => {
    backgroundJobRegistry.start("v1", "s1");
    backgroundJobRegistry.finish("v1", { status: "failed", finalText: "boom" });
    const j = backgroundJobRegistry.listForSession("s1")[0];
    expect(j.status).toBe("failed");
    expect(j.finalText).toBe("boom");
  });

  it("a started job carries status 'running' and a startedAt", () => {
    backgroundJobRegistry.start("v1", "s1");
    const j = backgroundJobRegistry.listForSession("s1")[0];
    expect(j.status).toBe("running");
    expect(j.startedAt).toBeGreaterThan(0);
  });

  it("listRunningForSession returns only running jobs (goal judge feed)", () => {
    backgroundJobRegistry.start("v1", "s1");
    backgroundJobRegistry.start("v2", "s1");
    backgroundJobRegistry.finish("v1", { status: "completed" });
    const running = backgroundJobRegistry.listRunningForSession("s1");
    expect(running.map((j) => j.jobId)).toEqual(["v2"]);
    // full list still has both.
    expect(backgroundJobRegistry.listForSession("s1")).toHaveLength(2);
  });

  it("dropForSession removes all of a session's jobs (session deleted)", () => {
    backgroundJobRegistry.start("v1", "s1");
    backgroundJobRegistry.finish("v1", { status: "completed" });
    backgroundJobRegistry.start("v2", "s2");
    backgroundJobRegistry.dropForSession("s1");
    expect(backgroundJobRegistry.listForSession("s1")).toHaveLength(0);
    expect(backgroundJobRegistry.listForSession("s2")).toHaveLength(1);
  });

  it("caps retained TERMINAL jobs per session, evicting the oldest (running kept)", () => {
    // Start a running job that must survive the cap.
    backgroundJobRegistry.start("run-keep", "s1");
    // Create > cap terminal jobs.
    const N = 55;
    for (let i = 0; i < N; i++) {
      const id = `t${i}`;
      backgroundJobRegistry.start(id, "s1");
      backgroundJobRegistry.finish(id, { status: "completed" });
    }
    const jobs = backgroundJobRegistry.listForSession("s1");
    const terminal = jobs.filter((j) => j.status !== "running");
    expect(terminal.length).toBeLessThanOrEqual(50);
    // The running job is never evicted.
    expect(jobs.some((j) => j.jobId === "run-keep" && j.status === "running")).toBe(true);
    // The oldest terminal jobs (t0, t1, …) are the ones dropped.
    expect(jobs.some((j) => j.jobId === "t0")).toBe(false);
    expect(jobs.some((j) => j.jobId === `t${N - 1}`)).toBe(true);
  });
});
