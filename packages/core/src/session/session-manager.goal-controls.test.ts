import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("SessionManager goal controls", () => {
  let dir: string;
  let manager: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sm-goal-controls-"));
    manager = new SessionManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedGoal(sessionId: string) {
    const { state } = manager.create("/Users/me/project", "model", "provider", sessionId);
    state.activeGoal = {
      objective: "original objective",
      goalId: "goal-1",
      revision: 7,
      setAtMs: 1,
    };
    expect(manager.saveState(state)).toBe(true);
  }

  test("edit preserves goalId, advances revision, and rejects a stale revision", () => {
    seedGoal("edit-goal");

    const edited = manager.updateActiveGoal("edit-goal", {
      objective: "  edited objective  ",
      expectedGoalId: "goal-1",
      expectedRevision: 7,
    });

    expect(edited?.goal).toMatchObject({
      objective: "edited objective",
      goalId: "goal-1",
      revision: 8,
    });
    expect(edited?.goal.setAtMs).toBeGreaterThan(1);

    expect(
      manager.updateActiveGoal("edit-goal", {
        objective: "stale overwrite",
        expectedGoalId: "goal-1",
        expectedRevision: 7,
      }),
    ).toBeUndefined();
    expect(manager.readActiveGoal("edit-goal")).toEqual(edited?.goal);
  });

  test("pause and resume are revision-fenced updates of the same goal", () => {
    seedGoal("pause-goal");

    const paused = manager.updateActiveGoal("pause-goal", {
      paused: true,
      expectedGoalId: "goal-1",
      expectedRevision: 7,
    });
    expect(paused?.goal).toMatchObject({
      objective: "original objective",
      goalId: "goal-1",
      revision: 8,
      paused: true,
    });

    expect(
      manager.updateActiveGoal("pause-goal", {
        paused: false,
        expectedGoalId: "goal-1",
        expectedRevision: 7,
      }),
    ).toBeUndefined();
    expect(manager.readActiveGoal("pause-goal")?.paused).toBe(true);

    const resumed = manager.updateActiveGoal("pause-goal", {
      paused: false,
      expectedGoalId: "goal-1",
      expectedRevision: 8,
    });
    expect(resumed?.goal).toMatchObject({
      objective: "original objective",
      goalId: "goal-1",
      revision: 9,
    });
    expect(resumed?.goal.paused).toBeUndefined();
  });

  test("delete requires the current goalId and revision and records that version", () => {
    seedGoal("delete-goal");
    const paused = manager.updateActiveGoal("delete-goal", {
      paused: true,
      expectedGoalId: "goal-1",
      expectedRevision: 7,
    });
    expect(paused?.goal.revision).toBe(8);

    expect(manager.clearActiveGoal("delete-goal", { goalId: "goal-1", revision: 7 })).toBe(false);
    expect(manager.clearActiveGoal("delete-goal", { goalId: "different-goal", revision: 8 })).toBe(
      false,
    );
    expect(manager.readActiveGoal("delete-goal")?.revision).toBe(8);

    expect(manager.clearActiveGoal("delete-goal", { goalId: "goal-1", revision: 8 })).toBe(true);
    expect(manager.readActiveGoal("delete-goal")).toBeUndefined();
    const lifecycle = manager.resume("delete-goal").state.goalLifecycle;
    expect(lifecycle?.phase).toBe("terminal");
    if (lifecycle?.phase !== "terminal") throw new Error("expected terminal Goal lifecycle");
    expect(lifecycle).toMatchObject({ goalId: "goal-1", revision: 8 });
    expect(lifecycle.terminal.reason).toBe("user_cleared");
  });
});
