import { describe, it, expect } from "bun:test";
import { toolSearchTool } from "./tool-search.js";
import { ToolRegistry } from "../registry.js";
import type { ToolContext } from "../context.js";
import { browserDiscoveryScore } from "../browser-discovery.js";
import { RunToolSurface } from "../run-tool-surface.js";

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
  it("explains failed MCP discovery without exposing hidden server health", async () => {
    const context = ctx(registryWith());
    context.mcpServerFailures = new Map([
      ["fixture:reader", "Initialization timed out."],
      ["hidden:private", "Secret failure"],
    ]);
    context.allowedMcpServers = new Set(["fixture:reader"]);
    for (const definitions of [undefined, []]) {
      context.searchableToolDefinitions = definitions;
      const result = await toolSearchTool({ query: "mcp fixture tools" }, context);
      expect(result).toContain("fixture:reader");
      expect(result).toContain("Initialization timed out");
      expect(result).not.toContain("hidden:private");
      expect(result).not.toContain("Secret failure");
    }
    context.mcpServerFailures = new Map();
    expect(await toolSearchTool({ query: "mcp" }, context)).not.toContain("MCP connection status");
  });

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

  it("reports no matches without dumping the catalog", async () => {
    const r = registryWith({ name: "Alpha", description: "the alpha tool" });
    const out = await toolSearchTool({ query: "zzz" }, ctx(r));
    expect(out).toContain("No tools matching");
    expect(out).not.toContain("Alpha");
    expect(out).not.toContain("Available tools:");
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

describe("toolSearchTool — current Session surface", () => {
  it("fallback discovery honors disabled and unexposed tools even with a live bridge", async () => {
    const r = new ToolRegistry({ builtinTools: ["ToolSearch", "browser_navigate"] });
    const live = {
      ...ctx(r),
      browser: {} as ToolContext["browser"],
      toolVisibility: { cwd: "/repo", hasGoal: false, hasBrowserAutomation: true },
    };
    for (const restricted of [
      { ...live, disabledBuiltins: new Set(["browser_navigate"]) },
      { ...live, allowedToolNames: new Set(["ToolSearch"]) },
    ]) {
      expect(await toolSearchTool({ query: "select:browser_navigate" }, restricted)).toContain(
        "not found",
      );
      expect(await toolSearchTool({ query: "浏览器" }, restricted)).not.toContain(
        "browser_navigate",
      );
    }
  });

  it("prefers the available native browser for generic discovery while respecting exact MCP selection", async () => {
    const r = new ToolRegistry({
      builtinTools: ["browser_navigate", "browser_observe", "browser_act"],
    });
    const mcpName = "mcp_chrome_new_page";
    r.registerTool(
      {
        name: mcpName,
        description: "MCP browser automation: open a Chrome browser webpage",
        inputSchema: { type: "object", properties: {} },
        source: "mcp",
        serverName: "chrome",
        permissionDefault: "ask",
      },
      async () => "ok",
    );
    const current = { ...ctx(r), searchableToolDefinitions: r.getToolDefinitions() };
    for (const query of ["browser", "网页", "内置浏览器"]) {
      const result = await toolSearchTool({ query, max_results: 1 }, current);
      expect(result).toContain("### browser_navigate");
      expect(result).not.toContain(mcpName);
    }
    expect(await toolSearchTool({ query: `select:${mcpName}` }, current)).toContain(
      `### ${mcpName}`,
    );
    expect(
      await toolSearchTool({ query: "MCP browser Chrome", max_results: 1 }, current),
    ).toContain(`### ${mcpName}`);
    for (const query of ["browser network", "browser console", "browser performance", mcpName]) {
      expect(browserDiscoveryScore(r.getTool("browser_navigate")!, query)).toBe(0);
    }
    // Legacy hosts without a per-turn snapshot must not advertise an unwired bridge either.
    expect(await toolSearchTool({ query: "select:browser_navigate" }, ctx(r))).toContain(
      "not found",
    );
  });
  it("does not advertise a registry tool filtered out of the current Session", async () => {
    const r = registryWith(
      { name: "SendMessage", description: "raw outbound sender" },
      { name: "ReportToMimi", description: "report internally" },
    );
    const current = {
      ...ctx(r),
      searchableToolDefinitions: [
        {
          name: "ReportToMimi",
          description: "report internally",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    } as unknown as ToolContext;

    const keyword = await toolSearchTool({ query: "message outbound" }, current);
    expect(keyword).not.toContain("SendMessage");
    const exact = await toolSearchTool({ query: "select:SendMessage" }, current);
    expect(exact).toContain("not available in the current Session context");
    expect(exact).toContain("Do not retry");
  });

  it("returns authorized rewritten metadata without exposing the schema", async () => {
    const r = registryWith({ name: "Dynamic", description: "raw description" });
    const current = {
      ...ctx(r),
      searchableToolDefinitions: [
        {
          name: "Dynamic",
          description: "rewritten authorized destination",
          inputSchema: {
            type: "object",
            properties: { target_id: { type: "string", enum: ["opaque-1"] } },
          },
        },
      ],
    } as unknown as ToolContext;

    const out = await toolSearchTool({ query: "select:Dynamic" }, current);
    expect(out).toContain("rewritten authorized destination");
    expect(out).toContain("schemaRef: select:Dynamic");
    expect(out).not.toContain("opaque-1");
    expect(out).not.toContain("target_id");
    expect(out).not.toContain("raw description");
  });
});

describe("toolSearchTool — MCP visibility gate (worker-shared registry leak)", () => {
  function registryWithMcp(): ToolRegistry {
    const r = new ToolRegistry({ builtinTools: [] });
    r.registerTool(
      {
        name: "mcp_chrome_chrome_list_pages",
        description: "[chrome-devtools:chrome] list open pages",
        inputSchema: { type: "object", properties: {} },
        source: "mcp",
        serverName: "chrome-devtools:chrome",
        mcpToolName: "list_pages",
        permissionDefault: "ask",
      },
      async () => "ok",
    );
    r.registerTool(
      {
        name: "mcp_mine_srv_doit",
        description: "[mine:srv] do it",
        inputSchema: { type: "object", properties: {} },
        source: "mcp",
        serverName: "mine:srv",
        mcpToolName: "doit",
        permissionDefault: "ask",
      },
      async () => "ok",
    );
    return r;
  }
  const gatedCtx = (r: ToolRegistry, allowed: string[]): ToolContext =>
    ({ toolRegistry: r, allowedMcpServers: new Set(allowed) }) as unknown as ToolContext;

  it("keyword search hides MCP tools from servers this session didn't enable", async () => {
    const r = registryWithMcp();
    const out = await toolSearchTool({ query: "chrome pages doit" }, gatedCtx(r, ["mine:srv"]));
    expect(out).not.toContain("mcp_chrome_chrome_list_pages");
    expect(out).toContain("mcp_mine_srv_doit");
  });

  it("select: cannot reach a disallowed MCP tool (reports not found)", async () => {
    const r = registryWithMcp();
    const out = await toolSearchTool(
      { query: "select:mcp_chrome_chrome_list_pages" },
      gatedCtx(r, ["mine:srv"]),
    );
    expect(out).toContain("not found");
  });

  it("no allowedMcpServers set → no gating (legacy / sub-agent)", async () => {
    const r = registryWithMcp();
    const out = await toolSearchTool({ query: "chrome" }, ctx(r));
    expect(out).toContain("mcp_chrome_chrome_list_pages");
  });

  it("hides tools denied by the enabled server's exact-name policy", async () => {
    const r = registryWithMcp();
    const out = await toolSearchTool(
      { query: "pages doit" },
      {
        ...gatedCtx(r, ["chrome-devtools:chrome", "mine:srv"]),
        mcpToolPolicies: new Map([
          [
            "chrome-devtools:chrome",
            { allowedTools: new Set(["other"]), disabledTools: new Set<string>() },
          ],
        ]),
      },
    );
    expect(out).not.toContain("mcp_chrome_chrome_list_pages");
    expect(out).toContain("mcp_mine_srv_doit");
  });
});

describe("toolSearchTool — deferred run selection", () => {
  function deferredContext(r: ToolRegistry): ToolContext {
    const context = ctx(r);
    context.runToolSurface = new RunToolSurface([]);
    context.runToolSurface.updateCatalog([
      { name: "ToolSearch", description: "discover tools", inputSchema: { type: "object" } },
      ...r.getToolDefinitions(),
    ]);
    return context;
  }

  it("keyword discovery returns metadata without loading tools or leaking full schemas", async () => {
    const r = registryWith({ name: "Dynamic", description: "raw description" });
    const context = deferredContext(r);
    context.runToolSurface!.updateCatalog([
      {
        name: "ToolSearch",
        description: "discover tools",
        inputSchema: { type: "object" },
      },
      {
        name: "Dynamic",
        description: "rewritten authorized destination",
        inputSchema: {
          type: "object",
          properties: { target_id: { type: "string", enum: ["opaque-secret-schema"] } },
        },
      },
    ]);
    const result = await toolSearchTool({ query: "destination" }, context);
    expect(result).toContain("### Dynamic");
    expect(result).toContain("Source: builtin");
    expect(result).toContain("Purpose: rewritten authorized destination");
    expect(result).toContain("schemaRef: select:Dynamic");
    expect(result).not.toContain("raw description");
    expect(result).not.toContain("target_id");
    expect(result).not.toContain("opaque-secret-schema");
    expect(result).not.toContain("Parameters:");
    expect(context.runToolSurface!.snapshot().map((tool) => tool.name)).toEqual(["ToolSearch"]);
  });

  it("exact selection loads rewritten schemas and returns only a compact receipt", async () => {
    const r = registryWith({ name: "Dynamic", description: "raw description" });
    const context = deferredContext(r);
    context.runToolSurface!.updateCatalog([
      {
        name: "ToolSearch",
        description: "discover tools",
        inputSchema: { type: "object" },
      },
      {
        name: "Dynamic",
        description: "rewritten authorized destination",
        inputSchema: {
          type: "object",
          properties: { target_id: { type: "string", enum: ["opaque-secret-schema"] } },
        },
      },
    ]);
    const result = await toolSearchTool({ query: "select:Dynamic,Missing,Dynamic" }, context);
    expect(result).toContain("Selected tools for this run: Dynamic.");
    expect(result).toContain("schemaRef: select:Dynamic");
    expect(result).toContain('Tool "Missing" is not available in the current Session context.');
    expect(result).toContain("Do not retry unless the Session context changes.");
    expect(result).not.toContain("target_id");
    expect(result).not.toContain("opaque-secret-schema");
    expect(result).not.toContain("Parameters:");
    expect(context.runToolSurface!.snapshot()).toEqual(context.runToolSurface!.getCatalog());
    expect(context.runToolSurface!.snapshot()[1].inputSchema).toEqual({
      type: "object",
      properties: { target_id: { type: "string", enum: ["opaque-secret-schema"] } },
    });
  });

  it("prefers the run catalog over stale searchable definitions and the shared registry", async () => {
    const r = registryWith(
      { name: "Hidden", description: "hidden capability" },
      { name: "Visible", description: "visible capability" },
    );
    const context = deferredContext(r);
    context.searchableToolDefinitions = r.getToolDefinitions();
    context.runToolSurface!.updateCatalog(
      r.getToolDefinitions().filter((definition) => definition.name === "Visible"),
    );
    const search = await toolSearchTool({ query: "capability" }, context);
    expect(search).toContain("Visible");
    expect(search).not.toContain("Hidden");
    const selected = await toolSearchTool({ query: "select:Hidden" }, context);
    expect(selected).toContain("not available in the current Session context");
    expect(context.runToolSurface!.isSelected("Hidden")).toBe(false);
    context.runToolSurface!.updateCatalog([]);
    expect(await toolSearchTool({ query: "capability" }, context)).not.toContain("Visible");
  });

  it("keeps restored selection sticky while advertising only rewritten metadata", async () => {
    const r = registryWith({ name: "Dynamic", description: "raw description" });
    const context = deferredContext(r);
    await toolSearchTool({ query: "select:Dynamic" }, context);
    context.runToolSurface!.updateCatalog([]);
    const unavailable = await toolSearchTool({ query: "select:Dynamic" }, context);
    expect(unavailable).toContain("not available in the current Session context");
    expect(context.runToolSurface!.isSelected("Dynamic")).toBe(false);
    const rewritten = {
      name: "Dynamic",
      description: "restored authorized destination",
      inputSchema: { properties: { private_field: { const: "new-schema-only-marker" } } },
    };
    context.runToolSurface!.updateCatalog([rewritten]);
    expect(context.runToolSurface!.isSelected("Dynamic")).toBe(true);
    expect(context.runToolSurface!.snapshot()).toEqual([rewritten]);
    for (const query of ["authorized destination", "select:Dynamic"]) {
      const result = await toolSearchTool({ query }, context);
      expect(result).not.toContain("private_field");
      expect(result).not.toContain("new-schema-only-marker");
      expect(result).not.toContain("raw description");
    }
  });

  it("keeps selection independent for concurrent runs sharing a registry", async () => {
    const r = registryWith({ name: "Read", description: "read" });
    const first = deferredContext(r);
    const second = deferredContext(r);
    await toolSearchTool({ query: "select:Read" }, first);
    expect(first.runToolSurface!.isSelected("Read")).toBe(true);
    expect(second.runToolSurface!.isSelected("Read")).toBe(false);
    expect(r.getToolDefinitions().map((tool) => tool.name)).toEqual(["Read"]);
  });

  it("preserves MCP health reporting while using the run catalog", async () => {
    const context = deferredContext(registryWith());
    context.allowedMcpServers = new Set(["fixture:reader"]);
    context.mcpServerFailures = new Map([
      ["fixture:reader", "Initialization timed out."],
      ["hidden:private", "Secret failure"],
    ]);
    const result = await toolSearchTool({ query: "mcp fixture tools" }, context);
    expect(result).toContain("fixture:reader");
    expect(result).toContain("Initialization timed out");
    expect(result).not.toContain("hidden:private");
    expect(result).not.toContain("Secret failure");
  });

  it("keeps metadata bounded for a large catalog with long descriptions and schemas", async () => {
    const context = deferredContext(registryWith());
    context.runToolSurface!.updateCatalog([
      { name: "ToolSearch", description: "discover tools", inputSchema: {} },
      ...Array.from({ length: 1000 }, (_, index) => ({
        name: `CatalogTool${index}`,
        description: `catalog purpose ${"long description ".repeat(1000)}`,
        inputSchema: {
          type: "object",
          properties: { secret_schema_field: { enum: ["large-schema-marker".repeat(1000)] } },
        },
      })),
    ]);
    const result = await toolSearchTool({ query: "catalog", max_results: 999 }, context);
    expect((result.match(/^### /gm) ?? []).length).toBe(20);
    expect(result.length).toBeLessThan(6500);
    expect(result).not.toContain("secret_schema_field");
    expect(result).not.toContain("large-schema-marker");
    for (const purpose of result.matchAll(/^Purpose: (.*)$/gm)) {
      expect(purpose[1].length).toBeLessThanOrEqual(180);
    }
    expect(context.runToolSurface!.snapshot().map((tool) => tool.name)).toEqual(["ToolSearch"]);
  });

  it("omits oversized metadata entries while preserving complete names and schema references", async () => {
    const context = deferredContext(registryWith());
    const oversized = `Oversized${"x".repeat(9000)}`;
    const selectable = Array.from({ length: 18 }, (_, index) => `Tool${index}_${"y".repeat(900)}`);
    context.runToolSurface!.updateCatalog([
      { name: "ToolSearch", description: "discover tools", inputSchema: {} },
      ...[oversized, ...selectable, "SmallTool"].map((name) => ({
        name,
        description: "bounded fixture capability",
        inputSchema: { properties: { schema_only_marker: { type: "string" } } },
      })),
    ]);
    const result = await toolSearchTool({ query: "bounded fixture", max_results: 20 }, context);
    expect(result.length).toBeLessThanOrEqual(8192);
    expect(result).toContain("Some matching tools were omitted");
    expect(result).toContain("### SmallTool");
    expect(result).not.toContain(oversized);
    expect(result).not.toContain("schema_only_marker");
    const completeNames = new Set([...selectable, "SmallTool"]);
    for (const reference of result.matchAll(/^schemaRef: select:(.*)$/gm)) {
      expect(completeNames.has(reference[1])).toBe(true);
      expect(result).toContain(`### ${reference[1]}\n`);
    }
    expect(context.runToolSurface!.snapshot().map((tool) => tool.name)).toEqual(["ToolSearch"]);
  });

  it("bounds MCP server display without truncating the selectable tool name", async () => {
    const r = registryWith();
    r.registerTool(
      {
        name: "mcp_fixture_read",
        description: "read bounded fixture",
        inputSchema: { properties: { schema_only_marker: { type: "string" } } },
        source: "mcp",
        serverName: `fixture:${"s".repeat(2000)}`,
        permissionDefault: "ask",
      },
      async () => "ok",
    );
    const result = await toolSearchTool({ query: "fixture" }, deferredContext(r));
    const serverDisplay = result.match(/^Source: mcp \((.*)\)$/m)?.[1];
    expect(serverDisplay).toBeDefined();
    expect(serverDisplay!.length).toBeLessThanOrEqual(120);
    expect(serverDisplay).toEndWith("…");
    expect(result).toContain("schemaRef: select:mcp_fixture_read");
    expect(result).not.toContain("schema_only_marker");
  });

  it("bounds a maximum-size selection receipt including large MCP health diagnostics", async () => {
    const context = deferredContext(registryWith());
    const missing = Array.from(
      { length: 20 },
      (_, index) => `mcp_${"x".repeat(93)}${String(index).padStart(2, "0")}`,
    );
    context.mcpServerFailures = new Map([
      ["fixture:reader", "Initialization timed out. ".repeat(1000)],
      ["fixture:other", "Another bounded host failure."],
    ]);
    const query = `select:${missing.join(",")}`;
    expect(query.length).toBeLessThanOrEqual(2048);
    const result = await toolSearchTool({ query }, context);
    expect(result.length).toBeLessThanOrEqual(8192);
    expect(result).toContain("MCP connection status for this run:");
    expect(result).toContain("Initialization timed out.");
    for (const name of missing) {
      expect(result).toContain(`Tool "${name}" is not available in the current Session context.`);
    }
    const receipt = result.slice(result.indexOf('\n\nTool "') + 2);
    expect(receipt.length).toBeLessThan(5000);
    expect(context.runToolSurface!.snapshot().map((tool) => tool.name)).toEqual(["ToolSearch"]);
  });

  it("bounds mixed selection references and preserves every unavailable receipt", async () => {
    const selected = `mcp_${"x".repeat(1970)}`;
    const context = deferredContext(registryWith({ name: selected, description: "fixture" }));
    const missing = Array.from({ length: 19 }, (_, index) => `M${index}`);
    context.mcpServerFailures = new Map([["fixture", "Initialization timed out. ".repeat(1000)]]);
    const query = `select:${[selected, ...missing].join(",")}`;
    expect(query.length).toBeLessThanOrEqual(2048);
    const result = await toolSearchTool({ query }, context);
    expect(result.length).toBeLessThanOrEqual(8192);
    expect(context.runToolSurface!.isSelected(selected)).toBe(true);
    for (const name of missing) expect(result).toContain(`Tool "${name}" is not available`);
    if (result.includes("schemaRef:")) expect(result).toContain(`schemaRef: select:${selected}`);
    else expect(result).toContain("Some matching tools were omitted");
  });

  it("counts MCP health diagnostics within the final keyword output budget", async () => {
    const context = deferredContext(registryWith());
    context.runToolSurface!.updateCatalog([
      { name: "ToolSearch", description: "discover tools", inputSchema: {} },
      ...Array.from({ length: 20 }, (_, index) => ({
        name: `mcp_Tool${index}_${"x".repeat(110)}`,
        description: `catalog ${"long description ".repeat(50)}`,
        inputSchema: { properties: { schema_only_marker: { type: "string" } } },
      })),
    ]);
    context.mcpServerFailures = new Map([
      ["fixture:reader", "Initialization timed out. ".repeat(1000)],
    ]);
    const result = await toolSearchTool({ query: "mcp catalog", max_results: 20 }, context);
    expect(result.length).toBeLessThanOrEqual(8192);
    expect(result).toContain("MCP connection status for this run:");
    expect(result).toContain("Some matching tools were omitted");
    expect(result).not.toContain("schema_only_marker");
  });

  it("bounds legacy selection metadata while retaining every unavailable-name receipt", async () => {
    const definitions = Array.from({ length: 19 }, (_, index) => ({
      name: `Tool${String(index).padStart(2, "0")}_${"x".repeat(93)}`,
      description: "long compact metadata ".repeat(100),
    }));
    const r = registryWith(...definitions);
    const missing = "MissingTool";
    const query = `select:${[...definitions.map((tool) => tool.name), missing].join(",")}`;
    expect(query.length).toBeLessThanOrEqual(2048);
    const result = await toolSearchTool({ query }, ctx(r));
    expect(result.length).toBeLessThanOrEqual(8192);
    expect(result).toContain('Tool "MissingTool" not found.');
    expect(result).toContain("Some matching tools were omitted");
    expect(result).not.toContain("Parameters:");
  });

  it("validates query type and size without changing selection", async () => {
    const context = deferredContext(registryWith({ name: "Read", description: "read" }));
    for (const query of [undefined, null, 12, {}, [], "", "   "]) {
      expect(await toolSearchTool({ query }, context)).toContain("Error: query");
    }
    expect(await toolSearchTool({ query: "x".repeat(2049) }, context)).toContain("at most 2048");
    expect(context.runToolSurface!.isSelected("Read")).toBe(false);
  });

  it("accepts the query size boundary without dumping an unmatched catalog", async () => {
    const context = deferredContext(registryWith({ name: "Read", description: "read" }));
    const query = "x".repeat(2048);
    const result = await toolSearchTool({ query }, context);
    expect(result).toBe(`No tools matching "${query}".`);
    expect(result).not.toContain("Read");
    expect(result.length).toBeLessThan(2100);
  });

  it("bounds exact selection to twenty non-empty names before loading any", async () => {
    const r = registryWith(
      ...Array.from({ length: 21 }, (_, index) => ({ name: `Tool${index}`, description: "tool" })),
    );
    const context = deferredContext(r);
    for (const query of [
      "select:",
      "select:Tool0,",
      `select:${r
        .getToolDefinitions()
        .map((tool) => tool.name)
        .join(",")}`,
    ]) {
      expect(await toolSearchTool({ query }, context)).toContain("Error: select requires");
    }
    expect(context.runToolSurface!.snapshot().map((tool) => tool.name)).toEqual(["ToolSearch"]);
    const twenty = r
      .getToolDefinitions()
      .slice(0, 20)
      .map((tool) => tool.name);
    expect(await toolSearchTool({ query: `select:${twenty.join(",")}` }, context)).toContain(
      "Selected tools for this run:",
    );
    expect(context.runToolSurface!.snapshot()).toHaveLength(21);
  });

  it("normalizes invalid max_results to a finite integer default and clamps the maximum", async () => {
    const r = registryWith(
      ...Array.from({ length: 30 }, (_, index) => ({ name: `File${index}`, description: "file" })),
    );
    const context = deferredContext(r);
    for (const max_results of [undefined, NaN, Infinity, -Infinity, 0, -1, 1.5, "2", {}]) {
      const result = await toolSearchTool({ query: "file", max_results }, context);
      expect((result.match(/^### /gm) ?? []).length).toBe(5);
    }
    const result = await toolSearchTool({ query: "file", max_results: 21 }, context);
    expect((result.match(/^### /gm) ?? []).length).toBe(20);
  });

  it("keeps legacy exact selection compact without changing registry definitions", async () => {
    const r = registryWith({ name: "Read", description: "read" });
    const before = r.getToolDefinitions();
    const result = await toolSearchTool({ query: "select:Read" }, ctx(r));
    expect(result).toContain("schemaRef: select:Read");
    expect(result).not.toContain("Parameters:");
    expect(result).not.toContain("Selected tools for this run:");
    expect(r.getToolDefinitions()).toEqual(before);
  });
});
