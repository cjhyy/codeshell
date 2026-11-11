import { describe, expect, test } from "bun:test";
import { StreamingToolQueue } from "../engine/streaming-tool-queue.js";
import { HookRegistry } from "../hooks/registry.js";
import type { ApprovalRequest, PermissionRule, RegisteredTool, ToolCall } from "../types.js";
import type { ToolContext } from "./context.js";
import { ToolExecutor } from "./executor.js";
import { PermissionClassifier } from "./permission.js";
import { ToolRegistry } from "./registry.js";
import { resolveModelToolCall, resolveModelToolCalls } from "./resolve-model-tool-call.js";
import { RunToolSurface } from "./run-tool-surface.js";

function definition(name = "DeferredRead", concurrencySafe = false): RegisteredTool {
  return {
    name,
    description: `${name} fixture`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    source: "builtin",
    permissionDefault: "allow",
    isConcurrencySafe: concurrencySafe,
  };
}

function wire(name: unknown = "DeferredRead", args: unknown = { value: "original" }): ToolCall {
  return { id: "wire-1", toolName: "CallTool", args: { name, args } };
}

function setup(options: { rules?: PermissionRule[]; planMode?: boolean } = {}) {
  const registry = new ToolRegistry({ builtinTools: [] });
  const ran: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const name of ["ToolSearch", "CallTool", "DeferredRead", "Write", "Bash"]) {
    registry.registerTool(definition(name), async (args) => {
      ran.push({ name, args });
      return `ran ${name}`;
    });
  }
  const surface = new RunToolSurface(["ToolSearch"]);
  surface.updateCatalog(registry.getToolDefinitions());
  surface.select(["DeferredRead", "Write", "Bash"]);
  const hooks = new HookRegistry();
  const approvals: ApprovalRequest[] = [];
  const permission = new PermissionClassifier(
    options.rules ?? [{ tool: "*", decision: "allow" }],
    "default",
    {
      requestApproval: async (request) => {
        approvals.push(request);
        return { approved: false, reason: "fixture approval refusal" };
      },
    },
  );
  const executor = new ToolExecutor(registry, permission, hooks);
  executor.setContext({
    runToolSurface: surface,
    modelToolNames: new Set(surface.snapshot().map((tool) => tool.name)),
    planMode: options.planMode,
  } as ToolContext);
  return { registry, surface, hooks, executor, ran, approvals };
}

function resolved(call: ToolCall, surface: RunToolSurface): ToolCall {
  const result = resolveModelToolCall(call, surface);
  if ("error" in result) throw new Error(result.error);
  return result.call;
}

function errorFor(call: ToolCall, surface: RunToolSurface): string {
  const result = resolveModelToolCall(call, surface);
  if ("call" in result) throw new Error("Expected resolution failure");
  return result.error;
}

