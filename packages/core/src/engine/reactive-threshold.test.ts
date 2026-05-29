import { describe, it, expect } from "bun:test";
import { crossedReactiveThreshold } from "./reactive-threshold.js";

/**
 * The old check was `streamingResponseTokens % 2000 === 0`, which a running
 * `+= ceil(len/4)` accumulator essentially never hits exactly — so the
 * reactive-compaction probe never fired. The replacement fires once per 2000
 * tokens crossed, tracking the last bucket it fired in.
 */
describe("crossedReactiveThreshold", () => {
  it("fires the first time the accumulator passes 2000", () => {
    expect(crossedReactiveThreshold(1999, -1)).toEqual({ crossed: false, bucket: -1 });
    expect(crossedReactiveThreshold(2050, -1)).toEqual({ crossed: true, bucket: 1 });
  });

  it("does not re-fire within the same 2000 bucket", () => {
    expect(crossedReactiveThreshold(2500, 1)).toEqual({ crossed: false, bucket: 1 });
  });

  it("fires again when the next 2000 boundary is crossed", () => {
    expect(crossedReactiveThreshold(4001, 1)).toEqual({ crossed: true, bucket: 2 });
  });

  it("never fires below the first boundary", () => {
    expect(crossedReactiveThreshold(0, -1)).toEqual({ crossed: false, bucket: -1 });
    expect(crossedReactiveThreshold(100, -1)).toEqual({ crossed: false, bucket: -1 });
  });
});
