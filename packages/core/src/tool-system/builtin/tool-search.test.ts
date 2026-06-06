import { describe, it, expect } from "bun:test";
import { toolSearchTool } from "./tool-search.js";
import { ToolRegistry } from "../registry.js";
import type { ToolContext } from "../context.js";

function registryWith(...defs: Array<{ name: string; description: string }>): ToolRegistry {
  const r = new ToolRegistry({ builtinTools: [] });
  for (const d of defs) {
    r.registerTool(
      {
        name: d.name,
        description: d.description,
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
        permissionDefault: "allow",
      },
      async () => "ok",
    );
  }
  return r;
}

const ctx = (r: ToolRegistry): ToolContext => ({ toolRegistry: r }) as unknown as ToolContext;

describe("toolSearchTool", () => {
  it("requires a query", async () => {
    expect(await toolSearchTool({}, ctx(registryWith()))).toContain("query is required");
  });

  it("errors without a registry in ctx", async () => {
    expect(await toolSearchTool({ query: "x" })).toContain("not configured");
  });

  it("keyword search ranks name matches above description matches", async () => {
    const r = registryWith(
      { name: "ReadFile", description: "read a file from disk" },
      { name: "Browser", description: "open a file in the browser" },
    );
    const out = await toolSearchTool({ query: "file" }, ctx(r));
    // Both match; ReadFile matches on name (+10) and desc, Browser only desc.
    expect(out.indexOf("ReadFile")).toBeLessThan(out.indexOf("Browser"));
  });

  it("reports no matches with the available tool list", async () => {
    const r = registryWith({ name: "Alpha", description: "the alpha tool" });
    const out = await toolSearchTool({ query: "zzz" }, ctx(r));
    expect(out).toContain("No tools matching");
    expect(out).toContain("Alpha");
  });

  it("select: returns exact tools and flags unknown ones", async () => {
    const r = registryWith(
      { name: "Read", description: "read" },
      { name: "Write", description: "write" },
    );
    const out = await toolSearchTool({ query: "select:Read,Nope" }, ctx(r));
    expect(out).toContain("### Read");
    expect(out).toContain('Tool "Nope" not found');
  });

  it("respects max_results", async () => {
    const r = registryWith(
      { name: "FileA", description: "file" },
      { name: "FileB", description: "file" },
      { name: "FileC", description: "file" },
    );
    const out = await toolSearchTool({ query: "file", max_results: 2 }, ctx(r));
    const count = (out.match(/### File/g) ?? []).length;
    expect(count).toBe(2);
  });
});
