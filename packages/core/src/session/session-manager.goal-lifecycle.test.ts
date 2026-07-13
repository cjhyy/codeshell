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

    expect(manager.saveActiveGoal(state, goal)).toBe(true);
    expect(raw("waiting")).toMatchObject({
      goalLifecycle: { phase: "active", goalId: "goal-wait", revision: 4 },
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
