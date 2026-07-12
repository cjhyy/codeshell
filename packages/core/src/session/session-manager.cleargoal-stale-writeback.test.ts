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
//   3. The live loop's next saveState(A.state) tries to RE-WRITE the goal. A
//      terminal tombstone must reject that stale field instead of resurrecting
//      it.
//
// Engine "method D" clears the SAME bundle when possible. The tombstone is the
// cross-bundle backstop for idle-host clears and concurrent stale writers.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { deriveLegacyGoalId, MAX_GOAL_TERMINALS, recordGoalTerminal } from "../engine/goal.js";

const OBJ = "帮我继续看看还有没有问题 我已经修复了一个版本了";

describe("clear goal vs a live run's stale-bundle write-back", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sm-stale-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("clearing on disk tombstones the goal against a detached writer", () => {
    const sm = new SessionManager(dir);
    // (1) Live run holds bundle A for its whole lifetime.
    const { state: liveState } = sm.create("/Users/me/proj", "m", "p", "s-run");
    liveState.activeGoal = { objective: OBJ, goalId: "live-goal" };
    sm.saveState(liveState);

    // (2) Clear operates on a fresh detached copy (SessionManager.clearActiveGoal
    // reads state.json into a NEW object — the pre-fix disk-only clear path).
    expect(sm.clearActiveGoal("s-run")).toBe(true);
    expect(sm.readActiveGoal("s-run")).toBeUndefined(); // disk clear right now

    // (3) The live loop advances and persists ITS stale bundle — the terminal
    // tombstone must prevent the cleared goal from being resurrected.
    sm.saveState(liveState);
    expect(sm.readActiveGoal("s-run")).toBeUndefined();
    expect(sm.resume("s-run").state.goalTerminal?.reason).toBe("cancelled");
  });

  test("FIX invariant: clearing the LIVE bundle survives its own later saveState", () => {
    const sm = new SessionManager(dir);
    // (1) Live run holds bundle A.
    const { state: liveState } = sm.create("/Users/me/proj", "m", "p", "s-run");
    liveState.activeGoal = { objective: OBJ };
    sm.saveState(liveState);

    // (2) Engine method D drops the goal on the SAME bundle the run holds
    // (Engine.activeRunSession === this instance), then persists it.
    const liveGoal = liveState.activeGoal;
    liveState.activeGoal = undefined;
    recordGoalTerminal(liveState, liveGoal, "cancelled");
    sm.saveState(liveState);
    expect(sm.readActiveGoal("s-run")).toBeUndefined();

    // (3) The live loop advances and saves its bundle again — still cleared,
    // because the goal was dropped on the live instance itself, not a copy.
    sm.saveState(liveState);
    expect(sm.readActiveGoal("s-run")).toBeUndefined();
  });

  test("terminal tombstone defeats a detached writer carrying the terminated goal", () => {
    const sm = new SessionManager(dir);
    const goal = { objective: OBJ, setAtMs: 123_456 };
    const { state: liveState } = sm.create("/Users/me/proj", "m", "p", "s-terminal");
    liveState.activeGoal = goal;
    sm.saveState(liveState);

    // Detached writer captured goal A before its run was force-terminated.
    const staleState = sm.resume("s-terminal").state;

    // Engine terminates A on the live bundle and records an identity-bound
    // tombstone before its final whole-state writeback.
    liveState.activeGoal = undefined;
    liveState.goalTerminal = {
      objective: goal.objective,
      setAtMs: goal.setAtMs,
      reason: "stop_blocks_exhausted",
    };
    sm.saveState(liveState);
    expect(sm.readActiveGoal("s-terminal")).toBeUndefined();

    // A stale whole-state writer must not resurrect the tombstoned goal.
    sm.saveState(staleState);
    expect(sm.readActiveGoal("s-terminal")).toBeUndefined();
    expect(sm.resume("s-terminal").state.goalTerminal).toEqual(liveState.goalTerminal);
  });

  test("detached run A terminal save preserves goal B written by another bundle", () => {
    const sm = new SessionManager(dir);
    const { state: runA } = sm.create("/Users/me/proj", "m", "p", "s-detached-ab");
    runA.activeGoal = { objective: "goal A", goalId: "goal-a", setAtMs: 1 } as never;
    sm.saveState(runA);

    const { state: writerB } = sm.resume("s-detached-ab");
    writerB.activeGoal = { objective: "goal B", goalId: "goal-b", setAtMs: 1 } as never;
    sm.saveState(writerB);

    runA.activeGoal = undefined;
    runA.goalTerminal = {
      objective: "goal A",
      goalId: "goal-a",
      setAtMs: 1,
      reason: "completed",
      terminatedAtMs: 10,
    } as never;
    sm.saveState(runA);

    expect(sm.resume("s-detached-ab").state.activeGoal).toEqual({
      objective: "goal B",
      goalId: "goal-b",
      setAtMs: 1,
    });
  });

  test("terminal identity history rejects stale A after both A and B terminate", () => {
    const sm = new SessionManager(dir);
    const { state: staleA } = sm.create("/Users/me/proj", "m", "p", "s-history");
    staleA.activeGoal = { objective: "same", goalId: "goal-a", setAtMs: 1 } as never;
    sm.saveState(staleA);

    const terminalA = sm.resume("s-history").state;
    terminalA.activeGoal = undefined;
    terminalA.goalTerminal = {
      objective: "same",
      goalId: "goal-a",
      setAtMs: 1,
      reason: "cancelled",
      terminatedAtMs: 20,
    } as never;
    sm.saveState(terminalA);

    const terminalB = sm.resume("s-history").state;
    terminalB.activeGoal = { objective: "same", goalId: "goal-b", setAtMs: 1 } as never;
    sm.saveState(terminalB);
    terminalB.activeGoal = undefined;
    terminalB.goalTerminal = {
      objective: "same",
      goalId: "goal-b",
      setAtMs: 1,
      reason: "cancelled",
      terminatedAtMs: 20,
    } as never;
    sm.saveState(terminalB);

    sm.saveState(staleA);

    const persisted = sm.resume("s-history").state as typeof terminalB & {
      goalTerminals?: Array<{ goalId?: string }>;
    };
    expect(persisted.activeGoal).toBeUndefined();
    expect(persisted.goalTerminals?.map((terminal) => terminal.goalId)).toEqual([
      "goal-a",
      "goal-b",
    ]);
  });

  test("disk new 64 terminals reject a detached old-64 whole-state writer", () => {
    const sm = new SessionManager(dir);
    const { state: detachedOld } = sm.create("/Users/me/proj", "m", "p", "s-new64-old64");
    const older = Array.from({ length: MAX_GOAL_TERMINALS }, (_, index) => ({
      objective: `old ${index}`,
      goalId: `old-${index}`,
      reason: "cancelled" as const,
      terminatedAtMs: index,
    }));
    detachedOld.activeGoal = { objective: "disk goal 0", goalId: "new-0", setAtMs: 10 };
    detachedOld.goalTerminals = older;
    detachedOld.goalTerminal = older.at(-1);
    sm.saveState(detachedOld);

    const diskNew = sm.resume("s-new64-old64").state;
    const newer = Array.from({ length: MAX_GOAL_TERMINALS }, (_, index) => ({
      objective: `disk goal ${index}`,
      goalId: `new-${index}`,
      setAtMs: 10 + index,
      reason: "completed" as const,
      terminatedAtMs: 1_000 + index,
    }));
    diskNew.activeGoal = undefined;
    diskNew.goalTerminals = newer;
    diskNew.goalTerminal = newer.at(-1);
    expect(sm.saveState(diskNew)).toBe(true);

    expect(sm.saveState(detachedOld)).toBe(false);

    const persisted = sm.resume("s-new64-old64").state;
    expect(persisted.activeGoal).toBeUndefined();
    expect(persisted.goalTerminal?.goalId).toBe("new-63");
    expect(persisted.goalTerminals?.map((terminal) => terminal.goalId)).toEqual(
      newer.map((terminal) => terminal.goalId),
    );
  });

  test("two detached bundles migrate the same legacy goal to one deterministic identity", () => {
    const sessionId = "s-concurrent-legacy-migration";
    const sm = new SessionManager(dir);
    const { state: seed } = sm.create("/Users/me/proj", "m", "p", sessionId);
    seed.activeGoal = {
      objective: "legacy A",
      setAtMs: 123_456,
      tokenBudget: 1_000,
      maxTurns: 20,
    };
    sm.saveState(seed);

    const migratedX = sm.resume(sessionId).state;
    const migratedY = sm.resume(sessionId).state;
    migratedX.activeGoal!.goalId = deriveLegacyGoalId(sessionId, migratedX.activeGoal!);
    migratedY.activeGoal!.goalId = deriveLegacyGoalId(sessionId, migratedY.activeGoal!);

    expect(migratedX.activeGoal!.goalId).toBe(migratedY.activeGoal!.goalId);

    const migratedId = migratedX.activeGoal!.goalId!;
    const completed = migratedX.activeGoal!;
    migratedX.activeGoal = undefined;
    recordGoalTerminal(migratedX, completed, "completed", 10_000);
    expect(sm.saveState(migratedX)).toBe(true);

    expect(sm.saveState(migratedY)).toBe(false);
    const persisted = sm.resume(sessionId).state;
    expect(persisted.activeGoal).toBeUndefined();
    expect(persisted.goalTerminal?.goalId).toBe(migratedId);
  });

  test("goal terminal persistence read-merges and retries a workspace revision conflict", () => {
    const sessionId = "s-terminal-workspace-conflict";
    const sm = new SessionManager(dir);
    const { state: live } = sm.create("/Users/me/proj", "m", "p", sessionId);
    live.activeGoal = { objective: "finish after switch", goalId: "goal-a", setAtMs: 1 };
    expect(sm.saveState(live)).toBe(true);

    const workspace = {
      root: "/Users/me/proj/.worktrees/feature",
      kind: "worktree" as const,
      worktree: {
        path: "/Users/me/proj/.worktrees/feature",
        branch: "worktree/feature",
        baseRef: "main",
        createdBy: "codeshell" as const,
      },
    };
    sm.setSessionWorkspace(sessionId, workspace);
    expect(live.stateRevision).toBe(1);

    expect(sm.saveGoalTerminal(live, live.activeGoal, "completed")).toBe(true);
    const persisted = sm.resume(sessionId).state;
    expect(persisted.workspace).toEqual(workspace);
    expect(persisted.activeGoal).toBeUndefined();
    expect(persisted.goalTerminal).toMatchObject({ goalId: "goal-a", reason: "completed" });
    expect(live.stateRevision).toBe(persisted.stateRevision);
  });
});
