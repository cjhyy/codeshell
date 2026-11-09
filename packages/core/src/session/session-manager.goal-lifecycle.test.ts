import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

describe("SessionManager GoalLifecycleV1 migration", () => {
  let dir: string;
  let manager: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "goal-lifecycle-v1-"));
    manager = new SessionManager(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function statePath(sessionId: string): string {
    return join(dir, sessionId, "state.json");
  }

  function raw(sessionId: string): Record<string, unknown> {
    return JSON.parse(readFileSync(statePath(sessionId), "utf8")) as Record<string, unknown>;
  }

  test("new writers persist only the canonical versioned union", () => {
    const { state } = manager.create("/repo", "model", "provider", "canonical");
    state.activeGoal = { objective: "ship", goalId: "goal-a", revision: 2, paused: true };
    expect(manager.saveState(state)).toBe(true);

    expect(raw("canonical")).toMatchObject({
      goalLifecycle: {
        version: 1,
        goalId: "goal-a",
        revision: 2,
        phase: "paused",
        config: { objective: "ship" },
      },
    });
    expect(raw("canonical")).not.toHaveProperty("activeGoal");
    expect(raw("canonical")).not.toHaveProperty("goalTerminal");
    expect(raw("canonical")).not.toHaveProperty("goalTerminals");
  });

  test("legacy active state is read without a write and migrates on the next domain update", () => {
    const { state } = manager.create("/repo", "model", "provider", "legacy-active");
    const legacy = raw("legacy-active");
    legacy.activeGoal = { objective: "legacy", setAtMs: 10 };
    delete legacy.goalLifecycle;
    writeFileSync(statePath("legacy-active"), JSON.stringify(legacy, null, 2));

    expect(manager.readActiveGoal("legacy-active")).toMatchObject({ objective: "legacy" });
    expect(raw("legacy-active")).not.toHaveProperty("goalLifecycle");

    manager.updateSessionState("legacy-active", { summary: "migrated" });
    expect(raw("legacy-active")).toMatchObject({
      summary: "migrated",
      goalLifecycle: { version: 1, phase: "active", config: { objective: "legacy" } },
    });
    expect(raw("legacy-active")).not.toHaveProperty("activeGoal");
    state.summary = "unused";
  });

  test("a matching legacy terminal migrates fail-closed as terminal", () => {
    manager.create("/repo", "model", "provider", "legacy-terminal");
    const legacy = raw("legacy-terminal");
    legacy.activeGoal = { objective: "done", setAtMs: 20 };
    legacy.goalTerminal = {
      objective: "done",
      setAtMs: 20,
      reason: "completed",
      terminatedAtMs: 30,
    };
    writeFileSync(statePath("legacy-terminal"), JSON.stringify(legacy, null, 2));

    expect(manager.readActiveGoal("legacy-terminal")).toBeUndefined();
    manager.updateSessionState("legacy-terminal", { summary: "terminal" });
    expect(raw("legacy-terminal")).toMatchObject({
      goalLifecycle: {
        version: 1,
        phase: "terminal",
        terminal: { reason: "completed", atMs: 30 },
      },
    });
  });

  test("valid lifecycle wins over stale aliases", () => {
    const { state } = manager.create("/repo", "model", "provider", "canonical-wins");
    state.activeGoal = { objective: "canonical", goalId: "goal-a" };
    manager.saveState(state);
    const mixed = raw("canonical-wins");
    mixed.activeGoal = { objective: "stale", goalId: "goal-stale" };
    writeFileSync(statePath("canonical-wins"), JSON.stringify(mixed, null, 2));

    expect(manager.readActiveGoal("canonical-wins")).toMatchObject({
      objective: "canonical",
      goalId: "goal-a",
    });
    manager.updateSessionState("canonical-wins", { summary: "clean" });
    expect(raw("canonical-wins")).not.toHaveProperty("activeGoal");
  });

  test("finite background waiting re-arms with the same identity", () => {
    const { state } = manager.create("/repo", "model", "provider", "waiting");
    const goal = { objective: "wait for render", goalId: "goal-wait", revision: 4 };
    state.activeGoal = goal;
    expect(manager.saveState(state)).toBe(true);
    expect(manager.markGoalWaiting(state, goal)).toBe(true);
    expect(raw("waiting")).toMatchObject({
      goalLifecycle: { phase: "waiting", goalId: "goal-wait", revision: 4 },
    });

    expect(
      manager.saveActiveGoal(state, goal, {
        expectedGoalId: goal.goalId,
        expectedRevision: goal.revision,
      }),
    ).toBe(true);
    expect(raw("waiting")).toMatchObject({
      goalLifecycle: { phase: "active", goalId: "goal-wait", revision: 4 },
    });
  });

  test("a fenced waiting re-arm cannot overwrite a newer revision of the same Goal", () => {
    const { state } = manager.create("/repo", "model", "provider", "waiting-edited");
    const goal = { objective: "wait for render", goalId: "goal-wait", revision: 4 };
    expect(manager.saveActiveGoal(state, goal)).toBe(true);
    expect(manager.markGoalWaiting(state, goal)).toBe(true);
    expect(
      manager.updateActiveGoal("waiting-edited", {
        objective: "revised render",
        expectedGoalId: goal.goalId,
        expectedRevision: goal.revision,
      }),
    ).toBeDefined();
    const before = readFileSync(statePath("waiting-edited"), "utf8");

    expect(
      manager.saveActiveGoal(state, goal, {
        expectedGoalId: goal.goalId,
        expectedRevision: goal.revision,
      }),
    ).toBe(false);
    expect(readFileSync(statePath("waiting-edited"), "utf8")).toBe(before);
    expect(state.goalLifecycle).toMatchObject({
      phase: "active",
      revision: 5,
      config: { objective: "revised render" },
    });
  });

  test("goal progress survives edits and re-arms; background waits count, user waits do not", () => {
    const { state } = manager.create("/repo", "model", "provider", "progress");
    const goal = { objective: "长期目标", goalId: "goal-p", revision: 1 };
    const backdateWait = (ms: number) => {
      const persisted = raw("progress");
      (persisted.goalLifecycle as { waitingSinceMs: number }).waitingSinceMs = Date.now() - ms;
      writeFileSync(statePath("progress"), JSON.stringify(persisted, null, 2));
    };
    expect(manager.saveActiveGoal(state, goal)).toBe(true);
    expect(manager.recordGoalProgress(state, "goal-p", { rounds: 2, activeMs: 5_000 })).toBe(true);

    // An edit bumps the revision but keeps the same goal's totals, and a run
    // that started before the edit still records into the same goal.
    const edited = manager.updateActiveGoal("progress", {
      objective: "改过的目标",
      expectedGoalId: "goal-p",
      expectedRevision: 1,
    })!;
    expect(raw("progress")).toMatchObject({
      goalLifecycle: { revision: 2, progress: { rounds: 2, activeMs: 5_000 } },
    });
    expect(manager.recordGoalProgress(state, "goal-p", { rounds: 1, activeMs: 1_000 })).toBe(true);

    // A background wait runs the clock until the wake re-arms the goal.
    expect(manager.markGoalWaiting(state, edited.goal, "background")).toBe(true);
    backdateWait(60_000);
    expect(manager.readGoalProgress("progress")).toMatchObject({
      goalId: "goal-p",
      rounds: 3,
      activeMs: 6_000,
      runningSinceMs: expect.any(Number),
    });
    const rearm = { expectedGoalId: "goal-p", expectedRevision: 2 };
    expect(manager.saveActiveGoal(state, edited.goal, rearm)).toBe(true);
    const afterBackground = manager.readGoalProgress("progress")!.activeMs;
    expect(afterBackground).toBeGreaterThanOrEqual(66_000);
    expect(afterBackground).toBeLessThan(76_000);

    // Waiting for the user's reply is idle time and does not count.
    expect(manager.markGoalWaiting(state, edited.goal, "user")).toBe(true);
    expect(raw("progress")).toMatchObject({
      goalLifecycle: { phase: "waiting", waitKind: "user" },
    });
    backdateWait(600_000);
    expect(manager.saveActiveGoal(state, edited.goal, rearm)).toBe(true);
    expect(manager.readGoalProgress("progress")!.activeMs).toBe(afterBackground);

    // A replacement goal starts from zero and drops a late delta of the old one.
    const replacement = { objective: "新目标", goalId: "goal-q", revision: 1 };
    expect(manager.saveActiveGoal(state, replacement, { replaceCurrent: true })).toBe(true);
    expect(manager.recordGoalProgress(state, "goal-p", { rounds: 1 })).toBe(false);
    expect(manager.readGoalProgress("progress")).toEqual({
      goalId: "goal-q",
      rounds: 0,
      activeMs: 0,
    });
  });

  test("unknown versions fail closed and are not overwritten", () => {
    manager.create("/repo", "model", "provider", "future");
    const future = raw("future");
    future.goalLifecycle = {
      version: 99,
      goalId: "future-goal",
      phase: "active",
      config: { objective: "future" },
    };
    writeFileSync(statePath("future"), JSON.stringify(future, null, 2));
    const before = readFileSync(statePath("future"), "utf8");

    expect(manager.readActiveGoal("future")).toBeUndefined();
    expect(() => manager.updateSessionState("future", { summary: "must not write" })).toThrow(
      /goal lifecycle/i,
    );
    expect(readFileSync(statePath("future"), "utf8")).toBe(before);
  });
});
