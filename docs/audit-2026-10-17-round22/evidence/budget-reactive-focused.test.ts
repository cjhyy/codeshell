import { describe, expect, test } from "bun:test";
import { crossedReactiveThreshold } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/engine/reactive-threshold.ts";

describe("round22 actual reactive threshold ordinary controls", () => {
  test("exact positive boundaries trigger and return the new bucket", () => {
    const first = crossedReactiveThreshold(2000, -1);
    expect(first).toEqual({ crossed: true, bucket: 1 });
    expect(crossedReactiveThreshold(4000, first.bucket)).toEqual({ crossed: true, bucket: 2 });
  });

  test("a large ordinary chunk triggers once at its latest bucket", () => {
    const jump = crossedReactiveThreshold(6500, -1);
    expect(jump).toEqual({ crossed: true, bucket: 3 });
    expect(crossedReactiveThreshold(6500, jump.bucket)).toEqual({ crossed: false, bucket: 3 });
    expect(crossedReactiveThreshold(7999, jump.bucket)).toEqual({ crossed: false, bucket: 3 });
    expect(crossedReactiveThreshold(8000, jump.bucket)).toEqual({ crossed: true, bucket: 4 });
  });

  test("a monotonic nondivisible sequence does not miss or duplicate crossed buckets", () => {
    let bucket = -1;
    const crossings: number[] = [];
    for (let accumulated = 333; accumulated <= 4995; accumulated += 333) {
      const probe = crossedReactiveThreshold(accumulated, bucket);
      if (probe.crossed) {
        bucket = probe.bucket;
        crossings.push(accumulated);
      }
    }
    expect(crossings).toEqual([2331, 4329]);
    expect(bucket).toBe(2);
  });

  test("fresh owned counters independently report the same first crossing", () => {
    expect(crossedReactiveThreshold(1999, -1)).toEqual({ crossed: false, bucket: -1 });
    expect(crossedReactiveThreshold(2000, -1)).toEqual({ crossed: true, bucket: 1 });
    expect(crossedReactiveThreshold(2000, -1)).toEqual({ crossed: true, bucket: 1 });
  });
});
