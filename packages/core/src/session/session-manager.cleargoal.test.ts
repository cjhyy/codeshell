// packages/core/src/session/session-manager.cleargoal.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

// clearActiveGoal is the disk-only "wipe this session's persistent goal" op —
// the counterpart to readActiveGoal. It exists so a host (the desktop bridge)
// can clear a goal for a session whose worker is NOT live (aborted/reloaded)
// without spinning up a full Engine. Engine.clearGoal reuses it for the disk
// write. Idempotent, never throws on a bad id, writes atomically via saveState.
describe("SessionManager.clearActiveGoal", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sm-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("clears an existing goal and returns true", () => {
    const sm = new SessionManager(dir);
    const { state } = sm.create("/Users/me/proj", "m", "p", "s-1");
    state.activeGoal = { objective: "干到4点 一直找问题" };
    sm.saveState(state);

    expect(sm.clearActiveGoal("s-1")).toBe(true);
    // The goal is gone from disk — a subsequent read sees nothing.
    expect(sm.readActiveGoal("s-1")).toBeUndefined();
    expect(sm.resume("s-1").state.goalTerminal?.reason).toBe("cancelled");
    expect(sm.resume("s-1").state.goalTerminal?.goalId).toBeString();
  });

  test("returns false when the session has no goal (no-op)", () => {
    const sm = new SessionManager(dir);
    sm.create("/Users/me/proj", "m", "p", "s-2");
    expect(sm.clearActiveGoal("s-2")).toBe(false);
  });

  test("returns false for an unknown session", () => {
    const sm = new SessionManager(dir);
    expect(sm.clearActiveGoal("does-not-exist")).toBe(false);
  });

  test("returns false (does not throw) for a traversal-shaped id", () => {
    const sm = new SessionManager(dir);
    expect(sm.clearActiveGoal("../../etc")).toBe(false);
  });

  test("preserves the rest of state.json when clearing the goal", () => {
    const sm = new SessionManager(dir);
    const { state } = sm.create("/Users/me/proj", "gpt-5.5", "openai", "s-3");
    state.activeGoal = { objective: "x" };
    state.turnCount = 7;
    sm.saveState(state);

    expect(sm.clearActiveGoal("s-3")).toBe(true);
    const after = sm.resume("s-3").state;
    expect(after.activeGoal).toBeUndefined();
    expect(after.turnCount).toBe(7);
    expect(after.model).toBe("gpt-5.5");
  });
});
