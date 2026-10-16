import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearModelTracingConfiguration,
  configureModelTracing,
  recordModelTraceEvent,
  withModelTraceContext,
} from "./context.js";
import type { ModelTraceStore } from "./store.js";
import { HookRegistry } from "../hooks/registry.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { ToolExecutor } from "../tool-system/executor.js";

let directory: string;
let store: ModelTraceStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "codeshell-tool-traces-"));
  store = configureModelTracing({ storageDir: directory });
  store.setConfig({ captureContent: true });
});
afterEach(() => {
  clearModelTracingConfiguration();
  rmSync(directory, { recursive: true, force: true });
});
const scope = <T>(operation: () => T) =>
  withModelTraceContext(
    { runId: "run-tools", sessionId: "session-tools", workspacePath: "/fixture" },
    operation,
  );
function setup() {
  const registry = new ToolRegistry({ builtinTools: [] });
  const hooks = new HookRegistry();
  registry.registerTool(
    {
      name: "SecretProbe",
      description: "fixture",
      inputSchema: { type: "object", additionalProperties: true },
      source: "builtin",
      permissionDefault: "allow",
      pathPolicyExempt: true,
    },
    async () => ({
      result: "private credential payload",
      sensitive: true,
      displayResult: "[withheld]",
    }),
  );
  return { registry, hooks };
}

test("tool spans retain effective hook input and redact sensitive output while the model receives the original result", async () => {
  const { registry, hooks } = setup();
  hooks.register("pre_tool_use", async () => ({ updatedInput: { value: "effective" } }));
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "bypassPermissions"),
    hooks,
  );
  const result = await scope(() =>
    executor.executeSingle({
      id: "model-tool",
      toolName: "SecretProbe",
      args: { value: "original" },
    }),
  );
  expect(result.result).toBe("private credential payload");
  const events = store.events("run-tools");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    sessionId: "session-tools",
    workspacePath: "/fixture",
    status: "completed",
    input: { toolCallId: "model-tool", args: { value: "effective" } },
    output: "[withheld]",
    outputState: "redacted",
  });
  expect(events[0].endedAt).toBeGreaterThanOrEqual(events[0].startedAt);
  expect(JSON.stringify(events)).not.toContain("private credential payload");
});

test("permission denial is recorded as a failed tool span without executing its handler", async () => {
  const { registry, hooks } = setup();
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([{ tool: "SecretProbe", decision: "deny" }], "default"),
    hooks,
  );
  const result = await scope(() =>
    executor.executeSingle({ id: "denied", toolName: "SecretProbe", args: {} }),
  );
  expect(result.isError).toBe(true);
  const [event] = store.events("run-tools");
  expect(event.status).toBe("failed");
  expect(event.error).toContain("denied");
  expect(event.output).toBeUndefined();
});

test("ephemeral tool events require the separate persistence opt-in", async () => {
  const { registry, hooks } = setup();
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "bypassPermissions"),
    hooks,
  );
  const run = () =>
    scope(() =>
      withModelTraceContext({ ephemeral: true }, () =>
        executor.executeSingle({ id: "temporary", toolName: "SecretProbe", args: {} }),
      ),
    );
  await run();
  expect(store.events("run-tools")).toEqual([]);
  store.setConfig({ includeEphemeral: true });
  await run();
  expect(store.events("run-tools")).toHaveLength(1);
});

test("tool continuations retain safe effective input after capture policy changes", async () => {
  const { registry, hooks } = setup();
  registry.registerTool(
    {
      name: "PolicyProbe",
      description: "fixture",
      inputSchema: { type: "object", additionalProperties: true },
      source: "builtin",
      permissionDefault: "allow",
      pathPolicyExempt: true,
    },
    async () => {
      store.setConfig({ captureContent: false });
      store.setConfig({ captureContent: true });
      return "PRIVATE_TOOL_AFTER_POLICY_CHANGE";
    },
  );
  hooks.register("pre_tool_use", async () => ({ updatedInput: { value: "SAFE_EFFECTIVE_INPUT" } }));
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "bypassPermissions"),
    hooks,
  );
  const result = await scope(() =>
    executor.executeSingle({
      id: "policy-call",
      toolName: "PolicyProbe",
      args: { value: "initial" },
    }),
  );
  expect(result.result).toBe("PRIVATE_TOOL_AFTER_POLICY_CHANGE");
  const [event] = store.events("run-tools");
  expect(event.status).toBe("completed");
  expect(event.input).toEqual({
    toolCallId: "policy-call",
    args: { value: "SAFE_EFFECTIVE_INPUT" },
  });
  expect(event.output).toBeUndefined();
  expect(event).not.toHaveProperty("first");
  expect(JSON.stringify(event)).not.toContain("PRIVATE_TOOL_AFTER_POLICY_CHANGE");
});

test("evicted and disabled tool spans cannot recreate capture policies from a running update", () => {
  scope(() => {
    const initial = recordModelTraceEvent({
      id: "safe-tool",
      first: true,
      kind: "tool",
      name: "Read",
      startedAt: Date.now(),
      status: "running",
      input: "SAFE_INITIAL_INPUT",
    })!;
    store.setConfig({ enabled: false });
    recordModelTraceEvent({
      id: "disabled-tool",
      first: true,
      kind: "tool",
      name: "Read",
      startedAt: initial.startedAt,
      status: "running",
      input: "PRIVATE_DISABLED_INPUT",
    });
    for (let index = 0; index < 4100; index++)
      recordModelTraceEvent({
        id: `other-${index}`,
        first: true,
        kind: "tool",
        name: "Other",
        startedAt: Date.now(),
        status: "running",
      });
    store.setConfig({ enabled: true });
    const updated = recordModelTraceEvent({
      ...initial,
      status: "running",
      input: "PRIVATE_RUNNING_UPDATE",
    });
    expect(updated?.input).toBe("SAFE_INITIAL_INPUT");
    const final = recordModelTraceEvent({
      ...initial,
      endedAt: Date.now(),
      status: "completed",
      output: "PRIVATE_TOOL_RESULT",
    });
    expect(final?.status).toBe("completed");
    expect(final?.input).toBe("SAFE_INITIAL_INPUT");
    expect(final?.output).toBeUndefined();
    expect(
      recordModelTraceEvent({
        id: "disabled-tool",
        kind: "tool",
        name: "Read",
        startedAt: initial.startedAt,
        status: "running",
        input: "PRIVATE_DISABLED_INPUT",
      }),
    ).toBeNull();
    expect(JSON.stringify(store.events("run-tools"))).not.toMatch(
      /PRIVATE_RUNNING_UPDATE|PRIVATE_TOOL_RESULT|PRIVATE_DISABLED_INPUT/,
    );
  });
});
