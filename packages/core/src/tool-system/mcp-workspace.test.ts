import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import { InitializeRequestSchema, ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
import { appendFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(join(directory, "starts.log"))}, process.pid + "\\n");
const server = new Server({ name: "chrome_devtools", version: "test" }, { capabilities: { tools: {}, resources: {} } });
if (existsSync(${JSON.stringify(join(directory, "block-initialize"))})) {
  server.setRequestHandler(InitializeRequestSchema, async () => {
    appendFileSync(${JSON.stringify(join(directory, "blocked-pids.log"))}, process.pid + "\\n");
    return new Promise(() => {});
  });
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: existsSync(${JSON.stringify(join(directory, "changed-catalog"))}) ? "read_snapshot" : "take_snapshot", inputSchema: { type: "object", properties: { verbose: { type: "boolean" }, filePath: { type: "string" } } } },
  { name: "fail", inputSchema: { type: "object", properties: {} } },
  { name: "crash", inputSchema: { type: "object", properties: {} } }
] }));
async function details(args) {
  const { roots } = await server.listRoots();
  return JSON.stringify({ roots, cwd: process.cwd(), pid: process.pid, args });
}
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "crash") {
    appendFileSync(${JSON.stringify(join(directory, "crashes.log"))}, "crash\\n");
    process.exit(1);
  }
  return {
    isError: request.params.name === "fail",
    content: [{ type: "text", text: request.params.name === "fail" ? "Access denied by fixture roots" : await details(request.params.arguments) }]
  };
});
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
  expect(result.isError, result.error ?? result.result).toBe(false);
  return JSON.parse(result.result!.split("\n")[1]);
}