describe("resolveModelToolCall", () => {
  test("unwraps once, preserves ID and wire history, and annotates the executed call", () => {
    const { surface } = setup();
    const call = wire();
    const original = JSON.stringify(call);
    expect(resolved(call, surface)).toEqual({
      id: call.id,
      toolName: "DeferredRead",
      args: { value: "original" },
      wireToolName: "CallTool",
    });
    expect(JSON.stringify(call)).toBe(original);
    expect(surface.snapshot().map((tool) => tool.name)).not.toContain("DeferredRead");
  });

  test.each([undefined, null, 7, {}, "", "CallTool"])(
    "rejects invalid or recursive target %j with usage guidance",
    (name) => {
      const { surface } = setup();
      // Do not use wire's default when testing the missing-name case.
      expect(errorFor({ ...wire(), args: { name, args: {} } }, surface)).toMatch(/exact tool name/);
    },
  );

  test("rejects incomplete provider JSON before unwrapping", () => {
    const { surface } = setup();
    expect(errorFor({ ...wire(), invalidArguments: true }, surface)).toMatch(/args object/);
  });

  test("rejects unavailable targets even if they were previously discovered", () => {
    const { surface, registry } = setup();
    surface.updateCatalog(
      registry.getToolDefinitions().filter((tool) => tool.name !== "DeferredRead"),
    );
    expect(errorFor(wire(), surface)).toBe(
      "Tool DeferredRead is not available in the current session context. Do NOT retry unless the relevant context changes.",
    );
  });

  test("rejects eligible but undiscovered targets with an exact select query", () => {
    const { surface, registry } = setup();
    registry.registerTool(definition("LaterTool"), async () => "must not run");
    surface.updateCatalog(registry.getToolDefinitions());
    expect(errorFor(wire("LaterTool"), surface)).toContain('query "select:LaterTool"');
  });

  test("parses a stringified args object exactly once", () => {
    const { surface } = setup();
    const args = { value: "decoded", filters: { ids: [1, 2], enabled: true } };
    expect(resolved(wire("DeferredRead", JSON.stringify(args)), surface).args).toEqual(args);
    expect(errorFor(wire("DeferredRead", JSON.stringify(JSON.stringify(args))), surface)).toContain(
      "JSON object",
    );
  });

  test.each(
    [undefined, null, 4, false, [], "broken JSON", "null", "[]", "42"].map((value) => ({ value })),
  )("rejects non-object args %j and includes the current input schema", ({ value: args }) => {
    const { surface } = setup();
    const error = errorFor({ ...wire(), args: { name: "DeferredRead", args } }, surface);
    expect(error).toContain("JSON object");
    expect(error).toContain(JSON.stringify(surface.getDefinition("DeferredRead")!.inputSchema));
  });

  test("batch resolution turns wrapper failures into tool errors without scheduling them", async () => {
    const { surface, executor, ran } = setup();
    const input = [wire("unknown"), { ...wire(), id: "valid-2" }];
    const batch = resolveModelToolCalls(input, surface);
    expect(batch.errors).toEqual([
      {
        id: "wire-1",
        toolName: "CallTool",
        isError: true,
        error: expect.stringContaining("not available"),
      },
    ]);
    const queue = new StreamingToolQueue(executor);
    batch.calls.forEach((call) => queue.enqueue(call));
    const results = await queue.drain();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "valid-2", toolName: "DeferredRead" });
    expect(ran.map((call) => call.name)).toEqual(["DeferredRead"]);
  });
});

