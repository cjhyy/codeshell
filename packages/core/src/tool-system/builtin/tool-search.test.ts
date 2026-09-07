import { describe, it, expect } from "bun:test";
import { toolSearchTool } from "./tool-search.js";
import { ToolRegistry } from "../registry.js";
import type { ToolContext } from "../context.js";
import { browserDiscoveryScore } from "../browser-discovery.js";

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

  it("returns the per-turn rewritten schema and description", async () => {
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
    expect(out).toContain('"opaque-1"');
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
