import { describe, test, expect } from "bun:test";
import {
  validateToolArgs,
  validateToolArgsStrict,
  validateToolInputSchemaStrict,
} from "./validation.js";

describe("validateToolArgs", () => {
  test("passes when all required fields are present", () => {
    const schema = { properties: { a: { type: "string" } }, required: ["a"] };
    expect(validateToolArgs("t", { a: "x" }, schema)).toBeNull();
  });

  test("reports a missing required field", () => {
    const schema = { properties: { a: { type: "string" } }, required: ["a"] };
    expect(validateToolArgs("t", {}, schema)).toMatch(/Missing required parameter: a/);
  });

  // Regression: a schema declaring `required` with NO `properties` block (e.g.
  // a malformed external MCP tool schema) previously short-circuited on
  // `if (!properties) return null` before the required-field loop, so the
  // missing param went uncaught. Required presence must not depend on
  // `properties` existing.
  test("still checks required when the schema has no properties block", () => {
    const schema = { required: ["a"] };
    expect(validateToolArgs("t", {}, schema)).toMatch(/Missing required parameter: a/);
  });

  test("no properties + required satisfied → valid", () => {
    const schema = { required: ["a"] };
    expect(validateToolArgs("t", { a: 1 }, schema)).toBeNull();
  });

  test("type mismatch on a provided field is reported", () => {
    const schema = { properties: { a: { type: "string" } }, required: [] };
    expect(validateToolArgs("t", { a: 5 }, schema)).toMatch(/must be a string/);
  });
});