describe("resolved calls retain execution policy", () => {
  test("permission rules apply to the real tool even when CallTool is allowed", async () => {
    const { surface, executor, ran } = setup({
      rules: [
        { tool: "DeferredRead", decision: "deny" },
        { tool: "CallTool", decision: "allow" },
      ],
    });
    const result = await executor.executeSingle(resolved(wire(), surface));
    expect(result.isError).toBe(true);
    expect(result.error).toContain("Permission denied for tool: DeferredRead");
    expect(ran).toHaveLength(0);
  });

  test("approval requests carry the real tool and unwrapped arguments", async () => {
    const { surface, executor, ran, approvals } = setup({
      rules: [{ tool: "DeferredRead", decision: "ask" }],
    });
    const result = await executor.executeSingle(resolved(wire(), surface));
    expect(result.isError).toBe(true);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ toolName: "DeferredRead", args: { value: "original" } });
    expect(ran).toHaveLength(0);
  });

  test("pre, permission and post hooks see the real name and may rewrite its arguments", async () => {
    const { surface, executor, hooks, ran } = setup();
    const seen: string[] = [];
    for (const event of ["pre_tool_use", "on_permission_check", "post_tool_use"] as const) {
      hooks.register(event, ({ data }) => {
        seen.push(`${event}:${data.toolName}`);
        return event === "pre_tool_use" ? { updatedInput: { value: "sanitized" } } : {};
      });
    }
    const result = await executor.executeSingle(resolved(wire(), surface));
    expect(result.isError).not.toBe(true);
    expect(seen).toEqual([
      "pre_tool_use:DeferredRead",
      "on_permission_check:DeferredRead",
      "post_tool_use:DeferredRead",
    ]);
    expect(ran).toMatchObject([{ name: "DeferredRead", args: { value: "sanitized" } }]);
  });

  test("plan mode rejects wrapped writes and write commands using their real tool policy", async () => {
    const { surface, executor, ran } = setup({ planMode: true });
    const write = await executor.executeSingle(resolved(wire("Write"), surface));
    expect(write.isError).toBe(true);
    expect(write.error).toContain("Plan mode: Write is blocked");
    const bash = await executor.executeSingle(
      resolved(wire("Bash", { value: "unused", command: "echo changed > output.txt" }), surface),
    );
    expect(bash.isError).toBe(true);
    expect(bash.error).toContain("Plan mode is read-only");
    expect(ran).toHaveLength(0);
  });

  test("a discovered real-name call executes even though it is absent from the frozen model tools", async () => {
    const { surface, executor, ran } = setup();
    const direct: ToolCall = {
      id: "direct-1",
      toolName: "DeferredRead",
      args: { value: "direct" },
    };
    expect(resolved(direct, surface)).toBe(direct);
    const result = await executor.executeSingle(direct);
    expect(result.isError).not.toBe(true);
    expect(ran).toMatchObject([{ name: "DeferredRead", args: { value: "direct" } }]);
  });

  test("executor validates against the current registered schema, including restored discoveries", async () => {
    const { surface, registry, executor, ran } = setup();
    const restored = new RunToolSurface(undefined, {
      selection: JSON.parse(JSON.stringify(surface.getSelection())),
    });
    restored.updateCatalog(registry.getToolDefinitions());
    registry.registerTool(
      {
        ...definition(),
        inputSchema: {
          type: "object",
          properties: { current: { type: "string" } },
          required: ["current"],
        },
      },
      async (args) => {
        ran.push({ name: "DeferredRead", args });
        return "current schema accepted";
      },
    );
    const rejected = await executor.executeSingle(resolved(wire(), restored));
    expect(rejected.isError).toBe(true);
    expect(rejected.error).toContain("Missing required parameter: current");
    const rejectedType = await executor.executeSingle(
      resolved(wire("DeferredRead", { current: 7 }), restored),
    );
    expect(rejectedType.isError).toBe(true);
    expect(rejectedType.error).toContain("must be a string");
    expect(ran).toHaveLength(0);
    const accepted = await executor.executeSingle(
      resolved(wire("DeferredRead", { current: "new" }), restored),
    );
    expect(accepted.isError).not.toBe(true);
    expect(ran).toMatchObject([{ name: "DeferredRead", args: { current: "new" } }]);
  });

  test("queue starts concurrent reads immediately and serializes unsafe targets after resolution", async () => {
    const { surface, registry, executor } = setup();
    const starts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writesActive = 0;
    let maxWritesActive = 0;
    registry.registerTool(definition("ConcurrentRead", true), async ({ value }) => {
      starts.push(`read:${value}`);
      await gate;
      return `read ${value}`;
    });
    registry.registerTool(definition("SequentialWrite"), async ({ value }) => {
      starts.push(`write:${value}`);
      maxWritesActive = Math.max(maxWritesActive, ++writesActive);
      await new Promise<void>((resolve) => setImmediate(resolve));
      writesActive--;
      return `write ${value}`;
    });
    surface.updateCatalog(registry.getToolDefinitions());
    surface.select(["ConcurrentRead", "SequentialWrite"]);
    const queue = new StreamingToolQueue(executor);
    for (const [id, name] of [
      ["a", "ConcurrentRead"],
      ["b", "ConcurrentRead"],
      ["c", "SequentialWrite"],
      ["d", "SequentialWrite"],
    ]) {
      queue.enqueue(resolved({ ...wire(name, { value: id }), id }, surface));
    }
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(starts).toEqual(["read:a", "read:b"]);
    } finally {
      release();
    }
    const results = await queue.drain();
    expect(starts).toEqual(["read:a", "read:b", "write:c", "write:d"]);
    expect(maxWritesActive).toBe(1);
    expect(results.map((result) => result.id)).toEqual(["a", "b", "c", "d"]);
    expect(results.every((result) => !result.isError)).toBe(true);
  });
});
