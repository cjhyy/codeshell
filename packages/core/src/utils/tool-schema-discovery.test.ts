import { describe, expect, test } from "bun:test";
import type { ContentBlock, ToolDefinition } from "../types.js";
import {
  joinToolResultText,
  matchesToolDiscoverySchema,
  toolDiscoverySchemaBlock,
  toolDiscoverySchemaDigest,
  toolDiscoverySchemaText,
} from "./tool-schema-discovery.js";

const tool: ToolDefinition = {
  name: "mcp__catalog__lookup",
  description: "查询嵌套数据 🧪 — café\n保留换行",
  inputSchema: {
    type: "object",
    properties: {
      filters: {
        type: "array",
        items: {
          anyOf: [
            { type: "object", properties: { key: { enum: ["名字", "🧪"] } } },
            { $ref: "#/$defs/filter" },
          ],
        },
      },
    },
    $defs: { filter: { type: "string", pattern: "^(a|b)\\s+$" } },
    required: ["filters"],
    additionalProperties: false,
  },
};

describe("portable discovered-tool schema metadata", () => {
  test("keeps complete Unicode and nested schemas through a JSON round trip", () => {
    const schema = JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
    const expected = `### ${tool.name}\nschemaRef: select:${tool.name}\n${schema}`;
    const block = JSON.parse(JSON.stringify(toolDiscoverySchemaBlock(tool)));
    expect(toolDiscoverySchemaText(tool)).toBe(expected);
    expect(block.text).toBe(expected);
    expect(matchesToolDiscoverySchema(block, tool)).toBe(true);
    expect(block.discoveredTool.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(block.text.split("\n").slice(2).join("\n"))).toEqual({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  });

  test("provider hints and execution sensitivity are outside the model schema digest", () => {
    const withHints = { ...tool, deferLoading: true as const, sensitiveResult: true };
    expect(toolDiscoverySchemaDigest(withHints)).toBe(toolDiscoverySchemaDigest(tool));
    expect(toolDiscoverySchemaText(withHints)).toBe(toolDiscoverySchemaText(tool));
  });

  test("changed schema, description, name, or fallback bytes cannot become a reference", () => {
    const block = toolDiscoverySchemaBlock(tool);
    for (const changed of [
      { ...tool, name: "another_tool" },
      { ...tool, description: `${tool.description}!` },
      { ...tool, inputSchema: { ...tool.inputSchema, additionalProperties: true } },
    ]) {
      expect(matchesToolDiscoverySchema(block, changed)).toBe(false);
    }
    for (const text of [`${block.text}\n`, block.text!.slice(0, -1), "truncated schema"]) {
      expect(matchesToolDiscoverySchema({ ...block, text }, tool)).toBe(false);
    }
    expect(matchesToolDiscoverySchema({ ...block, type: "reasoning" }, tool)).toBe(false);
  });

  test.each([
    { discoveredTool: undefined },
    { discoveredTool: null },
    { discoveredTool: "invalid" },
    { discoveredTool: [] },
    { discoveredTool: {} },
    { discoveredTool: { version: 2 } },
    { discoveredTool: { version: 1, name: tool.name, schemaDigest: "invalid" } },
  ])("malformed metadata %j never validates a schema reference", ({ discoveredTool }) => {
    const block = { ...toolDiscoverySchemaBlock(tool), discoveredTool } as ContentBlock;
    expect(matchesToolDiscoverySchema(block, tool)).toBe(false);
    expect(block.text).toBe(toolDiscoverySchemaText(tool));
  });

  test("explicit discovery separators survive even when annotations are invalid", () => {
    const schema = toolDiscoverySchemaBlock(tool);
    const blocks: ContentBlock[] = [
      { type: "text", text: "health\n\n" },
      schema,
      { type: "text", text: "\n\nUse CallTool." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ];
    const expected = `health\n\n${schema.text}\n\nUse CallTool.`;
    expect(joinToolResultText(blocks, "\n")).toBe(expected);
    expect(joinToolResultText(blocks, "\n\n")).toBe(expected);
    schema.discoveredTool!.version = 99 as 1;
    expect(joinToolResultText(blocks, "\n")).toBe(expected);
    expect(matchesToolDiscoverySchema(schema, tool)).toBe(false);
  });

  test("legacy multi-part text retains the caller's separator", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "before" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "after" },
    ];
    expect(joinToolResultText(blocks, "\n")).toBe("before\nafter");
    expect(joinToolResultText(blocks, "\n\n")).toBe("before\n\nafter");
    expect(joinToolResultText([], "\n")).toBe("");
  });
});
