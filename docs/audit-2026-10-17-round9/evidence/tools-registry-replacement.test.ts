import { describe, expect, it } from "bun:test";
import { ToolRegistry } from "../../../packages/core/src/tool-system/registry.js";
import { toolSearchTool } from "../../../packages/core/src/tool-system/builtin/tool-search.js";
import type { RegisteredTool } from "../../../packages/core/src/types.js";

function definition(description: string): RegisteredTool {
  return {
    name: "CatalogProbe",
    description,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    source: "builtin",
    permissionDefault: "allow",
  };
}

describe("audit: definition-only replacement keeps a stale fake implementation", () => {
  it("fresh definition-only registration has no executor and rejects execution", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool(definition("metadata only"));
    expect(registry.hasTool("CatalogProbe")).toBe(true);
    expect(registry.hasExecutor("CatalogProbe")).toBe(false);
    await expect(registry.executeTool("CatalogProbe", { value: "new" })).rejects.toThrow(
      "No executor registered",
    );
  });

  it("replacement publishes new metadata but executes the previous registration", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    const calls: string[] = [];
    const disposeOld = registry.registerTool(definition("old implementation"), async (args) => {
      calls.push(String(args.value));
      return `old:${args.value}`;
    });
    const disposeNew = registry.registerTool(definition("new metadata only"));
    disposeOld();
    expect(registry.getTool("CatalogProbe")?.description).toBe("new metadata only");
    expect(registry.hasTool("CatalogProbe")).toBe(true);
    expect(registry.hasExecutor("CatalogProbe")).toBe(true);
    const discovery = await toolSearchTool({ query: "select:CatalogProbe" }, {
      toolRegistry: registry,
    } as never);
    expect(discovery).toContain("Purpose: new metadata only");
    expect(discovery).not.toContain("old implementation");
    const result = await registry.executeTool("CatalogProbe", { value: "next" });
    expect(result.isError).toBe(false);
    expect(result.result).toBe("old:next");
    expect(calls).toEqual(["next"]);
    disposeNew();
    expect(registry.hasTool("CatalogProbe")).toBe(false);
    expect(registry.hasExecutor("CatalogProbe")).toBe(false);
  });

  it("an explicit replacement executor and registration disposers work normally", async () => {
    const registry = new ToolRegistry({ builtinTools: [] });
    let oldCalls = 0;
    const disposeOld = registry.registerTool(definition("old implementation"), async () => {
      oldCalls += 1;
      return "old";
    });
    const disposeNew = registry.registerTool(definition("new implementation"), async () => "new");
    disposeOld();
    expect(registry.hasExecutor("CatalogProbe")).toBe(true);
    const result = await registry.executeTool("CatalogProbe", {});
    expect(result.isError).toBe(false);
    expect(result.result).toBe("new");
    expect(oldCalls).toBe(0);
    disposeNew();
    expect(registry.hasTool("CatalogProbe")).toBe(false);
  });
});
