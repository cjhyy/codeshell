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
  test("rejects effort without a valid level", () => {
    expect(() => ReasoningSettingSchema.parse({ mode: "effort", effort: "ultra" })).toThrow();
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
