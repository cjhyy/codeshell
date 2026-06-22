import { describe, test, expect } from "bun:test";
import {
  ReasoningSettingSchema,
  normalizeReasoning,
  type ReasoningSetting,
} from "./reasoning-setting.js";

describe("ReasoningSettingSchema", () => {
  test("accepts each mode", () => {
    const cases: ReasoningSetting[] = [
      { mode: "off" },
      { mode: "on" },
      { mode: "effort", effort: "high" },
      { mode: "budget", budgetTokens: 4096 },
    ];
    for (const c of cases) expect(ReasoningSettingSchema.parse(c)).toEqual(c);
  });
  test("rejects unknown mode", () => {
    expect(() => ReasoningSettingSchema.parse({ mode: "nope" })).toThrow();
  });
  test("accepts any non-empty effort string (free-form, catalog-driven)", () => {
    // effort is NOT a closed enum — a model's real ladder is declared by its
    // catalog ParamSpec and drifts over time ("xhigh", "max", future levels).
    // The schema validates shape, not value; pinning to an enum took the app
    // down on boot when an unknown level flowed through the models[] bridge.
    for (const effort of ["max", "ultra", "none"]) {
      expect(ReasoningSettingSchema.parse({ mode: "effort", effort })).toEqual({ mode: "effort", effort });
    }
  });
  test("still rejects effort mode with an empty/missing level (shape check kept)", () => {
    expect(() => ReasoningSettingSchema.parse({ mode: "effort", effort: "" })).toThrow();
    expect(() => ReasoningSettingSchema.parse({ mode: "effort" })).toThrow();
  });
  test("accepts xhigh effort", () => {
    expect(ReasoningSettingSchema.parse({ mode: "effort", effort: "xhigh" })).toEqual({
      mode: "effort",
      effort: "xhigh",
    });
  });
});

describe("normalizeReasoning (back-compat for legacy enabled/disabled)", () => {
  test("undefined → undefined", () => {
    expect(normalizeReasoning(undefined)).toBeUndefined();
  });
  test('legacy "enabled" → {mode:"on"}', () => {
    expect(normalizeReasoning("enabled" as any)).toEqual({ mode: "on" });
  });
  test('legacy "disabled" → {mode:"off"}', () => {
    expect(normalizeReasoning("disabled" as any)).toEqual({ mode: "off" });
  });
  test("a ReasoningSetting object passes through", () => {
    expect(normalizeReasoning({ mode: "effort", effort: "low" })).toEqual({
      mode: "effort",
      effort: "low",
    });
  });
});
