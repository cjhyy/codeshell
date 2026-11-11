import { describe, expect, it } from "bun:test";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { RunToolSurface } from "../run-tool-surface.js";
import { toolSearchTool, toolSearchToolDef } from "./tool-search.js";
import { callToolDef } from "./call-tool.js";
import {
  joinToolResultText,
  matchesToolDiscoverySchema,
  toolDiscoverySchemaText,
} from "../../utils/tool-schema-discovery.js";
import { truncateToolResult } from "../../context/compaction.js";

type Mode = "call-tool" | "tool-reference";
const text = (value: Awaited<ReturnType<typeof toolSearchTool>>) =>
  typeof value === "string" ? value : value.result;
const definition = (name: string, padding = 0): ToolDefinition => ({
  name,
  description: "Budget boundary fixture",
  inputSchema: {
    type: "object",
    properties: { payload: { type: "string", description: "x".repeat(padding) } },
    required: ["payload"],
  },
});

function context(
  mode: Mode,
  tools: ToolDefinition[],
  health = false,
  eager: string[] = [],
): ToolContext {
  const surface = new RunToolSurface(eager, { toolDiscovery: mode });
  surface.updateCatalog([toolSearchToolDef, callToolDef, ...tools]);
  return {
    runToolSurface: surface,
    ...(health
      ? {
          mcpServerFailures: new Map([
            ["fixture:offline", "Initialization timed out. ".repeat(300)],
          ]),
        }
      : {}),
  } as ToolContext;
}

/** Size the schema using the public response so every real overhead is counted. */
async function sizedTool(mode: Mode, name: string, totalOutput: number, health = false) {
  const baseline = text(
    await toolSearchTool({ query: `select:${name}` }, context(mode, [definition(name)], health)),
  );
  expect(baseline.length).toBeLessThan(totalOutput);
  return definition(name, totalOutput - baseline.length);
}

describe("ToolSearch complete single-schema budgets", () => {
  for (const mode of ["call-tool", "tool-reference"] as const) {
    for (const health of [false, true]) {
      it(`${mode}, health=${health}: loads 29,999 complete characters including guidance and diagnostics`, async () => {
        const tool = await sizedTool(mode, "mcp_fixture_Large", 29_999, health);
        const ctx = context(mode, [tool], health);
        const prefix = JSON.stringify(ctx.runToolSurface!.requestSnapshot());
        // Duplicate names still select one distinct tool and use the single budget.
        const result = await toolSearchTool({ query: `select:${tool.name},${tool.name}` }, ctx);
        const output = text(result);
        expect(output.length).toBe(29_999);
        expect(output).toContain(toolDiscoverySchemaText(tool));
        expect(truncateToolResult(output)).toBe(output);
        expect(ctx.runToolSurface!.getSelection().discovered).toEqual([tool.name]);
        expect(ctx.runToolSurface!.isCallable(tool.name)).toBe(true);
        expect(JSON.stringify(ctx.runToolSurface!.requestSnapshot())).toBe(prefix);
        if (health) expect(output).toContain("MCP connection status for this run:");
        if (mode === "call-tool") expect(typeof result).toBe("string");
        else {
          if (typeof result === "string")
            throw new Error("Native discovery must retain annotated text");
          expect(joinToolResultText(result.contentBlocks, "legacy separator")).toBe(output);
          expect(
            result.contentBlocks.filter((part) => matchesToolDiscoverySchema(part, tool)),
          ).toHaveLength(1);
        }
      });

      it(`${mode}, health=${health}: refuses the next character without partial schema or discovery on repeated selects`, async () => {
        const tool = await sizedTool(mode, "mcp_fixture_Huge", 30_000, health);
        const ctx = context(mode, [tool], health);
        const prefix = JSON.stringify(ctx.runToolSurface!.requestSnapshot());
        let previous: string | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await toolSearchTool({ query: `select:${tool.name}` }, ctx);
          expect(typeof result).toBe("string");
          const output = text(result);
          expect(output).toContain(`Unavailable for loading: ${tool.name}.`);
          expect(output).toContain("Do not retry ToolSearch select");
          expect(output).toContain("Use another available tool");
          expect(output).not.toContain("select each tool separately");
          expect(output).not.toContain(`### ${tool.name}`);
          expect(output).not.toContain('"inputSchema"');
          expect(output.length).toBeLessThan(30_000);
          if (previous !== undefined) expect(output).toBe(previous);
          previous = output;
          expect(ctx.runToolSurface!.getSelection().discovered).toEqual([]);
          expect(ctx.runToolSurface!.isCallable(tool.name)).toBe(false);
        }
        expect(JSON.stringify(ctx.runToolSurface!.requestSnapshot())).toBe(prefix);
      });
    }

    it(`${mode}: batch keeps 24k and recommends single selection only where it can succeed`, async () => {
      const large = await sizedTool(mode, "Large", 28_500);
      const huge = await sizedTool(mode, "mcp_Huge", 33_000);
      const ctx = context(mode, [large, huge, definition("Small")], true);
      const batch = text(await toolSearchTool({ query: "select:Large,mcp_Huge,Small" }, ctx));
      expect(batch.length).toBeLessThanOrEqual(24_000);
      expect(batch).toContain("For Large, Small, select each tool separately");
      expect(batch).toContain("Unavailable for loading: mcp_Huge.");
      expect(batch).not.toContain("For Large, mcp_Huge");
      expect(ctx.runToolSurface!.getSelection().discovered).toEqual([]);
      // The solo query no longer includes MCP diagnostics. Its own budget matters.
      const single = text(await toolSearchTool({ query: "select:Large" }, ctx));
      expect(single.length).toBe(28_500);
      expect(single).toContain(toolDiscoverySchemaText(large));
      expect(ctx.runToolSurface!.isCallable("Large")).toBe(true);
      const unavailable = text(await toolSearchTool({ query: "select:mcp_Huge" }, ctx));
      expect(unavailable).toContain("Unavailable for loading: mcp_Huge.");
      expect(unavailable).not.toContain("select each tool separately");
      expect(ctx.runToolSurface!.isCallable("mcp_Huge")).toBe(false);
    });

    it(`${mode}: a failed select does not revoke an already loaded oversized tool`, async () => {
      const huge = definition("Huge", 35_000);
      const ctx = context(mode, [huge], false, [huge.name]);
      expect(ctx.runToolSurface!.isCallable(huge.name)).toBe(true);
      const result = text(await toolSearchTool({ query: "select:Huge" }, ctx));
      expect(result).toContain("Unavailable for loading: Huge.");
      expect(result).toContain("Already-loaded tools remain callable.");
      expect(ctx.runToolSurface!.isCallable(huge.name)).toBe(true);
      expect(ctx.runToolSurface!.getSelection().discovered).toEqual([]);
    });
  }

  it("preserves the external plain-string API with the expanded single budget", async () => {
    const tool = definition("External", 26_000);
    const result = await toolSearchTool({ query: "select:External" }, {
      searchableToolDefinitions: [tool],
    } as ToolContext);
    expect(typeof result).toBe("string");
    expect(text(result)).toContain(toolDiscoverySchemaText(tool));
    expect(text(result).length).toBeGreaterThan(24_000);
    expect(text(result).length).toBeLessThan(30_000);
  });
});
