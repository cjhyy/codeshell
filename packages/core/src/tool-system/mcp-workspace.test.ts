import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MCPManager } from "./mcp-manager.js";
import { mcpConnectionScope } from "./mcp-workspace.js";
import { canonicalPath, createWorkspaceContext } from "../workspace/workspace-context.js";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { MCPServerConfig } from "../types.js";

let directory: string;
let registry: ToolRegistry;
let manager: MCPManager;
let servers: Record<string, MCPServerConfig>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mcp-workspace-"));
  for (const path of ["a/sub", "b"]) mkdirSync(join(directory, path), { recursive: true });
  const fixture = join(directory, "server.mjs");
  // A real SDK server verifies the negotiated roots and receives the actual
  // stdio cwd/arguments; no browser process or external network is involved.
  writeFileSync(
    fixture,
    `
import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
const server = new Server({ name: "chrome_devtools", version: "test" }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "take_snapshot", inputSchema: { type: "object", properties: { verbose: { type: "boolean" }, filePath: { type: "string" } } } },
  { name: "fail", inputSchema: { type: "object", properties: {} } }
] }));
async function details(args) {
  const { roots } = await server.listRoots();
  return JSON.stringify({ roots, cwd: process.cwd(), pid: process.pid, args });
}
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  isError: request.params.name === "fail",
  content: [{ type: "text", text: request.params.name === "fail" ? "Access denied by fixture roots" : await details(request.params.arguments) }]
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "test://workspace", name: process.cwd() }] }));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: "test://workspace", mimeType: "text/plain", text: await details({}) }] }));
await server.connect(new StdioServerTransport());
`,
  );
  servers = { browser: { name: "browser", command: process.execPath, args: [fixture] } };
  registry = new ToolRegistry({ builtinTools: ["MCPTool", "ReadMcpResource", "ListMcpResources"] });
  manager = new MCPManager(registry);
});

afterEach(async () => {
  await manager.disconnectAll();
  rmSync(directory, { recursive: true, force: true });
});

function context(name: string, explicitWorkspace = true): ToolContext {
  const cwd = join(directory, name);
  return {
    cwd,
    ...(explicitWorkspace
      ? {
          workspace: createWorkspaceContext({
            projectId: name,
            projectRevision: 1,
            sessionMainRootId: "main",
            roots: [{ id: "main", path: cwd, role: "primary" }],
          }),
        }
      : {}),
  } as ToolContext;
}

async function call(ctx?: ToolContext, args: Record<string, unknown> = {}): Promise<any> {
  const result = await registry.executeTool("mcp_browser_take_snapshot", args, { ctx });
  expect(result.isError).toBe(false);
  return JSON.parse(result.result!.split("\n")[1]);
}

function rootUri(name: string): string {
  return pathToFileURL(canonicalPath(join(directory, name))).href;
}

