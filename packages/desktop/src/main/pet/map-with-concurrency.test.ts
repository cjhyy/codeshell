import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "./map-with-concurrency.js";

describe("mapWithConcurrency", () => {
  test("returns results in input order regardless of settle order", async () => {
    const delays = [30, 5, 20, 1];
    const results = await mapWithConcurrency(delays, 2, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${index}:${ms}`;
    });
    expect(results).toEqual(["0:30", "1:5", "2:20", "3:1"]);
  });

  test("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test("runs every item exactly once", async () => {
    const seen: number[] = [];
    const items = [1, 2, 3, 4, 5, 6, 7];
    const results = await mapWithConcurrency(items, 4, async (value) => {
      seen.push(value);
      return value * 2;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });

  test("handles an empty input", async () => {
    const results = await mapWithConcurrency([], 4, async (value) => value);
    expect(results).toEqual([]);
  });

  test("a limit larger than the input still completes all items", async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (value) => value + 1);
    expect(results).toEqual([2, 3]);
  });
});
