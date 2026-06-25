import { describe, expect, test } from "bun:test";
import { clampPtyDim } from "./pty-service.js";

// Footgun: ptyResize used Math.max(1, cols), but Math.max(1, NaN) === NaN, so a
// malformed IPC resize (cols=NaN / Infinity / <1) reached node-pty.resize as a
// bad dimension → native throw / misbehavior. clampPtyDim floors any non-finite
// or sub-1 value to 1.
describe("clampPtyDim", () => {
  test("passes through valid positive dimensions (floored to int)", () => {
    expect(clampPtyDim(80)).toBe(80);
    expect(clampPtyDim(24)).toBe(24);
    expect(clampPtyDim(120.7)).toBe(120);
  });

  test("NaN / Infinity floor to 1 (no NaN to node-pty)", () => {
    expect(clampPtyDim(Number.NaN)).toBe(1);
    expect(clampPtyDim(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampPtyDim(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  test("zero / negative floor to 1", () => {
    expect(clampPtyDim(0)).toBe(1);
    expect(clampPtyDim(-5)).toBe(1);
    expect(clampPtyDim(0.5)).toBe(1);
  });
});