describe("MCP workspace transport isolation", () => {
  test("concurrent workspaces negotiate separate roots, cwd, tools and resources", async () => {
    const a = context("a"),
      b = context("b");
    await Promise.all([
      manager.connectAll(servers, {}, undefined, a),
      manager.connectAll(servers, {}, undefined, b),
    ]);
    const [first, second] = await Promise.all([call(a), call(b)]);
    expect(first.roots).toEqual([{ uri: rootUri("a") }]);
    expect(second.roots).toEqual([{ uri: rootUri("b") }]);
    expect(first.cwd).toBe(canonicalPath(a.cwd));
    expect(second.cwd).toBe(canonicalPath(b.cwd));
    expect(first.pid).not.toBe(second.pid);
    expect(manager.listServers()).toEqual(["browser"]);
    expect((await manager.listResources("browser", undefined, a))[0].name).toBe(first.cwd);
    expect(
      JSON.parse(await manager.readResource("browser", "test://workspace", undefined, b)).roots,
    ).toEqual(second.roots);
    await expect(manager.callTool("browser", "take_snapshot", {})).rejects.toThrow(
      "requires a workspace context",
    );
    await expect(manager.readResource("browser", "test://workspace")).rejects.toThrow(
      "requires a workspace context",
    );
    expect(await manager.listResources()).toEqual([]);
    const unconnected = context("a/sub");
    expect(
      (await registry.executeTool("mcp_browser_take_snapshot", {}, { ctx: unconnected })).isError,
    ).toBe(true);
  });

  test("canonical aliases share a connection and a closed owner cannot borrow its peer's connection", async () => {
    const a = context("a", false),
      ownerA = {},
      ownerB = {};
    symlinkSync(join(directory, "a"), join(directory, "alias"));
    const alias = context("alias", false);
    await Promise.all([
      manager.connectAll(servers, ownerA, undefined, a),
      manager.connectAll(servers, ownerB, undefined, alias),
    ]);
    const [first, second] = await Promise.all([call(a), call(alias)]);
    expect(first.pid).toBe(second.pid);
    const copiedContext = { ...a };
    await manager.unregisterOwner(ownerA);
    expect((await call(alias)).pid).toBe(second.pid);
    expect(
      (await registry.executeTool("mcp_browser_take_snapshot", {}, { ctx: copiedContext })).error,
    ).toContain("no longer active");
    await manager.unregisterOwner(ownerB);
    expect(manager.listServers()).toEqual([]);
    expect(registry.hasTool("mcp_browser_take_snapshot")).toBe(false);
  });

  test("switching an owner's workspace removes old authority and keeps another owner connected", async () => {
    const a = context("a"),
      b = context("b"),
      ownerA = {},
      ownerB = {};
    await Promise.all([
      manager.connectAll(servers, ownerA, undefined, a),
      manager.connectAll(servers, ownerB, undefined, b),
    ]);
    const first = await call(a),
      second = await call(b);
    const next = context("b");
    await manager.connectAll(servers, ownerA, undefined, next);
    expect((await call(next)).pid).toBe(second.pid);
    expect((await call(b)).pid).toBe(second.pid);
    expect(
      (await registry.executeTool("mcp_browser_take_snapshot", {}, { ctx: a })).error,
    ).toContain("no longer active");
    const remaining = await manager.callTool("browser", "take_snapshot", {});
    expect(String(remaining)).not.toContain(`"pid":${first.pid}`);
    await manager.unregisterOwner(ownerB);
    expect((await call(next)).pid).toBe(second.pid);
  });

  for (const explicit of [true, false])
    test(`cd reconnects only within original roots (explicit workspace=${explicit})`, async () => {
      const a = context("a", explicit),
        b = context("b", explicit),
        ownerA = {};
      await Promise.all([
        manager.connectAll(servers, ownerA, undefined, a),
        manager.connectAll(servers, {}, undefined, b),
      ]);
      const initial = await call(a);
      a.cwd = join(directory, "a/sub");
      const nested = await call(a);
      expect(nested.roots).toEqual(initial.roots);
      expect(nested.cwd).toBe(canonicalPath(a.cwd));
      expect(nested.pid).not.toBe(initial.pid);
      const copiedContext = { ...a };
      await manager.unregisterOwner(ownerA);
      expect(
        (await registry.executeTool("mcp_browser_take_snapshot", {}, { ctx: copiedContext })).error,
      ).toContain("no longer active");
      // Rebind for a fresh run, then try a live peer's different project cwd.
      a.cwd = join(directory, "a");
      await manager.connectAll(servers, ownerA, undefined, a);
      a.cwd = b.cwd;
      const denied = await registry.executeTool("mcp_browser_take_snapshot", {}, { ctx: a });
      expect(denied.isError).toBe(true);
      expect(denied.error).toContain("outside this run's workspace roots");
    });

  test("blank optional output stays inline and server-declared errors remain failed calls", async () => {
    const a = context("a");
    await manager.connectAll(servers, {}, undefined, a);
    expect((await call(a, { verbose: false, filePath: "" })).args).toEqual({ verbose: false });
    expect((await call(a, { filePath: join(a.cwd, "snapshot.txt") })).args.filePath).toBe(
      join(a.cwd, "snapshot.txt"),
    );
    const generic = await registry.executeTool(
      "MCPTool",
      { server: "browser", tool: "take_snapshot", arguments: { filePath: "" } },
      { ctx: a },
    );
    expect(generic.isError).toBe(false);
    expect(generic.result).toContain('"args":{}');
    for (const [name, args] of [
      ["mcp_browser_fail", {}],
      ["MCPTool", { server: "browser", tool: "fail" }],
    ] as const) {
      const failed = await registry.executeTool(name, args, { ctx: a });
      expect(failed.isError).toBe(true);
      expect(failed.error).toContain("Access denied by fixture roots");
    }
    const resource = await registry.executeTool(
      "ReadMcpResource",
      { server: "browser", uri: "test://workspace" },
      { ctx: a },
    );
    expect(resource.result).toContain(rootUri("a"));
  });

  test("host roots must be explicit absolute paths", () => {
    expect(() => mcpConnectionScope({ cwd: "relative" })).toThrow("absolute");
    const a = context("a");
    a.workspace!.roots = [];
    expect(() => mcpConnectionScope(a)).toThrow("nonempty absolute");
  });
});
