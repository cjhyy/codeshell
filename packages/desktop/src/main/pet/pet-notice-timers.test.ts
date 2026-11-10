import { describe, expect, test } from "bun:test";
import { KeyedTimers } from "./pet-notice-timers.js";

function fakeClock() {
  let now = 1_000;
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout: (run: () => void, delay: number) => {
      const timer = { at: now + delay, run };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: unknown) => void timers.delete(timer as never),
    count: () => timers.size,
    advance: (to: number) => {
      now = to;
      for (const timer of [...timers].sort((a, b) => a.at - b.at))
        if (timer.at <= to) {
          timers.delete(timer);
          timer.run();
        }
    },
  };
}

describe("KeyedTimers", () => {
  test("one timer per key, fired once at its instant", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    const timers = new KeyedTimers((key) => fired.push(key), clock.now, clock);
    timers.set("a", 2_000);
    timers.set("a", 2_000);
    timers.set("b", 3_000);
    expect(clock.count()).toBe(2);
    clock.advance(2_500);
    expect(fired).toEqual(["a"]);
    clock.advance(10_000);
    expect(fired).toEqual(["a", "b"]);
    expect(clock.count()).toBe(0);
  });

  test("a new instant re-arms the key; clear and clearAll cancel", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    const timers = new KeyedTimers((key) => fired.push(key), clock.now, clock);
    timers.set("a", 5_000);
    timers.set("a", 2_000);
    expect(clock.count()).toBe(1);
    timers.set("b", 3_000);
    timers.clear("b");
    timers.set("c", 4_000);
    timers.clearAll();
    clock.advance(10_000);
    expect(fired).toEqual([]);
    timers.set("a", 11_000);
    clock.advance(11_000);
    expect(fired).toEqual(["a"]);
  });

  test("an instant already past fires on the next turn of the scheduler", () => {
    const clock = fakeClock();
    const delays: number[] = [];
    const timers = new KeyedTimers(() => undefined, clock.now, {
      setTimeout: (run, delay) => {
        delays.push(delay);
        return clock.setTimeout(run, delay);
      },
      clearTimeout: clock.clearTimeout,
    });
    timers.set("late", 500);
    expect(delays).toEqual([0]);
  });
});
