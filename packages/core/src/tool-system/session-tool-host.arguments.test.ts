import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSessionToolHost, type SessionToolHost } from "./session-tool-host.js";
import { deriveExternalToolExposure } from "./external-tool-exposure.js";
import { ToolRegistry } from "./registry.js";
import { HookRegistry } from "../hooks/registry.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier } from "./permission.js";
import type { ToolContext } from "./context.js";

describe("external tool argument scope after hooks", () => {
  let registry: ToolRegistry;
  let hooks: HookRegistry;
  let invoked: string[];
  let hosts: SessionToolHost[];
  const forbidden = { action: "invoke", panel_id: "panel-app:unreviewed", tool_name: "dangerous" };
  function context(): Partial<ToolContext> {
    return {
      panels: {
        list: async () => ({ items: [] }),
        open: async () => ({ ok: true }),
        tools: async () => ({ items: [] }),
        invoke: async (panelId: string, toolName: string) => {
          invoked.push(`${panelId}:${toolName}`);
          return { ok: true, panelId, toolName, result: "done" };
        },
      },
    } as Partial<ToolContext>;
  }
  function host(options: Partial<Parameters<typeof createSessionToolHost>[0]> = {}) {
    const value = createSessionToolHost({
      businessSessionId: "argument-policy",
      cwd: process.cwd(),
      registry,
      hooks,
      permissionMode: "default",
      projectTrusted: true,
      settingsScope: "isolated",
      planMode: false,
      presetRules: [
        { tool: "Panel", decision: "allow" },
        { tool: "Parent", decision: "allow" },
      ],
      visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop" },
      exposure: deriveExternalToolExposure(registry),
      contextOverrides: context(),
      ...options,
    });
    hosts.push(value);
    return value;
  }
  beforeEach(() => {
    registry = new ToolRegistry({ builtinTools: ["Panel"] });
    hooks = new HookRegistry();
    invoked = [];
    hosts = [];
  });
  afterEach(async () => {
    await Promise.all(hosts.map((value) => value.dispose()));
  });

  test.each(["updatedInput", "in-place"] as const)(
    "pre_tool_use %s cannot turn Panel.list into unreviewed Panel.invoke",
    async (style) => {
      hooks.register("pre_tool_use", (ctx) => {
        if (style === "updatedInput") return { updatedInput: { ...forbidden } };
        Object.assign(ctx.data.args as Record<string, unknown>, forbidden);
        return {};
      });
      const result = await host().execute({
        id: "rewritten",
        name: "Panel",
        input: { action: "list" },
      });
      expect(result.isError).toBe(true);
      expect(result.error).toContain("outside the scope exposed");
      expect(invoked).toEqual([]);
    },
  );

  test("a rewrite inside the reviewed action scope remains usable", async () => {
    hooks.register("pre_tool_use", () => ({
      updatedInput: {
        action: "invoke",
        panel_id: "panel-app:job-hunt-hq",
        tool_name: "get_job_search_context",
      },
    }));
    const result = await host().execute({
      id: "reviewed",
      name: "Panel",
      input: { action: "list" },
    });
    expect(result.isError).toBe(false);
    expect(invoked).toEqual(["panel-app:job-hunt-hq:get_job_search_context"]);
  });

  test("an approval backend cannot mutate accepted args beyond reviewed scope", async () => {
    const value = host({
      presetRules: [{ tool: "Panel", decision: "ask" }],
      approvalBackend: {
        requestApproval: async (request) => {
          Object.assign(request.args, forbidden);
          return { approved: true };
        },
      },
    });
    const result = await value.execute({
      id: "approval-rewrite",
      name: "Panel",
      input: { action: "list" },
    });
    expect(result.error).toContain("outside the scope exposed");
    expect(invoked).toEqual([]);
  });

  test("nested bound calls inherit the same argument policy", async () => {
    registry.registerTool(
      {
        name: "Parent",
        description: "bound-call fixture",
        inputSchema: {},
        source: "builtin",
        permissionDefault: "allow",
      },
      async (_args, ctx) =>
        JSON.stringify(
          await ctx!.executeBoundTool!({ id: "nested", toolName: "Panel", args: forbidden }),
        ),
    );
    const reviewed = deriveExternalToolExposure(registry);
    const value = host({
      exposure: { ...reviewed, toolNames: new Set([...reviewed.toolNames, "Parent"]) },
    });
    const result = await value.execute({ id: "parent", name: "Parent", input: {} });
    expect(result.result).toContain("outside the scope exposed");
    expect(invoked).toEqual([]);
  });

  test("native execution without an external argument policy keeps its existing hook behavior", async () => {
    hooks.register("pre_tool_use", () => ({ updatedInput: { ...forbidden } }));
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier([{ tool: "Panel", decision: "allow" }], "default"),
      hooks,
    );
    executor.setContext({
      cwd: process.cwd(),
      toolRegistry: registry,
      ...context(),
      toolVisibility: { cwd: process.cwd(), hasGoal: false, host: "desktop" },
    } as ToolContext);
    const result = await executor.executeSingle({
      id: "native",
      toolName: "Panel",
      args: { action: "list" },
    });
    expect(result.isError).toBe(false);
    expect(invoked).toEqual(["panel-app:unreviewed:dangerous"]);
  });
});
