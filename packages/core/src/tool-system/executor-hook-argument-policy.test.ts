import { describe, expect, it } from "bun:test";
import { HookRegistry } from "../hooks/registry.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier } from "./permission.js";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./context.js";

function setup(toolName: string, context: Partial<ToolContext>) {
  const registry = new ToolRegistry({ builtinTools: [] });
  const calls: Record<string, unknown>[] = [];
  const properties = {
    command: { type: "string" },
    server: { type: "string" },
    tool: { type: "string" },
    uri: { type: "string" },
  };
  const required =
    toolName === "Bash"
      ? ["command"]
      : toolName === "MCPTool"
        ? ["server", "tool"]
        : toolName === "ReadMcpResource"
          ? ["server", "uri"]
          : [];
  registry.registerTool(
    {
      name: toolName,
      description: "fake handler: no shell or MCP connection is used",
      inputSchema: { type: "object", properties, required },
      source: "builtin",
      permissionDefault: "allow",
    },
    async (args) => {
      calls.push(args);
      return "ran";
    },
  );
  const hooks = new HookRegistry();
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "bypassPermissions"),
    hooks,
  );
  executor.setContext(context as ToolContext);
  const run = (args: Record<string, unknown>) =>
    executor.executeSingle({ id: "policy-call", toolName, args });
  return { calls, hooks, run };
}

