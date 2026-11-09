import { describe, expect, test } from "bun:test";
import { adoptPersistedGoalProgress, goalElapsedMs } from "./goalClock";
import type { ActiveGoal } from "./types";

const goal: ActiveGoal = { objective: "g", goalId: "g1", revision: 1, round: 0, paused: false };

describe("adoptPersistedGoalProgress", () => {
  test("a cold open adopts persisted totals and keeps an open background wait running", () => {
    const adopted = adoptPersistedGoalProgress(goal, {
      rounds: 14,
      activeMs: 600_000,
      runningSinceMs: 1_000,
    })!;
    expect(adopted).toMatchObject({ round: 14, activeMs: 600_000, clockSinceMs: 1_000 });
    expect(goalElapsedMs(adopted, 61_000)).toBe(660_000);
  });

  test("a stopped goal shows its settled time; a paused one never ticks", () => {
    expect(adoptPersistedGoalProgress(goal, { rounds: 2, activeMs: 5_000 })).toMatchObject({
      round: 2,
      activeMs: 5_000,
      clockSinceMs: undefined,
    });
    const paused = adoptPersistedGoalProgress(
      { ...goal, paused: true },
      { rounds: 2, activeMs: 5_000, runningSinceMs: 1 },
    )!;
    expect(goalElapsedMs(paused, 999_999)).toBe(5_000);
    const asking = adoptPersistedGoalProgress(
      { ...goal, waitingForUser: "要发布吗？" },
      { rounds: 2, activeMs: 5_000, runningSinceMs: 1 },
    )!;
    expect(asking.clockSinceMs).toBeUndefined();
    expect(goalElapsedMs(asking, 999_999)).toBe(5_000);
  });

  test("an in-flight run keeps its replayed clock; the higher round wins", () => {
    const running = { ...goal, round: 9, activeMs: 50_000, clockSinceMs: 100 };
    expect(adoptPersistedGoalProgress(running, { rounds: 8, activeMs: 40_000 })).toBe(running);
    const waiting = { ...running, waitingBackground: true };
    expect(adoptPersistedGoalProgress(waiting, { rounds: 8, activeMs: 70_000 })).toMatchObject({
      round: 9,
      activeMs: 70_000,
    });
    expect(adoptPersistedGoalProgress(null, { rounds: 1, activeMs: 1 })).toBeNull();
  });
});
