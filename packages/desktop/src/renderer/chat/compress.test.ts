import { describe, expect, test } from "bun:test";
import {
  scaledDimensions,
  MAX_DIMENSION,
  TARGET_BYTES,
  capForDetail,
  alwaysDownsample,
  type ImageDetail,
} from "./compress";

/**
 * Only `scaledDimensions` is unit-testable in pure Node — the rest of
 * compress.ts depends on `document.createElement("canvas")` which we
 * don't fake here. The interesting bug surface is the aspect-ratio math
 * (off-by-one rounding for landscape vs portrait), so that's what we
 * pin down.
 */

describe("scaledDimensions", () => {
  test("passes through when both sides fit under the cap", () => {
    expect(scaledDimensions(1024, 768, 2048)).toEqual({ width: 1024, height: 768 });
    expect(scaledDimensions(2048, 2048, 2048)).toEqual({ width: 2048, height: 2048 });
  });

  test("clamps landscape on the long edge", () => {
    // 4000×2000 → cap 2048: long edge → 2048, short edge → 1024.
    expect(scaledDimensions(4000, 2000, 2048)).toEqual({ width: 2048, height: 1024 });
  });

  test("clamps portrait on the long edge", () => {
    // 2000×4000 → cap 2048: long edge → 2048, short edge → 1024.
    expect(scaledDimensions(2000, 4000, 2048)).toEqual({ width: 1024, height: 2048 });
  });

  test("clamps square correctly", () => {
    expect(scaledDimensions(4096, 4096, 2048)).toEqual({ width: 2048, height: 2048 });
  });

  test("preserves aspect ratio within one pixel (rounding-tolerant)", () => {
    // A weird ratio that rounds to a non-integer.
    const { width, height } = scaledDimensions(5123, 2718, 2048);
    expect(width).toBe(2048);
    // 2048 * 2718/5123 ≈ 1086.6 → 1087.
    expect(height).toBe(1087);
    expect(Math.abs(width / height - 5123 / 2718)).toBeLessThan(0.01);
  });
});

describe("constants are sane defaults", () => {
  test("TARGET_BYTES matches the engine's per-image cap", () => {
    expect(TARGET_BYTES).toBe(2 * 1024 * 1024);
  });
  test("MAX_DIMENSION is the documented 2048", () => {
    expect(MAX_DIMENSION).toBe(2048);
  });
});

describe("capForDetail — per-clarity-level long-edge cap", () => {
  test("low/标准/高清 map to 1024 / 1568 / 2576", () => {
    expect(capForDetail("low")).toBe(1024);
    expect(capForDetail("standard")).toBe(1568);
    expect(capForDetail("high")).toBe(2576);
  });
  test("unknown / undefined falls back to high (no surprise downscale)", () => {
    expect(capForDetail(undefined)).toBe(2576);
    expect(capForDetail("garbage" as ImageDetail)).toBe(2576);
  });
});

describe("alwaysDownsample — whether to re-encode even small images", () => {
  // low/standard intentionally downsample EVERY image (that's how they save
  // tokens — a 1.5MB 3000px screenshot is under the byte gate but still costs
  // ~4784 tokens on Opus). high preserves fidelity: only compress if oversize.
  test("low and standard always downsample", () => {
    expect(alwaysDownsample("low")).toBe(true);
    expect(alwaysDownsample("standard")).toBe(true);
  });
  test("high (and default) only compress when oversize", () => {
    expect(alwaysDownsample("high")).toBe(false);
    expect(alwaysDownsample(undefined)).toBe(false);
  });
});
