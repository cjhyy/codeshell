import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectRunMcp } from "./run-tooling.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { toolSearchTool } from "../tool-system/builtin/tool-search.js";
import { mcpToolExecute } from "../tool-system/builtin/mcp-tools.js";
import type { ToolContext } from "../tool-system/context.js";

let directory: string;
let fixture: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "codeshell-mcp-run-"));
  mkdirSync(join(directory, "a"));
  mkdirSync(join(directory, "b"));
  fixture = join(directory, "server.mjs");
  // A real stdio handshake isolates the regression from manager internals: the
  // Engine's registry is forked BEFORE the shared pool discovers any tools.
  writeFileSync(
    fixture,
    `
import { createInterface } from "node:readline";
import { basename } from "node:path";
const tool = "echo_" + basename(process.cwd());
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "test-echo", version: "1" }
  };
  else if (request.method === "tools/list") result = { tools: [{
    name: tool, description: "Echo from this workspace",
    inputSchema: { type: "object", properties: {} }
  }] };
  else if (request.method === "tools/call") result = {
    content: [{ type: "text", text: JSON.stringify({ tool: request.params.name, cwd: process.cwd() }) }]
  };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`,
  );
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function runHost(pool: MCPManager, registry: ToolRegistry, cwd: string) {
  let manager: MCPManager | undefined;
  const owner = {};
  const context = { cwd, toolRegistry: registry } as ToolContext;
  return {
    context,
    connect: () =>
      connectRunMcp({
        mcpServers: {
          fixture: {
            name: "fixture",
            command: process.execPath,
            args: [fixture],
            transport: "stdio",
          },
        },
        mcpDisabled: false,
        getManager: () => manager,
        setManager: (next) => {
          manager = next;
        },
        runtimePool: pool,
        toolRegistry: registry,
        toolContext: context,
        engineForConnect: owner,
        emitNotificationHook: () => {},
      }),
  };
}

describe("shared MCP pool supplies each run's local registry", () => {
  test("tools connected after the Engine fork become discoverable and executable", async () => {
    const shared = new ToolRegistry({ builtinTools: ["ToolSearch"] });
    const local = shared.fork();
    const pool = new MCPManager(shared);
    const run = runHost(pool, local, join(directory, "a"));
    try {
      expect(local.hasTool("mcp_fixture_echo_a")).toBe(false);
      await run.connect();
      expect(await toolSearchTool({ query: "select:mcp_fixture_echo_a" }, run.context)).toContain(
        "### mcp_fixture_echo_a",
      );
      const result = await local.executeTool("mcp_fixture_echo_a", {}, { ctx: run.context });
      expect(result.isError).toBe(false);
      expect(result.result).toContain('"tool":"echo_a"');
      expect(local.hasTool("ToolSearch")).toBe(true);
      // A child may construct a private manager after its parent connects.
      // The generic MCPTool must retain the parent's manager through copied
      // ToolContexts instead of following the process-wide last instance.
      const unrelated = new MCPManager(new ToolRegistry({ builtinTools: [] }));
      try {
        expect(
          await mcpToolExecute({ server: "fixture", tool: "echo_a" }, { ...run.context }),
        ).toContain('"tool":"echo_a"');
      } finally {
        await unrelated.disconnectAll();
      }
    } finally {
      await pool.disconnectAll();
    }
  });

  test("concurrent workspaces receive only their own schemas and preserve their local tools", async () => {
    const shared = new ToolRegistry({ builtinTools: ["ToolSearch"] });
    const a = shared.fork();
    const b = shared.fork();
    const pool = new MCPManager(shared);
    const first = runHost(pool, a, join(directory, "a"));
    const second = runHost(pool, b, join(directory, "b"));
    try {
      await Promise.all([first.connect(), second.connect()]);
      expect(a.listTools()).toEqual(["ToolSearch", "mcp_fixture_echo_a"]);
      expect(b.listTools()).toEqual(["ToolSearch", "mcp_fixture_echo_b"]);
      const results = await Promise.all([
        a.executeTool("mcp_fixture_echo_a", {}, { ctx: first.context }),
        b.executeTool("mcp_fixture_echo_b", {}, { ctx: second.context }),
      ]);
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(results[0].result).toContain('"tool":"echo_a"');
      expect(results[1].result).toContain('"tool":"echo_b"');
      // A later run refreshes an already-connected manager too.
      a.unregisterTool("mcp_fixture_echo_a");
      await first.connect();
      expect(a.hasTool("mcp_fixture_echo_a")).toBe(true);
    } finally {
      await pool.disconnectAll();
    }
  });
});
