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
import {
  deriveLegacyGoalId,
  goalConfigFromLifecycle,
  type GoalConfig,
  type GoalLifecycleTerminalReason,
} from "../goal/lifecycle.js";
import type { SessionState } from "../types.js";

const OBJ = "帮我继续看看还有没有问题 我已经修复了一个版本了";

function activeGoal(state: SessionState): GoalConfig | undefined {
  const lifecycle = state.goalLifecycle;
  return lifecycle && lifecycle.phase !== "terminal"
    ? goalConfigFromLifecycle(lifecycle)
    : undefined;
}

function expectTerminal(
  state: SessionState,
  expected: { goalId?: string; reason: GoalLifecycleTerminalReason },
): void {
  const lifecycle = state.goalLifecycle;
  expect(lifecycle?.phase).toBe("terminal");
  if (lifecycle?.phase !== "terminal") throw new Error("expected terminal Goal lifecycle");
  if (expected.goalId !== undefined) expect(lifecycle.goalId).toBe(expected.goalId);
  expect(lifecycle.terminal.reason).toBe(expected.reason);
}

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
    expectTerminal(sm.resume("s-run").state, { reason: "user_cleared" });
  });

  test("FIX invariant: clearing the LIVE bundle survives its own later saveState", () => {
    const sm = new SessionManager(dir);
    // (1) Live run holds bundle A.
    const { state: liveState } = sm.create("/Users/me/proj", "m", "p", "s-run");
    liveState.activeGoal = { objective: OBJ };
    sm.saveState(liveState);

    // (2) Engine method D drops the goal on the SAME bundle the run holds
    // (Engine.activeRunSession === this instance), then persists it.
    const liveGoal = activeGoal(liveState)!;
    expect(sm.saveGoalTerminal(liveState, liveGoal, "cancelled")).toBe(true);
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
    expect(sm.saveGoalTerminal(liveState, activeGoal(liveState), "stop_blocks_exhausted")).toBe(
      true,
    );
    expect(sm.readActiveGoal("s-terminal")).toBeUndefined();

    // A stale whole-state writer must not resurrect the tombstoned goal.
    sm.saveState(staleState);
    expect(sm.readActiveGoal("s-terminal")).toBeUndefined();
    expect(sm.resume("s-terminal").state.goalLifecycle).toEqual(liveState.goalLifecycle);
  });

  test("detached run A terminal save preserves goal B written by another bundle", () => {
    const sm = new SessionManager(dir);
    const { state: runA } = sm.create("/Users/me/proj", "m", "p", "s-detached-ab");
    const goalA = { objective: "goal A", goalId: "goal-a", revision: 1, setAtMs: 1 };
    expect(sm.saveActiveGoal(runA, goalA)).toBe(true);

    const { state: writerB } = sm.resume("s-detached-ab");
    expect(
      sm.saveActiveGoal(
        writerB,
        { objective: "goal B", goalId: "goal-b", revision: 1, setAtMs: 1 },
        { replaceCurrent: true },
      ),
    ).toBe(true);

    expect(sm.saveGoalTerminal(runA, goalA, "completed")).toBe(true);

    expect(activeGoal(sm.resume("s-detached-ab").state)).toMatchObject({
      objective: "goal B",
      goalId: "goal-b",
      setAtMs: 1,
    });
  });

  test("a stale A terminal cannot close the current B lifecycle", () => {
    const sm = new SessionManager(dir);
    const { state: staleA } = sm.create("/Users/me/proj", "m", "p", "s-history");
    const goalA = { objective: "same", goalId: "goal-a", revision: 1, setAtMs: 1 };
    expect(sm.saveActiveGoal(staleA, goalA)).toBe(true);
    const writerB = sm.resume("s-history").state;
    expect(
      sm.saveActiveGoal(
        writerB,
        { objective: "same", goalId: "goal-b", revision: 1, setAtMs: 1 },
        { replaceCurrent: true },
      ),
    ).toBe(true);

    expect(sm.saveGoalTerminal(staleA, goalA, "cancelled")).toBe(true);
    expect(activeGoal(sm.resume("s-history").state)).toMatchObject({ goalId: "goal-b" });
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
    const goalX = activeGoal(migratedX)!;
    const goalY = activeGoal(migratedY)!;
    expect(goalX.goalId).toBe(deriveLegacyGoalId(sessionId, goalX));
    expect(goalX.goalId).toBe(goalY.goalId);

    const migratedId = goalX.goalId!;
    expect(sm.saveGoalTerminal(migratedX, goalX, "completed")).toBe(true);

    expect(sm.saveState(migratedY)).toBe(false);
    const persisted = sm.resume(sessionId).state;
    expect(activeGoal(persisted)).toBeUndefined();
    expectTerminal(persisted, { goalId: migratedId, reason: "completed" });
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

    const goal = activeGoal(live)!;
    expect(sm.saveGoalTerminal(live, goal, "completed")).toBe(true);
    const persisted = sm.resume(sessionId).state;
    expect(persisted.workspace).toEqual(workspace);
    expect(activeGoal(persisted)).toBeUndefined();
    expectTerminal(persisted, { goalId: "goal-a", reason: "completed" });
    expect(live.stateRevision).toBe(persisted.stateRevision);
  });

  test("goal terminal conflict cannot authorize a later stale whole-state metadata overwrite", () => {
    const sessionId = "s-terminal-summary-conflict";
    const sm = new SessionManager(dir);
    const { state: live } = sm.create("/Users/me/proj", "m", "p", sessionId);
    live.summary = "summary captured by the old run";
    live.activeGoal = { objective: "finish safely", goalId: "goal-a", setAtMs: 1 };
    expect(sm.saveState(live)).toBe(true);

    sm.updateSessionState(sessionId, { summary: "new summary from another writer" });

    const goal = activeGoal(live)!;
    expect(sm.saveGoalTerminal(live, goal, "completed")).toBe(true);
    live.status = "completed";
    live.turnSeq = 2;
    expect(
      sm.saveStateOrUpdateFields(live, {
        status: live.status,
        turnSeq: live.turnSeq,
      }),
    ).toBe(true);

    const persisted = sm.resume(sessionId).state;
    expect(persisted.summary).toBe("new summary from another writer");
    expect(persisted.turnSeq).toBe(2);
    expect(activeGoal(persisted)).toBeUndefined();
    expectTerminal(persisted, { goalId: "goal-a", reason: "completed" });
  });

  test("arming a goal preserves concurrent non-goal fields and rebases the live state", () => {
    const sessionId = "s-arm-goal-domain-update";
    const sm = new SessionManager(dir);
    const { state: live } = sm.create("/Users/me/proj", "m", "p", sessionId);
    live.summary = "old summary";
    expect(sm.saveState(live)).toBe(true);

    sm.updateSessionState(sessionId, { summary: "new summary" });
    const goal = { objective: "ship it", goalId: "goal-new", revision: 1, setAtMs: 10 };

    expect(sm.saveActiveGoal(live, goal)).toBe(true);

    const persisted = sm.resume(sessionId).state;
    expect(persisted.summary).toBe("new summary");
    expect(activeGoal(persisted)).toEqual(goal);
    expect(live.summary).toBe("new summary");
    expect(live.stateRevision).toBe(persisted.stateRevision);
  });

  test("arming a replacement terminally closes the latest active identity", () => {
    const sessionId = "s-replace-goal-domain-update";
    const sm = new SessionManager(dir);
    const { state: live } = sm.create("/Users/me/proj", "m", "p", sessionId);
    live.activeGoal = { objective: "old", goalId: "goal-old", revision: 2, setAtMs: 1 };
    expect(sm.saveState(live)).toBe(true);

    const replacement = { objective: "new", goalId: "goal-new", revision: 1, setAtMs: 2 };
    expect(sm.saveActiveGoal(live, replacement, { replaceCurrent: true })).toBe(true);

    const persisted = sm.resume(sessionId).state;
    expect(activeGoal(persisted)).toEqual(replacement);
    expect(persisted.goalTerminal).toBeUndefined();
  });
});