describe("ToolExecutor effective input policy after pre_tool_use", () => {
  for (const inPlace of [false, true]) {
    it(`blocks a Plan write introduced by ${inPlace ? "in-place mutation" : "updatedInput"}`, async () => {
      const { calls, hooks, run } = setup("Bash", { planMode: true });
      let hookCalls = 0;
      hooks.register("pre_tool_use", ({ data }) => {
        hookCalls++;
        const rewritten = { command: "echo changed > output.txt" };
        if (inPlace) {
          Object.assign(data.args as Record<string, unknown>, rewritten);
          return {};
        }
        return { updatedInput: rewritten };
      });
      const result = await run({ command: "ls -la" });
      expect(result.isError).toBe(true);
      expect(result.error).toMatch(/read-only/);
      expect(calls).toHaveLength(0);
      expect(hookCalls).toBe(1);
    });
  }

  it("allows a read-only rewrite and emits pre_tool_use only once", async () => {
    const { calls, hooks, run } = setup("Bash", { planMode: true });
    let hookCalls = 0;
    hooks.register("pre_tool_use", () => {
      hookCalls++;
      return { updatedInput: { command: "pwd" } };
    });
    expect((await run({ command: "ls -la" })).isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "pwd" });
    expect(hookCalls).toBe(1);
  });

  it("keeps the early rejection of an initially blocked Plan call", async () => {
    const { calls, hooks, run } = setup("Bash", { planMode: true });
    let hookCalls = 0;
    hooks.register("pre_tool_use", () => {
      hookCalls++;
      return { updatedInput: { command: "pwd" } };
    });
    expect((await run({ command: "echo changed > output.txt" })).isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(hookCalls).toBe(0);
  });

  for (const toolName of ["MCPTool", "ReadMcpResource", "ListMcpResources"]) {
    for (const inPlace of [false, true]) {
      it(`rejects ${toolName} redirecting to a disabled server via ${inPlace ? "mutation" : "replacement"}`, async () => {
        const { calls, hooks, run } = setup(toolName, {
          allowedMcpServers: new Set(["enabled"]),
        });
        hooks.register("pre_tool_use", ({ data }) => {
          const args = { ...(data.args as Record<string, unknown>), server: "blocked" };
          if (inPlace) {
            Object.assign(data.args as Record<string, unknown>, args);
            return {};
          }
          return { updatedInput: args };
        });
        const result = await run({ server: "enabled", tool: "read", uri: "resource://one" });
        expect(result.isError).toBe(true);
        expect(result.error).toMatch(/not enabled/);
        expect(calls).toHaveLength(0);
      });
    }
  }

  it("rechecks an MCP tool policy on the rewritten tool argument", async () => {
    const { calls, hooks, run } = setup("MCPTool", {
      allowedMcpServers: new Set(["enabled"]),
      mcpToolPolicies: new Map([["enabled", { disabledTools: new Set(["write"]) }]]),
    });
    hooks.register("pre_tool_use", () => ({
      updatedInput: { server: "enabled", tool: "write" },
    }));
    const result = await run({ server: "enabled", tool: "read" });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/disabled/);
    expect(calls).toHaveLength(0);
  });

  for (const replacement of [{}, { __allowedMcpServers: new Set(["blocked"]) }]) {
    it("injects the trusted resource allowlist after replacement input", async () => {
      const allowed = new Set(["enabled"]);
      const { calls, hooks, run } = setup("ListMcpResources", {
        allowedMcpServers: allowed,
      });
      hooks.register("pre_tool_use", () => ({ updatedInput: replacement }));
      expect((await run({})).isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.__allowedMcpServers).toBe(allowed);
    });
  }

  it("still rejects a schema-invalid replacement before the handler", async () => {
    const { calls, hooks, run } = setup("Bash", { planMode: true });
    hooks.register("pre_tool_use", () => ({ updatedInput: { command: 42 } }));
    const result = await run({ command: "pwd" });
    expect(result.isError).toBe(true);
    expect(result.error).toMatch(/Invalid input.*pre_tool_use rewrite/);
    expect(calls).toHaveLength(0);
  });

  for (const event of ["on_permission_check", "on_tool_start"] as const) {
    it(`isolates Plan command mutations from ${event}`, async () => {
      const { calls, hooks, run } = setup("Bash", { planMode: true });
      hooks.register(event, ({ data }) => {
        (data.args as Record<string, unknown>).command = "echo changed > output.txt";
        return {};
      });
      expect((await run({ command: "pwd" })).isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe("pwd");
    });

    it(`isolates MCP targets and nested arguments from ${event}`, async () => {
      const { calls, hooks, run } = setup("MCPTool", {
        allowedMcpServers: new Set(["enabled"]),
      });
      hooks.register(event, ({ data }) => {
        const observed = data.args as Record<string, any>;
        observed.server = "blocked";
        observed.tool = "write";
        observed.arguments.path = "changed.txt";
        return {};
      });
      expect(
        (await run({ server: "enabled", tool: "read", arguments: { path: "original.txt" } }))
          .isError,
      ).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        server: "enabled",
        tool: "read",
        arguments: { path: "original.txt" },
      });
    });

    it(`does not expose the trusted resource allowlist to ${event} mutation`, async () => {
      const allowed = new Set(["enabled"]);
      const { calls, hooks, run } = setup("ListMcpResources", { allowedMcpServers: allowed });
      hooks.register(event, ({ data }) => {
        const observed = data.args as Record<string, any>;
        observed.server = "blocked";
        observed.__allowedMcpServers.add("blocked");
        return {};
      });
      expect((await run({})).isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.server).toBeUndefined();
      expect(calls[0]?.__allowedMcpServers).toBe(allowed);
      expect([...allowed]).toEqual(["enabled"]);
    });
  }

  for (const replacement of [false, true]) {
    it(`detaches effective input from references retained by pre_tool_use (${replacement})`, async () => {
      const { calls, hooks, run } = setup("MCPTool", {
        allowedMcpServers: new Set(["enabled"]),
      });
      let retained: Record<string, any>;
      hooks.register("pre_tool_use", ({ data }) => {
        retained = replacement
          ? { server: "enabled", tool: "read", arguments: { path: "original.txt" } }
          : (data.args as Record<string, any>);
        return replacement ? { updatedInput: retained } : {};
      });
      hooks.register("on_tool_start", () => {
        retained.server = "blocked";
        retained.arguments.path = "changed.txt";
        return {};
      });
      expect(
        (await run({ server: "enabled", tool: "read", arguments: { path: "original.txt" } }))
          .isError,
      ).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ server: "enabled", arguments: { path: "original.txt" } });
    });
  }
});
