import { describe, it, expect } from "bun:test";
import { clampContextRatios } from "./compaction.js";

describe("clampContextRatios", () => {
  it("passes through a valid floor < compact < summarize ordering", () => {
    expect(
      clampContextRatios({
        microcompactFloorRatio: 0.7,
        compactAtRatio: 0.85,
        summarizeAtRatio: 0.92,
      }),
    ).toEqual({
      compactAtRatio: 0.85,
      summarizeAtRatio: 0.92,
      microcompactFloorRatio: 0.7,
    });
  });

  it("pulls summarize up to compact when configured below it", () => {
    const out = clampContextRatios({
      compactAtRatio: 0.9,
      summarizeAtRatio: 0.8, // user mistake: below compact
    });
    expect(out.compactAtRatio).toBe(0.9);
    expect(out.summarizeAtRatio).toBe(0.9); // clamped up
  });

  it("pushes floor down to compact when configured above it", () => {
    const out = clampContextRatios({
      compactAtRatio: 0.6,
      microcompactFloorRatio: 0.8, // user mistake: above compact
    });
    expect(out.compactAtRatio).toBe(0.6);
    expect(out.microcompactFloorRatio).toBe(0.6); // clamped down
  });

  it("leaves summarize/floor untouched when compact is absent (no anchor)", () => {
    const out = clampContextRatios({
      summarizeAtRatio: 0.5,
      microcompactFloorRatio: 0.9,
    });
    expect(out.compactAtRatio).toBeUndefined();
    expect(out.summarizeAtRatio).toBe(0.5);
    expect(out.microcompactFloorRatio).toBe(0.9);
  });

  it("returns all-undefined for an empty input (manager keeps its defaults)", () => {
    expect(clampContextRatios({})).toEqual({
      compactAtRatio: undefined,
      summarizeAtRatio: undefined,
      microcompactFloorRatio: undefined,
    });
  });

  it("allows a high compact ratio for large-window models", () => {
    const out = clampContextRatios({
      compactAtRatio: 0.95,
      summarizeAtRatio: 0.97,
      microcompactFloorRatio: 0.9,
    });
    expect(out).toEqual({
      compactAtRatio: 0.95,
      summarizeAtRatio: 0.97,
      microcompactFloorRatio: 0.9,
    });
  });
});
