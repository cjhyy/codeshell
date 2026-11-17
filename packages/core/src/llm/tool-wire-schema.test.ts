import { describe, expect, it } from "bun:test";
import { skillToolDef } from "../tool-system/builtin/skill.js";
import { resolvePromptCachePolicy } from "./prompt-cache.js";
import { anthropicTools } from "./providers/anthropic-discovery-wire.js";
import { wireToolInputSchema } from "./tool-wire-schema.js";

const COMBINATORS = ["oneOf", "anyOf", "allOf", "not"];

describe("wireToolInputSchema", () => {
  it("drops top-level combinators and keeps everything else", () => {
    const schema = {
      type: "object",
      properties: { a: { anyOf: [{ type: "string" }, { type: "number" }] } },
      required: ["a"],
      oneOf: [{ required: ["a"] }],
      anyOf: [{ required: ["a"] }],
      allOf: [{ required: ["a"] }],
      not: { required: ["b"] },
    };
    const wire = wireToolInputSchema(schema);
    expect(Object.keys(wire).filter((key) => COMBINATORS.includes(key))).toEqual([]);
    // Nested combinators are valid for every provider and stay.
    expect(wire.properties).toEqual(schema.properties);
    expect(wire.required).toEqual(["a"]);
    // The registered definition is untouched; host validation reads it.
    expect(schema.anyOf).toBeDefined();
  });

  it("returns schemas without combinators unchanged", () => {
    const schema = { type: "object", properties: {} };
    expect(wireToolInputSchema(schema)).toBe(schema);
  });

  it("sends the Skill tool to Claude without the top-level anyOf it rejects", () => {
    // Claude answers 400 "input_schema does not support oneOf, allOf, or anyOf
    // at the top level" for the whole request, failing every turn.
    expect(skillToolDef.inputSchema.anyOf).toBeDefined();
    const policy = resolvePromptCachePolicy({
      provider: "openai",
      providerKind: "openrouter",
      model: "anthropic/claude-sonnet-5",
    });
    const [wire] = anthropicTools([skillToolDef], policy);
    expect(Object.keys(wire!.input_schema).filter((key) => COMBINATORS.includes(key))).toEqual([]);
  });
});
