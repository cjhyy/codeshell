// packages/core/src/session/session-manager.cleargoal-stale-writeback.test.ts
//
// Reproduction + invariant for the "点清除 goal 没反应 / 刷新后 goal 还在" bug
// (session Pf1cplTPOWx9fB2c).
//
// Real-world sequence:
//   1. A send with a goal starts a run. engine.run() resumes bundle A and holds
//      A.state for the whole run; every round calls saveState(A.state), and
//      A.state.activeGoal stays set until the goal is met. A goal run that keeps
//      being judged not_met (continueSession) stays live indefinitely — so this
//      race is the NORM for such runs, not a rare edge case.
//   2. Mid-run the user clicks "Clear goal". If the clear operates on a DIFFERENT
//      bundle B (a fresh resume() copy — what SessionManager.clearActiveGoal
//      does, since resume() always constructs a detached {state,transcript}),
//      disk is momentarily clear but the live loop still holds A with the goal.
//   3. The live loop's next saveState(A.state) RE-WRITES the goal — the clear is
//      silently overwritten. That is the bug.
//
// The fix (Engine "method D") makes Engine.clearGoal operate on the SAME bundle
// the run holds (Engine.activeRunSession), so A.state.activeGoal itself is
// dropped and A's own later saveState persists the cleared state. These two
// tests pin both halves: the write-back defeat when a detached copy is cleared,
// and the invariant that clearing the live instance survives its own saveState.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

const OBJ = "帮我继续看看还有没有问题 我已经修复了一个版本了";

describe("clear goal vs a live run's stale-bundle write-back", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sm-stale-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("BUG: clearing a DETACHED copy is defeated by the live bundle's later saveState", () => {
    const sm = new SessionManager(dir);
    // (1) Live run holds bundle A for its whole lifetime.
    const { state: liveState } = sm.create("/Users/me/proj", "m", "p", "s-run");
    liveState.activeGoal = { objective: OBJ };
    sm.saveState(liveState);

    // (2) Clear operates on a fresh detached copy (SessionManager.clearActiveGoal
    // reads state.json into a NEW object — the pre-fix disk-only clear path).
    expect(sm.clearActiveGoal("s-run")).toBe(true);
    expect(sm.readActiveGoal("s-run")).toBeUndefined(); // disk clear right now

    // (3) The live loop advances and persists ITS stale bundle — goal resurrected.
    sm.saveState(liveState);
    expect(sm.readActiveGoal("s-run")).toEqual({ objective: OBJ });
  });

  test("FIX invariant: clearing the LIVE bundle survives its own later saveState", () => {
    const sm = new SessionManager(dir);
    // (1) Live run holds bundle A.
    const { state: liveState } = sm.create("/Users/me/proj", "m", "p", "s-run");
    liveState.activeGoal = { objective: OBJ };
    sm.saveState(liveState);

    // (2) Engine method D drops the goal on the SAME bundle the run holds
    // (Engine.activeRunSession === this instance), then persists it.
    liveState.activeGoal = undefined;
    sm.saveState(liveState);
    expect(sm.readActiveGoal("s-run")).toBeUndefined();

    // (3) The live loop advances and saves its bundle again — still cleared,
    // because the goal was dropped on the live instance itself, not a copy.
    sm.saveState(liveState);
    expect(sm.readActiveGoal("s-run")).toBeUndefined();
  });
});
