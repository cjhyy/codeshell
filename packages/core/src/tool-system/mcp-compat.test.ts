import { describe, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { adaptMcpToolSchema, normalizeMcpToolArgs } from "./mcp-compat.js";

// The Chrome DevTools 1.8 SDK schemas declare these selectors optional. The
// provider sends the original required list (no strict-mode required rewrite).
const contracts: Array<[string, Record<string, string>, string[]]> = [
  ["take_snapshot", { verbose: "boolean" }, ["filePath"]],
  ["take_screenshot", { format: "string" }, ["filePath"]],
  ["evaluate_script", { function: "string" }, ["filePath"]],
  ["get_network_request", { reqid: "number" }, ["requestFilePath", "responseFilePath"]],
  ["new_page", { url: "string" }, ["isolatedContext"]],
];

function tool(name: string, signature: Record<string, string>, selectors: string[]): Tool {
  return {
    name,
    inputSchema: {
      type: "object",
      properties: {
        ...Object.fromEntries(Object.entries(signature).map(([name, type]) => [name, { type }])),
        ...Object.fromEntries(selectors.map((name) => [name, { type: "string" }])),
        text: { type: "string" },
      },
      required: ["text"],
    },
  };
}

describe("Chrome MCP optional selector compatibility", () => {
  for (const [name, signature, selectors] of contracts)
    test(`${name} omits only blank optional selectors and keeps the schema optional`, () => {
      const definition = tool(name, signature, selectors);
      const args = { text: "", ...Object.fromEntries(selectors.map((key) => [key, ""])) };
      expect(normalizeMcpToolArgs("chrome_devtools", definition, args)).toEqual({ text: "" });
      expect(Object.keys(args)).toHaveLength(selectors.length + 1);
      const adapted = adaptMcpToolSchema("chrome_devtools", definition);
      expect(adapted.required).toEqual(["text"]);
      for (const key of selectors) {
        expect(adapted.properties![key]).toMatchObject({ type: "string", minLength: 1 });
        expect(definition.inputSchema.properties![key]).not.toHaveProperty("minLength");
        for (const value of ["snapshot.txt", " ", null]) {
          expect(normalizeMcpToolArgs("chrome_devtools", definition, { [key]: value })[key]).toBe(
            value,
          );
        }
      }
    });

  test("server identity, tool signature and optional declaration must all match", () => {
    const known = tool("take_snapshot", { verbose: "boolean" }, ["filePath"]);
    const args = { filePath: "", text: "" };
    expect(normalizeMcpToolArgs("unrelated", known, args)).toEqual(args);
    expect(normalizeMcpToolArgs(undefined, known, args)).toEqual(args);
    expect(
      normalizeMcpToolArgs("chrome_devtools", { ...known, name: "custom_export" }, args),
    ).toEqual(args);
    expect(
      normalizeMcpToolArgs(
        "chrome_devtools",
        tool("take_snapshot", { verbose: "string" }, ["filePath"]),
        args,
      ),
    ).toEqual(args);
    expect(
      normalizeMcpToolArgs(
        "chrome_devtools",
        { ...known, inputSchema: { ...known.inputSchema, required: ["filePath"] } },
        args,
      ),
    ).toEqual(args);
    expect(normalizeMcpToolArgs("chrome_devtools", undefined, args)).toEqual(args);
  });

  test("explicit isolated contexts and ordinary empty script text remain intact", () => {
    const page = tool("new_page", { url: "string" }, ["isolatedContext"]);
    expect(
      normalizeMcpToolArgs("chrome_devtools", page, {
        url: "about:blank",
        isolatedContext: "signed-out",
      }),
    ).toEqual({ url: "about:blank", isolatedContext: "signed-out" });
    const script = tool("evaluate_script", { function: "string" }, ["filePath"]);
    expect(normalizeMcpToolArgs("chrome_devtools", script, { function: "", filePath: "" })).toEqual(
      { function: "" },
    );
  });
});
