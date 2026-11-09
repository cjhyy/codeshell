import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "../types.js";
import { GoalProgressMeter } from "./progress-meter.js";

function marker(status: "not_met" | "met" | "approaching_limit" | "exhausted", round = 1) {
  return { type: "goal_progress", goalId: "g1", status, round } as StreamEvent;
}

describe("GoalProgressMeter", () => {
  test("numbers markers per goal across runs instead of per run", () => {
    let now = 1_000;
    const persisted = { rounds: 0, activeMs: 0 };
    const runOnce = (markers: StreamEvent[], runMs: number) => {
      const meter = new GoalProgressMeter(
        () => ({ ...persisted }),
        () => now,
      );
      meter.begin("g1");
      const decorated = markers.map((event) => {
        now += runMs / markers.length;
        return meter.decorate(event);
      });
      for (const delta of meter.drain()) {
        persisted.rounds += delta.rounds;
        persisted.activeMs += delta.activeMs;
      }
      return decorated;
    };

    // TurnLoop restarts its own count each run (the "第 1 轮" bug).
    const first = runOnce([marker("not_met", 1), marker("not_met", 1)], 60_000);
    const second = runOnce([marker("not_met", 1)], 30_000);
    expect(first.map((e) => (e as { round: number }).round)).toEqual([1, 2]);
    expect(second).toMatchObject([
      { round: 3, progress: { rounds: 3, activeMs: 90_000, atMs: now } },
    ]);
    expect(persisted).toEqual({ rounds: 3, activeMs: 90_000 });
  });

  test("restating markers do not add a round; other events and sub-agents pass through", () => {
    const meter = new GoalProgressMeter(
      () => ({ rounds: 5, activeMs: 0 }),
      () => 0,
    );
    expect(meter.decorate(marker("approaching_limit"))).toMatchObject({ round: 5 });
    expect(meter.decorate(marker("exhausted"))).toMatchObject({ round: 5 });
    expect(meter.decorate(marker("met"))).toMatchObject({ round: 6 });
    const child = { ...marker("not_met"), agentId: "child" } as StreamEvent;
    expect(meter.decorate(child)).toBe(child);
    const legacy = { type: "goal_progress", status: "not_met", round: 1 } as StreamEvent;
    expect(meter.decorate(legacy)).toBe(legacy);
    const text = { type: "text_delta", text: "x" } as StreamEvent;
    expect(meter.decorate(text)).toBe(text);
    expect(meter.drain()).toEqual([{ goalId: "g1", rounds: 1, activeMs: 0 }]);
    expect(meter.drain()).toEqual([]);
  });

  test("a goal set mid-run gets its own base and clock", () => {
    let now = 0;
    const bases: Record<string, { rounds: number; activeMs: number }> = {
      old: { rounds: 7, activeMs: 1 },
    };
    const meter = new GoalProgressMeter(
      (id) => bases[id],
      () => now,
    );
    meter.begin("old");
    now = 10;
    const next = meter.decorate({
      type: "goal_progress",
      goalId: "new",
      status: "not_met",
      round: 1,
    } as StreamEvent);
    expect(next).toMatchObject({ round: 1, progress: { rounds: 1, activeMs: 0 } });
    now = 25;
    expect(meter.drain()).toEqual([
      { goalId: "old", rounds: 0, activeMs: 25 },
      { goalId: "new", rounds: 1, activeMs: 15 },
    ]);
  });

  test("a user-wait marker freezes accounting before delayed run teardown", () => {
    let now = 1_000;
    const meter = new GoalProgressMeter(
      () => ({ rounds: 4, activeMs: 10_000 }),
      () => now,
    );
    meter.begin("g1");
    now = 3_000;
    expect(
      meter.decorate({ ...marker("not_met"), waitingForUser: "继续吗？" } as StreamEvent),
    ).toMatchObject({ progress: { rounds: 5, activeMs: 12_000 } });
    now = 603_000;
    expect(meter.drain()).toEqual([{ goalId: "g1", rounds: 1, activeMs: 2_000 }]);
  });

  test("manual pause and in-place resume accumulate only the active segments", () => {
    let now = 1_000;
    const meter = new GoalProgressMeter(
      () => undefined,
      () => now,
    );
    meter.begin("g1");
    now = 3_000;
    meter.pause("g1");
    now = 63_000;
    meter.pause("g1"); // Repeated control delivery must not add idle time.
    meter.begin("g1");
    now = 65_000;
    expect(meter.decorate(marker("not_met"))).toMatchObject({
      progress: { rounds: 1, activeMs: 4_000 },
    });
    meter.pause("g1");
    now = 665_000;
    expect(meter.drain()).toEqual([{ goalId: "g1", rounds: 1, activeMs: 4_000 }]);
  });

  test("background park hands the clock over without counting teardown twice", () => {
    let now = 1_000;
    const meter = new GoalProgressMeter(
      () => undefined,
      () => now,
    );
    meter.begin("g1");
    now = 4_000;
    const parked = meter.decorate({
      ...marker("not_met"),
      waiting: { kind: "background_work", sinceMs: 3_000 },
    } as StreamEvent);
    expect(parked).toMatchObject({ progress: { activeMs: 2_000 } });
    now = 604_000;
    expect(meter.drain()).toEqual([{ goalId: "g1", rounds: 1, activeMs: 2_000 }]);
  });
});
