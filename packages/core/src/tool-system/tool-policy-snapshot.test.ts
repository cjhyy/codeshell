import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { BuiltinToolExposure } from "./builtin/index.js";
import { prepareToolPolicySnapshot } from "./prepare-tool-policy.js";
import { resolveToolPolicySnapshot } from "./tool-policy-snapshot.js";
import { buildToolVisibility, type ToolVisibilityInputs } from "./tool-visibility.js";
import { createSessionToolHost, type SessionToolHost } from "./session-tool-host.js";
import { assembleRunToolDefs } from "../engine/run-tooling.js";
import { HookRegistry } from "../hooks/registry.js";
import type { MCPServerConfig, StreamEvent } from "../types.js";
import { legacySingleRootWorkspace } from "../workspace/workspace-context.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("shared tool policy snapshot", () => {
  let cwd: string;
  let hosts: SessionToolHost[];
  let registry: ToolRegistry;
  let executions: string[];
  const mcpServers: Record<string, MCPServerConfig> = {
    trusted: { name: "trusted", allowedTools: ["read"], env: { SECRET: "PRIVATE_SECRET" } },
  };
  const exposure: BuiltinToolExposure = {
    presetTags: ["general"],
    featureFlag: "shell_tool",
    availability: (ctx) =>
      ctx.host === "desktop" && ctx.hasGoal && ctx.behaviorProfile === "review",
    rewriteDefinition: (definition, ctx) => ({
      ...definition,
      description: `Inspect ${String(ctx.profileMeta?.target ?? "none")}`,
      inputSchema: { type: "object", properties: { target: { enum: [ctx.profileMeta?.target] } } },
    }),
  };
  const names = [
    "ToolSearch",
    "Read",
    "ModuleInspect",
    "mcp_trusted_read",
    "mcp_trusted_missing",
    "mcp_other_read",
  ];
  function visibility(overrides: Partial<ToolVisibilityInputs> = {}): ToolVisibilityInputs {
    return {
      cwd,
      host: "desktop",
      hasGoal: true,
      behaviorProfile: "review",
      profileMeta: { target: "alpha" },
      ...overrides,
    };
  }
  function writeSettings(value: unknown) {
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    writeFileSync(join(cwd, ".code-shell", "settings.json"), JSON.stringify(value));
  }
  function makeHost(options: Partial<Parameters<typeof createSessionToolHost>[0]> = {}) {
    const host = createSessionToolHost({
      businessSessionId: "shared-policy",
      cwd,
      registry,
      projectTrusted: true,
      planMode: false,
      permissionMode: "default",
      settingsScope: "project",
      mcpServers,
      presetRules: names.map((tool) => ({ tool, decision: "allow" as const })),
      exposure: { mode: "allowlist", toolNames: new Set(names) },
      visibility: visibility(),
      hooks: new HookRegistry(),
      ...options,
    });
    hosts.push(host);
    return host;
  }
  function native(
    inputs: ToolVisibilityInputs,
    allowedToolNames: Set<string> | undefined,
    planMode = false,
    flags = {},
  ) {
    const ctx = { cwd } as ToolContext;
    return assembleRunToolDefs({
      toolRegistry: registry,
      toolCtx: ctx,
      guardCwd: cwd,
      hasRunnableGoal: inputs.hasGoal,
      settingsScope: "project",
      builtinToolHost: inputs.host,
      isSubAgent: false,
      behaviorProfileId: inputs.behaviorProfile,
      profileMeta: inputs.profileMeta,
      builtinOverride: undefined,
      mcpServers,
      mcpDisabled: false,
      featureFlags: flags,
      profileAllowedToolNames: allowedToolNames,
      runPlanMode: planMode,
    });
  }
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "shared-tool-policy-"));
    hosts = [];
    executions = [];
    registry = new ToolRegistry({ builtinTools: ["ToolSearch"] });
    for (const name of ["Read", "ModuleInspect", "PrivateModuleTool"]) {
      registry.registerTool(
        {
          name,
          description: "original",
          inputSchema: { type: "object", properties: {} },
          source: "builtin",
          permissionDefault: "allow",
        },
        async () => {
          executions.push(name);
          return "done";
        },
        name === "ModuleInspect" ? exposure : undefined,
      );
    }
    for (const [name, serverName, mcpToolName] of [
      ["mcp_trusted_read", "trusted", "read"],
      ["mcp_trusted_missing", "trusted", undefined],
      ["mcp_other_read", "other", "read"],
    ] as const) {
      registry.registerTool(
        {
          name,
          serverName,
          mcpToolName,
          source: "mcp",
          description: name,
          inputSchema: {},
          permissionDefault: "allow",
        },
        async () => {
          executions.push(name);
          return "done";
        },
      );
    }
  });
  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.dispose()));
    rmSync(cwd, { recursive: true, force: true });
  });

  test("prepared inputs round-trip as JSON without callbacks, transports or credentials", () => {
    const snapshot = prepareToolPolicySnapshot({
      registry,
      visibility: buildToolVisibility(visibility()),
      disabledBuiltinNames: [],
      mcpServers,
      mcpDisabled: false,
      featureFlags: {},
      planMode: false,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("PRIVATE_SECRET");
    expect(serialized).not.toContain("rewriteDefinition");
    expect(resolveToolPolicySnapshot(JSON.parse(serialized))).toEqual(
      resolveToolPolicySnapshot(snapshot),
    );
    const module = resolveToolPolicySnapshot(snapshot).find(
      (tool) => tool.name === "ModuleInspect",
    )!;
    expect(module.description).toBe("Inspect alpha");
    expect(module.inputSchema.properties).toEqual({ target: { enum: ["alpha"] } });
    expect(registry.getTool("ModuleInspect")!.description).toBe("original");
    expect(resolveToolPolicySnapshot(snapshot).map((tool) => tool.name)).not.toContain(
      "mcp_trusted_missing",
    );
    expect(resolveToolPolicySnapshot(snapshot).map((tool) => tool.name)).not.toContain(
      "mcp_other_read",
    );
  });

  test("pure resolution honors builtin/profile/plan narrowing without mutating its inputs", () => {
    const snapshot = prepareToolPolicySnapshot({
      registry,
      visibility: buildToolVisibility(visibility()),
      disabledBuiltinNames: ["Read"],
      allowedToolNames: ["Read", "ModuleInspect", "ToolSearch"],
      mcpServers,
      mcpDisabled: false,
      featureFlags: {},
      planMode: false,
    });
    const before = JSON.stringify(snapshot);
    expect(resolveToolPolicySnapshot(snapshot).map((tool) => tool.name)).toEqual([
      "ToolSearch",
      "ModuleInspect",
    ]);
    expect(
      resolveToolPolicySnapshot({ ...snapshot, planMode: true }).map((tool) => tool.name),
    ).toEqual(["ToolSearch"]);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  test("excluded tools never evaluate native-only availability callbacks", () => {
    registry.setExposure("PrivateModuleTool", {
      presetTags: [],
      availability: () => {
        throw new Error("native-only service unavailable");
      },
      rewriteDefinition: () => {
        throw new Error("native-only rewriter unavailable");
      },
    });
    const host = makeHost();
    expect(() => host.listTools()).not.toThrow();
    expect(host.listTools().map((tool) => tool.name)).not.toContain("PrivateModuleTool");
  });

  test("native and external surfaces have identical schemas inside the reviewed subset", async () => {
    for (const variant of [
      {},
      { flags: { shell_tool: false } },
      { inputs: { hasGoal: false } },
      { inputs: { behaviorProfile: "other" } },
      { planMode: true },
      { allowed: new Set(["ToolSearch", "Read"]) },
    ] as Array<{
      flags?: { shell_tool: boolean };
      inputs?: Partial<ToolVisibilityInputs>;
      planMode?: boolean;
      allowed?: Set<string>;
    }>) {
      const inputs = visibility(variant.inputs);
      writeSettings({ featureFlags: variant.flags ?? {} });
      const host = makeHost({
        visibility: inputs,
        planMode: variant.planMode ?? false,
        contextOverrides: { allowedToolNames: variant.allowed },
      });
      const expected = native(inputs, variant.allowed, variant.planMode, variant.flags).filter(
        (tool) => names.includes(tool.name),
      );
      expect(host.listTools()).toEqual(expected);
      for (const hidden of names.filter((name) => !expected.some((tool) => tool.name === name))) {
        expect((await host.execute({ id: hidden, name: hidden, input: {} })).isError).toBe(true);
      }
      expect(
        (await host.execute({ id: "private", name: "PrivateModuleTool", input: {} })).isError,
      ).toBe(true);
    }
    expect(executions).toEqual([]);
  });

  test("live visibility changes metadata and execution but cannot change stable host authority", async () => {
    let live = visibility({ hasGoal: false });
    const host = makeHost({ getVisibility: () => live });
    expect(host.listTools().some((tool) => tool.name === "ModuleInspect")).toBe(false);
    live = visibility({ profileMeta: { target: "beta" } });
    expect(host.listTools().find((tool) => tool.name === "ModuleInspect")!.description).toBe(
      "Inspect beta",
    );
    expect((await host.execute({ id: "live", name: "ModuleInspect", input: {} })).result).toBe(
      "done",
    );
    const unprivileged = makeHost({
      visibility: visibility({ host: "headless" }),
      getVisibility: () => live,
    });
    expect(unprivileged.listTools().some((tool) => tool.name === "ModuleInspect")).toBe(false);
    expect(
      (await unprivileged.execute({ id: "forged-host", name: "ModuleInspect", input: {} })).isError,
    ).toBe(true);
  });

  test("feature revocation while an approval waits blocks the handler", async () => {
    const asked = deferred();
    const resume = deferred<{ approved: boolean }>();
    const host = makeHost({
      presetRules: [{ tool: "ModuleInspect", decision: "ask" }],
      approvalBackend: {
        requestApproval: async () => {
          asked.resolve();
          return resume.promise;
        },
      },
    });
    const pending = host.execute({ id: "pending", name: "ModuleInspect", input: {} });
    await asked.promise;
    writeSettings({ featureFlags: { shell_tool: false } });
    resume.resolve({ approved: true });
    expect((await pending).error).toContain("no longer available");
    expect(executions).toEqual([]);
    expect(host.listTools().some((tool) => tool.name === "ModuleInspect")).toBe(false);
  });

  test("an explicit live workspace revocation clears both visibility and the call context", async () => {
    const initial = legacySingleRootWorkspace(cwd);
    let live = visibility({ workspace: initial });
    registry.registerTool(
      {
        name: "WorkspaceInspect",
        description: "workspace fixture",
        inputSchema: {},
        source: "builtin",
        permissionDefault: "allow",
      },
      async (_args, ctx) => ctx?.workspace?.projectId ?? "none",
      { presetTags: [] },
    );
    const host = makeHost({
      exposure: { mode: "allowlist", toolNames: new Set(["WorkspaceInspect"]) },
      presetRules: [{ tool: "WorkspaceInspect", decision: "allow" }],
      contextOverrides: { workspace: initial },
      getVisibility: () => live,
    });
    expect((await host.execute({ id: "bound", name: "WorkspaceInspect", input: {} })).result).toBe(
      initial.projectId,
    );
    live = visibility({ workspace: undefined });
    expect(
      (await host.execute({ id: "unbound", name: "WorkspaceInspect", input: {} })).result,
    ).toBe("none");
    expect(host.toolContext.workspace).toBe(initial);
  });

  test("a failed live Host context closes the tool stream without invoking the handler", async () => {
    const events: StreamEvent[] = [];
    const host = makeHost({
      getVisibility: () => {
        throw new Error("Workspace authority changed");
      },
      contextOverrides: {
        streamCallback: (event) => {
          events.push(event);
        },
      },
    });
    expect(() => host.listTools()).toThrow("Host context");
    const result = await host.execute({ id: "stale-context", name: "Read", input: {} });
    expect(result.isError).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["tool_use_start", "tool_result"]);
    expect(executions).toEqual([]);
  });

  test("configured MCP can narrow a trusted baseline but cannot grant a server or tool", async () => {
    writeSettings({ mcpServers: { trusted: { allowedTools: ["read"] }, other: {} } });
    const host = makeHost();
    expect(host.listTools().map((tool) => tool.name)).toContain("mcp_trusted_read");
    expect(host.listTools().map((tool) => tool.name)).not.toContain("mcp_other_read");
    expect(
      makeHost({ mcpServers: undefined })
        .listTools()
        .map((tool) => tool.name),
    ).not.toContain("mcp_trusted_read");
    writeSettings({ mcpServers: { trusted: { disabledTools: ["read"] } } });
    expect(host.listTools().map((tool) => tool.name)).not.toContain("mcp_trusted_read");
    expect((await host.execute({ id: "mcp", name: "mcp_trusted_read", input: {} })).isError).toBe(
      true,
    );
    writeSettings({ capabilityOverrides: { mcp: { trusted: "off", other: "on" } } });
    expect(host.listTools().map((tool) => tool.name)).not.toContain("mcp_trusted_read");
    expect(host.listTools().map((tool) => tool.name)).not.toContain("mcp_other_read");
  });

  test("unrestricted legacy MCP entries preserve native eligibility until a policy restricts them", () => {
    const unrestricted = { trusted: { name: "trusted" } };
    const host = makeHost({ mcpServers: unrestricted });
    const snapshot = prepareToolPolicySnapshot({
      registry,
      visibility: buildToolVisibility(visibility()),
      disabledBuiltinNames: [],
      mcpServers: unrestricted,
      mcpDisabled: false,
      featureFlags: {},
      planMode: false,
    });
    expect(resolveToolPolicySnapshot(snapshot).map((tool) => tool.name)).toContain(
      "mcp_trusted_missing",
    );
    expect(host.listTools().map((tool) => tool.name)).toContain("mcp_trusted_missing");
    writeSettings({ mcpServers: { trusted: { disabledTools: [] } } });
    expect(host.listTools().map((tool) => tool.name)).not.toContain("mcp_trusted_missing");
  });

  test("MCPTool argument policy is rechecked after approval, independently of its schema", async () => {
    registry.registerTool(
      {
        name: "MCPTool",
        description: "MCP dispatcher fixture",
        source: "builtin",
        permissionDefault: "ask",
        inputSchema: {},
      },
      async () => {
        executions.push("MCPTool");
        return "done";
      },
    );
    const asked = deferred();
    const resume = deferred<{ approved: boolean }>();
    const host = makeHost({
      exposure: { mode: "allowlist", toolNames: new Set(["MCPTool"]) },
      presetRules: [{ tool: "MCPTool", decision: "ask" }],
      approvalBackend: {
        requestApproval: async () => {
          asked.resolve();
          return resume.promise;
        },
      },
    });
    const pending = host.execute({
      id: "mcp-pending",
      name: "MCPTool",
      input: { server: "trusted", tool: "read" },
    });
    await asked.promise;
    writeSettings({ mcpServers: { trusted: { disabledTools: ["read"] } } });
    resume.resolve({ approved: true });
    expect((await pending).error).toContain("disabled by this project's tool policy");
    expect(executions).toEqual([]);
  });

  test("registry forks retain declarations and replacement cannot inherit stale authorization", () => {
    const fork = registry.fork();
    expect(fork.getExposure("ModuleInspect")).toBe(exposure);
    expect(fork.getAvailabilityGuard("ModuleInspect")).toBe(exposure.availability);
    const definition = registry.getTool("ModuleInspect")!;
    const disposeOld = fork.registerTool(definition, async () => "one", exposure);
    fork.registerTool(definition, async () => "two");
    disposeOld();
    expect(fork.hasTool("ModuleInspect")).toBe(true);
    expect(fork.getExposure("ModuleInspect")).toBeUndefined();
    expect(fork.getAvailabilityGuard("ModuleInspect")).toBeUndefined();
    expect(registry.getExposure("ModuleInspect")).toBe(exposure);
    fork.setExposure("ModuleInspect", exposure);
    fork.unregisterTool("ModuleInspect");
    expect(fork.getExposure("ModuleInspect")).toBeUndefined();
  });
});
