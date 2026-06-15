/**
 * Param projection — applyParams (paramValues → request body via wire.field)
 * and buildParamsDoc (params[] → natural-language note injected into tools).
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §4/§6.
 */
import { describe, test, expect } from "bun:test";
import { applyParams, buildParamsDoc } from "./params.js";
import type { ParamSpec } from "./types.js";

describe("applyParams", () => {
  test("lands an enum value on its wire.field", () => {
    const params: ParamSpec[] = [
      { name: "reasoning", control: "enum", options: ["low", "high"], wire: { field: "reasoning_effort" } },
    ];
    expect(applyParams({ reasoning: "high" }, params)).toEqual({ reasoning_effort: "high" });
  });

  test("lands a nested wire.field as a deep object", () => {
    const params: ParamSpec[] = [
      { name: "reasoning", control: "number", min: 1024, wire: { field: "thinking.budget_tokens" } },
    ];
    expect(applyParams({ reasoning: 8192 }, params)).toEqual({
      thinking: { budget_tokens: 8192 },
    });
  });

  test("falls back to param name when no wire is given", () => {
    const params: ParamSpec[] = [{ name: "temperature", control: "number" }];
    expect(applyParams({ temperature: 0.7 }, params)).toEqual({ temperature: 0.7 });
  });

  test("omits params the user didn't set", () => {
    const params: ParamSpec[] = [
      { name: "reasoning", control: "enum", options: ["low"], wire: { field: "reasoning_effort" } },
      { name: "verbosity", control: "enum", options: ["low"], wire: { field: "verbosity" } },
    ];
    expect(applyParams({ reasoning: "low" }, params)).toEqual({ reasoning_effort: "low" });
  });

  test("ignores paramValues with no matching spec", () => {
    const params: ParamSpec[] = [{ name: "reasoning", control: "enum", options: ["low"] }];
    expect(applyParams({ ghost: "x" }, params)).toEqual({});
  });

  test("empty params or values → empty body", () => {
    expect(applyParams({}, [])).toEqual({});
    expect(applyParams({ a: 1 }, [])).toEqual({});
  });
});

describe("buildParamsDoc", () => {
  test("joins each param's doc into a note", () => {
    const params: ParamSpec[] = [
      { name: "size", control: "enum", options: ["1024x1024"], doc: "Output dimensions." },
      { name: "quality", control: "enum", options: ["high"], doc: "Render quality." },
    ];
    const doc = buildParamsDoc(params);
    expect(doc).toContain("Output dimensions.");
    expect(doc).toContain("Render quality.");
  });

  test("includes the enum options so the agent knows allowed values", () => {
    const params: ParamSpec[] = [
      { name: "reasoning", control: "enum", options: ["low", "medium", "high"], doc: "Thinking depth." },
    ];
    const doc = buildParamsDoc(params);
    expect(doc).toContain("reasoning");
    expect(doc).toContain("low");
    expect(doc).toContain("high");
  });

  test("returns empty string for no params", () => {
    expect(buildParamsDoc([])).toBe("");
    expect(buildParamsDoc(undefined)).toBe("");
  });
});
