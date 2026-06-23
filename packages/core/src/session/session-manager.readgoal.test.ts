// packages/core/src/session/session-manager.readgoal.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

// readActiveGoal is the cheap "does this session have a persisted goal?" probe.
// A persistent goal lives ONLY in state.json (activeGoal) — it is never written
// to the transcript as an event, so a session rebuilt from disk (localStorage
// wiped) can't recover the goal from its messages. The desktop host calls this
// on session load to re-surface the goal block + its Cancel button. Like
// readCwd, it reads only state.json and never throws on a bad id.
describe("SessionManager.readActiveGoal", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sm-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("returns the persisted active goal of a session", () => {
    const sm = new SessionManager(dir);
    const { state } = sm.create("/Users/me/proj", "m", "p", "s-1");
    state.activeGoal = { objective: "有授权 你直接帮我做完" };
    sm.saveState(state);
    expect(sm.readActiveGoal("s-1")).toEqual({ objective: "有授权 你直接帮我做完" });
  });

  test("returns undefined when the session has no goal", () => {
    const sm = new SessionManager(dir);
    sm.create("/Users/me/proj", "m", "p", "s-2");
    expect(sm.readActiveGoal("s-2")).toBeUndefined();
  });

  test("returns undefined for an unknown session", () => {
    const sm = new SessionManager(dir);
    expect(sm.readActiveGoal("does-not-exist")).toBeUndefined();
  });

  test("returns undefined (does not throw) for a traversal-shaped id", () => {
    const sm = new SessionManager(dir);
    expect(sm.readActiveGoal("../../etc")).toBeUndefined();
  });
});