describe("validateToolArgsStrict", () => {
  const schema = {
    type: "object",
    $defs: {
      operation: {
        type: "object",
        properties: {
          op: { const: "create" },
          width: { type: "number", exclusiveMinimum: 0, maximum: 100 },
          mode: { enum: ["fixed", "fill"] },
        },
        required: ["op", "width"],
        additionalProperties: false,
      },
    },
    properties: {
      operations: {
        type: "array",
        minItems: 1,
        items: { $ref: "#/$defs/operation" },
      },
    },
    required: ["operations"],
    additionalProperties: false,
  };

  test("validates nested refs, const, enum, bounds, and extra fields", () => {
    expect(
      validateToolArgsStrict(
        "design",
        { operations: [{ op: "create", width: 20, mode: "fill" }] },
        schema,
      ),
    ).toBeNull();
    expect(
      validateToolArgsStrict("design", { operations: [{ op: "update", width: 20 }] }, schema),
    ).toMatch(/operations\[0\]\.op.+equal/);
    expect(
      validateToolArgsStrict("design", { operations: [{ op: "create", width: 0 }] }, schema),
    ).toMatch(/greater than 0/);
    expect(
      validateToolArgsStrict(
        "design",
        { operations: [{ op: "create", width: 20, mode: "other" }] },
        schema,
      ),
    ).toMatch(/enum/);
    expect(
      validateToolArgsStrict(
        "design",
        { operations: [{ op: "create", width: 20, surprise: true }] },
        schema,
      ),
    ).toMatch(/Unexpected parameter/);
  });

  test("fails closed on unsupported references and excessive nesting", () => {
    expect(
      validateToolArgsStrict("design", {}, { type: "object", $ref: "https://example.com/x" }),
    ).toMatch(/Unsupported or unresolved/);
    expect(
      validateToolArgsStrict(
        "design",
        {},
        {
          type: "object",
          not: { $ref: "https://example.com/x" },
        },
      ),
    ).toMatch(/Unsupported or unresolved/);
    let nestedSchema: Record<string, unknown> = { type: "string" };
    let nestedValue: unknown = "end";
    for (let index = 0; index < 70; index += 1) {
      nestedSchema = { type: "array", items: nestedSchema };
      nestedValue = [nestedValue];
    }
    expect(
      validateToolArgsStrict(
        "design",
        { value: nestedValue },
        {
          type: "object",
          properties: { value: nestedSchema },
        },
      ),
    ).toMatch(/depth limit/);
  });

  test("compares structured const and enum values independent of object key order", () => {
    expect(
      validateToolArgsStrict(
        "design",
        { value: { right: 2, left: 1 } },
        {
          type: "object",
          properties: {
            value: { enum: [{ left: 1, right: 2 }] },
          },
        },
      ),
    ).toBeNull();
    expect(
      validateToolInputSchemaStrict({
        type: "object",
        properties: {
          payload: {
            enum: Array.from({ length: 2_000 }, (_, index) => ({ index })),
          },
        },
      }),
    ).toBeNull();
    expect(
      validateToolInputSchemaStrict({
        type: "object",
        properties: {
          value: { enum: [0, -0] },
        },
      }),
    ).toMatch(/Invalid JSON Schema enum/);
    expect(
      validateToolArgsStrict(
        "design",
        { value: 0 },
        {
          type: "object",
          properties: { value: { const: -0 } },
        },
      ),
    ).toBeNull();
  });

  test("accepts only JSON objects and counts Unicode characters", () => {
    expect(
      validateToolArgsStrict(
        "design",
        { payload: new Date("2026-07-29T00:00:00.000Z") },
        {
          type: "object",
          properties: { payload: {} },
        },
      ),
    ).toMatch(/only JSON values/);
    expect(
      validateToolArgsStrict(
        "design",
        { payload: [undefined] },
        {
          type: "object",
          properties: { payload: { type: "array" } },
        },
      ),
    ).toMatch(/only JSON values/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(
      validateToolArgsStrict("design", circular, {
        type: "object",
        additionalProperties: true,
      }),
    ).toMatch(/circular JSON value/);
    expect(
      validateToolArgsStrict(
        "design",
        { label: "😀" },
        {
          type: "object",
          properties: { label: { type: "string", minLength: 2 } },
        },
      ),
    ).toMatch(/at least 2 characters/);
    expect(
      validateToolArgsStrict(
        "design",
        JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
        {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      ),
    ).toMatch(/Unexpected parameter: __proto__/);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  test("rejects malformed or unsupported constraints even when the value does not visit them", () => {
    expect(
      validateToolArgsStrict(
        "design",
        {},
        {
          type: "object",
          properties: {
            unused: { type: "string", minLength: "two" },
          },
        },
      ),
    ).toMatch(/Invalid JSON Schema minLength/);
    expect(
      validateToolArgsStrict("design", {}, { type: "object", additionalProperties: "no" }),
    ).toMatch(/Invalid JSON Schema additionalProperties/);
    expect(validateToolArgsStrict("design", {}, { type: "object", $ref: 42 })).toMatch(
      /Invalid JSON Schema reference/,
    );
    expect(
      validateToolArgsStrict(
        "design",
        {},
        {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
        },
      ),
    ).toMatch(/Unsupported JSON Schema keyword 'format'/);
    expect(validateToolInputSchemaStrict({ type: [] })).toMatch(/Invalid JSON Schema type/);
    expect(
      validateToolInputSchemaStrict({
        type: "object",
        properties: { value: { const: BigInt(1) } },
      }),
    ).toMatch(/must contain only JSON values/);
    const circularSchema: Record<string, unknown> = { type: "object" };
    circularSchema.properties = { value: circularSchema };
    expect(validateToolInputSchemaStrict(circularSchema)).toMatch(/circular JSON value/);
    expect(
      validateToolInputSchemaStrict({
        type: "object",
        examples: Array.from({ length: 20_001 }, () => null),
      }),
    ).toMatch(/value-size limit/);
  });

  test("accepts recursive local definitions without recursively validating forever", () => {
    const recursiveSchema = {
      type: "object",
      $defs: {
        node: {
          type: "object",
          properties: {
            value: { type: "string" },
            children: {
              type: "array",
              items: { $ref: "#/$defs/node" },
            },
          },
          required: ["value"],
          additionalProperties: false,
        },
      },
      properties: {
        root: { $ref: "#/$defs/node" },
      },
      required: ["root"],
      additionalProperties: false,
    };
    expect(
      validateToolArgsStrict(
        "design",
        { root: { value: "root", children: [{ value: "child" }] } },
        recursiveSchema,
      ),
    ).toBeNull();
  });

  test("rejects backtracking patterns and bounds input examined by safe patterns", () => {
    expect(
      validateToolArgsStrict(
        "design",
        { value: "a".repeat(100) + "!" },
        {
          type: "object",
          properties: {
            value: { type: "string", pattern: "^(a+)+$" },
          },
        },
      ),
    ).toMatch(/Invalid JSON Schema pattern/);
    expect(
      validateToolArgsStrict(
        "design",
        { value: "a".repeat(100) + "!" },
        {
          type: "object",
          properties: {
            value: { type: "string", pattern: "^a+a+$" },
          },
        },
      ),
    ).toMatch(/Invalid JSON Schema pattern/);
    expect(
      validateToolInputSchemaStrict({
        type: "object",
        properties: {
          value: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
        },
      }),
    ).toBeNull();
    expect(
      validateToolInputSchemaStrict({
        type: "object",
        properties: {
          value: { type: "string", pattern: "^a{0,10001}$" },
        },
      }),
    ).toMatch(/Invalid JSON Schema pattern/);
    expect(
      validateToolArgsStrict(
        "design",
        { value: "a".repeat(10_001) },
        {
          type: "object",
          properties: {
            value: { type: "string", pattern: "^a+$" },
          },
        },
      ),
    ).toMatch(/too long for pattern validation/);
  });

  test("checks structured uniqueItems independent of object key order", () => {
    expect(
      validateToolArgsStrict(
        "design",
        {
          values: [
            { left: 1, right: 2 },
            { right: 2, left: 1 },
          ],
        },
        {
          type: "object",
          properties: {
            values: { type: "array", uniqueItems: true },
          },
        },
      ),
    ).toMatch(/unique items/);
  });

  test("bounds the number of JSON values inspected before schema validation", () => {
    expect(
      validateToolArgsStrict(
        "design",
        { values: Array.from({ length: 20_001 }, () => 0) },
        {
          type: "object",
          properties: {
            values: { type: "array", items: { type: "number" } },
          },
        },
      ),
    ).toMatch(/value-size limit/);
  });

  test("bounds recursive branch evaluation from reviewed schemas", () => {
    const branchingSchema = {
      type: "object",
      $defs: {
        branch: {
          anyOf: [{ $ref: "#/$defs/branch" }, { $ref: "#/$defs/branch" }],
        },
      },
      properties: {
        value: { $ref: "#/$defs/branch" },
      },
      required: ["value"],
    };
    expect(validateToolArgsStrict("design", { value: "x" }, branchingSchema)).toMatch(
      /schema (?:evaluation|depth) limit/,
    );
    expect(
      validateToolArgsStrict(
        "design",
        { value: "x" },
        {
          ...branchingSchema,
          properties: {
            value: {
              anyOf: [{ type: "string" }, { $ref: "#/$defs/branch" }],
            },
          },
        },
      ),
    ).toMatch(/schema (?:evaluation|depth) limit/);
  });

  test("reports the error from a matching discriminated branch", () => {
    expect(
      validateToolArgsStrict(
        "design",
        { operation: { op: "rename", name: "" } },
        {
          type: "object",
          properties: {
            operation: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    op: { const: "create" },
                    id: { type: "string" },
                  },
                  required: ["op", "id"],
                },
                {
                  type: "object",
                  properties: {
                    op: { const: "rename" },
                    name: { type: "string", minLength: 1 },
                  },
                  required: ["op", "name"],
                },
              ],
            },
          },
        },
      ),
    ).toMatch(/operation\.name.+at least 1/);
  });
});
