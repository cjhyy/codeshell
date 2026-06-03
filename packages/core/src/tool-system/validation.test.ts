import { describe, test, expect } from "bun:test";
import { validateToolArgs } from "./validation.js";

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
