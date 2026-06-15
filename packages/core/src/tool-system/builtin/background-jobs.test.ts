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
});
