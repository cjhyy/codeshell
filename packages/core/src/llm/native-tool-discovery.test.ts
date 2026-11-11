import { expect, test } from "bun:test";
import { canExposeNativeToolDefinition } from "./native-tool-discovery.js";

const definition = (name: string, inputSchema: Record<string, unknown> = { type: "object" }) => ({
  name,
  description: "portable fixture",
  inputSchema,
});

test("native declarations honor Messages name and root-schema constraints", () => {
  for (const name of ["ToolSearch", "mcp_server_tool", "letters-123", "x".repeat(128)]) {
    expect(canExposeNativeToolDefinition(definition(name))).toBe(true);
  }
  for (const name of ["", "x".repeat(129), "mcp_server:tool", "工具", "has space", "has.dot"]) {
    expect(canExposeNativeToolDefinition(definition(name))).toBe(false);
  }
  for (const schema of [{}, { type: "array" }, { type: ["object", "null"] }]) {
    expect(canExposeNativeToolDefinition(definition("ValidName", schema))).toBe(false);
  }
  expect(
    canExposeNativeToolDefinition(
      definition("Nested", {
        type: "object",
        $defs: { nested: { oneOf: [{ type: "string" }, { type: "null" }] } },
        properties: { value: { $ref: "#/$defs/nested" } },
      }),
    ),
  ).toBe(true);
});
