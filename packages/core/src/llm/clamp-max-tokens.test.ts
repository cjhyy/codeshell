import { describe, it, expect } from "bun:test";
import { clampMaxTokens } from "./clamp-max-tokens.js";

describe("clampMaxTokens", () => {
  it("clamps a too-large request down to the model's output cap", () => {
    // The deepseek bleed: a stale 384000 reaching a 128k-cap model.
    expect(clampMaxTokens(384_000, 128_000)).toBe(128_000);
  });

  it("leaves a request within the cap untouched", () => {
    expect(clampMaxTokens(8_192, 128_000)).toBe(8_192);
  });

  it("passes the request through unchanged when no cap is known", () => {
    expect(clampMaxTokens(384_000, undefined)).toBe(384_000);
  });

  it("returns undefined when there is no request value (omit the field)", () => {
    expect(clampMaxTokens(undefined, 128_000)).toBeUndefined();
    expect(clampMaxTokens(undefined, undefined)).toBeUndefined();
  });
});