function rootUri(name: string): string {
  return pathToFileURL(canonicalPath(join(directory, name))).href;
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe("MCP workspace transport isolation", () => {
  test("a closed transport reconnects on the next invocation without replaying the failed action", async () => {
    const a = context("a");
    await manager.connectAll(servers, {}, undefined, a);
    const first = await call(a);
    const failure = await registry.executeTool("mcp_browser_crash", {}, { ctx: a });
    expect(failure.isError).toBe(true);

    // A failed reconnect must retain the immutable Run declaration and tool
    // catalog for another explicit retry.
    const fixture = join(directory, "server.mjs");
    const source = readFileSync(fixture, "utf8");
    rmSync(fixture);
    const unavailable = await registry.executeTool("mcp_browser_take_snapshot", {}, { ctx: a });
    expect(unavailable.isError).toBe(true);
    writeFileSync(fixture, source);

    const second = await call(a);
    expect(second.pid).not.toBe(first.pid);
    expect(second.roots).toEqual(first.roots);
    expect(second.cwd).toBe(first.cwd);
    expect(readFileSync(join(directory, "crashes.log"), "utf8")).toBe("crash\n");
  });

  test("a no-context SDK call cannot reconnect a scoped server without its roots", async () => {
    const a = context("a");
    await manager.connectAll(servers, {}, undefined, a);
    const first = await call(a);
    expect((await registry.executeTool("mcp_browser_crash", {}, { ctx: a })).isError).toBe(true);
    await expect(manager.callToolResult("browser", "take_snapshot", {})).rejects.toThrow(
      "requires its workspace context to reconnect",
    );
    expect(readFileSync(join(directory, "starts.log"), "utf8").trim().split("\n")).toHaveLength(1);
    const second = await call(a);
    expect(second.roots).toEqual(first.roots);
    expect(second.cwd).toBe(first.cwd);
    expect(readFileSync(join(directory, "starts.log"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("a distinct caller signal cancels reconnect initialization and cleans up its child", async () => {
    const a = context("a");
    servers.browser.connectTimeoutMs = 3_000;
    servers.browser.connectRetries = 0;
    await manager.connectAll(servers, {}, undefined, a);
    const first = await call(a);
    expect((await registry.executeTool("mcp_browser_crash", {}, { ctx: a })).isError).toBe(true);
    writeFileSync(join(directory, "block-initialize"), "block");
    const caller = new AbortController();
    const recovery = manager
      .callToolResult("browser", "take_snapshot", {}, caller.signal, a)
      .catch((error) => error);
    const blockedPids = join(directory, "blocked-pids.log");
    try {
      await waitFor(() => existsSync(blockedPids), "reconnect did not reach blocked initialize");
      const pid = Number(readFileSync(blockedPids, "utf8").trim());
      expect(processIsAlive(pid)).toBe(true);
      expect(a.signal).toBeUndefined();
      const abortedAt = Date.now();
      caller.abort();
      const error = await recovery;
      expect(error.name).toBe("AbortError");
      expect(Date.now() - abortedAt).toBeLessThan(2_000);
      await waitFor(() => !processIsAlive(pid), "cancelled reconnect child is still alive");
      expect(registry.hasTool("mcp_browser_take_snapshot")).toBe(true);
      rmSync(join(directory, "block-initialize"));
      const second = await call(a);
      expect(second.pid).not.toBe(pid);
      expect(second.roots).toEqual(first.roots);
      expect(second.cwd).toBe(first.cwd);
    } finally {
      caller.abort();
      await recovery;
    }
  });

  test("successful reconnect removes schemas omitted by the replacement catalog", async () => {
    const a = context("a");
    await manager.connectAll(servers, {}, undefined, a);
    expect(registry.hasTool("mcp_browser_take_snapshot")).toBe(true);
    expect((await registry.executeTool("mcp_browser_crash", {}, { ctx: a })).isError).toBe(true);
    writeFileSync(join(directory, "changed-catalog"), "replace snapshot");
    await manager.callToolResult("browser", "read_snapshot", {}, undefined, a);
    expect(registry.hasTool("mcp_browser_read_snapshot")).toBe(true);
    expect(registry.hasTool("mcp_browser_take_snapshot")).toBe(false);
    const fork = new ToolRegistry();
    manager.syncToolsToRegistry(fork, a);
    expect(fork.hasTool("mcp_browser_read_snapshot")).toBe(true);
    expect(fork.hasTool("mcp_browser_take_snapshot")).toBe(false);
  });

  test("replacement catalog pruning retains tools still served by a peer workspace", async () => {
    const a = context("a"),
      b = context("b"),
      ownerA = {},
      ownerB = {};
    await Promise.all([
      manager.connectAll(servers, ownerA, undefined, a),
      manager.connectAll(servers, ownerB, undefined, b),
    ]);
    const peer = await call(b);
    expect((await registry.executeTool("mcp_browser_crash", {}, { ctx: a })).isError).toBe(true);
    writeFileSync(join(directory, "changed-catalog"), "replace snapshot");
    await manager.callToolResult("browser", "read_snapshot", {}, undefined, a);
    expect(registry.hasTool("mcp_browser_read_snapshot")).toBe(true);
    expect(registry.hasTool("mcp_browser_take_snapshot")).toBe(true);
    expect((await call(b)).pid).toBe(peer.pid);
    const firstFork = new ToolRegistry(),
      peerFork = new ToolRegistry();
    manager.syncToolsToRegistry(firstFork, a);
    manager.syncToolsToRegistry(peerFork, b);
    expect(firstFork.hasTool("mcp_browser_take_snapshot")).toBe(false);
    expect(firstFork.hasTool("mcp_browser_read_snapshot")).toBe(true);
    expect(peerFork.hasTool("mcp_browser_take_snapshot")).toBe(true);
    expect(peerFork.hasTool("mcp_browser_read_snapshot")).toBe(false);
    await manager.unregisterOwner(ownerB);
    expect(registry.hasTool("mcp_browser_take_snapshot")).toBe(false);
    expect(registry.hasTool("mcp_browser_read_snapshot")).toBe(true);
    expect((await manager.callToolResult("browser", "read_snapshot", {}, undefined, a)).ok).toBe(
      true,
    );
  });

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
