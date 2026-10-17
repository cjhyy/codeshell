import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";
import type { AgentModule } from "../composition/types.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, ToolCall, ToolDefinition } from "../types.js";

// Core services must never see operator credentials or a real provider endpoint.
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME)
  throw new Error("Private HOME required");
const originalFetch = globalThis.fetch;
const originalHttp = [http.request, http.get, https.request, https.get];
const guardMarker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousGuardMarker = Object.getOwnPropertyDescriptor(globalThis, guardMarker);
installLocalNetworkGuard("http://127.0.0.1:9");
expect(() => fetch("https://tool-selection-resume.invalid/")).toThrow("non-fixture");
expect(() => http.get("http://127.0.0.1:8/")).toThrow("non-fixture");
afterAll(() => {
  globalThis.fetch = originalFetch;
  [http.request, http.get, https.request, https.get] = originalHttp;
  if (previousGuardMarker) Object.defineProperty(globalThis, guardMarker, previousGuardMarker);
  else delete (globalThis as any)[guardMarker];
  syncBuiltinESMExports();
});

const { Engine } = await import("./engine.js");
const { LLMClientBase } = await import("../llm/client-base.js");
const { registerProvider } = await import("../llm/client-factory.js");
const { currentUsageOwner } = await import("../cost-ledger/context.js");

const provider = "tool-selection-resume-fixture";
const behaviorMode = "quiet-tool-selection-fixture";
const backgroundNotification =
  "<system-reminder>Background work finished. web source reminder cron schedule</system-reminder>";
const cleanups: Array<() => Promise<void> | void> = [];
const script: Array<ToolCall[]> = [];
const calls: Array<{ sessionId: string; tools: ToolDefinition[] }> = [];

class Client extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const owner = currentUsageOwner();
    if (owner?.purpose !== "main")
      throw new Error(`Unexpected fixture request purpose: ${owner?.purpose}`);
    const toolCalls = script.shift();
    if (!toolCalls) throw new Error("Unexpected model request: fixture script exhausted");
    calls.push({ sessionId: owner.sessionId, tools: structuredClone(options.tools ?? []) });
    const usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    this.recordUsage(usage, options);
    return {
      text: toolCalls.length ? "" : "Fixture complete.",
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "stop",
      usage,
    };
  }
}
registerProvider(provider, Client);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  script.length = 0;
  calls.length = 0;
});

function directory() {
  const root = mkdtempSync(join(tmpdir(), "tool-selection-resume-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const fixtureModule: AgentModule = {
  id: "tool-selection-resume-fixture",
  engine: {
    defaultPreset: "tool-selection-resume-fixture",
    presets: [
      {
        name: "tool-selection-resume-fixture",
        label: "Tool selection resume fixture",
        description: "Local tool surface lifecycle fixture",
        promptSections: [],
        builtinTools: ["ToolSearch"],
        initialToolNames: ["ToolSearch"],
        defaultPermissionRules: [],
        initialToolRouting: {
          managedToolNames: [
            "ToolSearch",
            "BaselineA",
            "BaselineB",
            "BaselineC",
            "BaselineD",
            "BaselineE",
            "BaselineF",
            "BaselineG",
            "CronList",
            "ListSources",
          ],
          coreToolNames: ["ToolSearch"],
          rules: [
            { id: "automation", terms: ["reminder", "cron"], toolNames: ["CronList"] },
            { id: "sources", terms: ["source"], toolNames: ["ListSources"] },
          ],
        },
      },
    ],
  },
};

function engine(root: string, revision = "v1") {
  const value = new Engine({
    llm: { provider, providerKind: "openai", model: "gpt-4o", apiKey: "synthetic-fixture-key" },
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    headless: false,
    maxTurns: 4,
    customSystemPrompt: "Finish the local fixture.",
    permissionMode: "bypassPermissions",
    modules: [fixtureModule],
    behaviorProfiles: [
      {
        id: behaviorMode,
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableCapabilityContext: true,
        disableSourcesContext: true,
        disableWorkspaceProfile: true,
        disableMcp: true,
        disableSessionTitle: true,
      },
    ],
  });
  value.getHookRegistry().clear();
  for (const name of ["CacheAction", "CheckQuotaMock", "CronList", "ListSources"]) {
    value.registerCustomTool(
      {
        name,
        description: `Local ${name} definition ${revision}`,
        inputSchema: {
          type: "object",
          properties: { revision: { type: "string", enum: [revision] } },
        },
        source: "builtin",
        permissionDefault: "allow",
      },
      async (_args, ctx) => {
        if (name === "CacheAction") ctx?.runYield?.request("background_notification");
        return "Local fixture result.";
      },
    );
  }
  cleanups.push(() => value.dispose());
  return value;
}

function completeNext() {
  script.push([]);
}

async function loadAndPark(value: InstanceType<typeof Engine>, sessionId: string) {
  script.push(
    [
      {
        id: "select-fixture-tools",
        toolName: "ToolSearch",
        args: { query: "select:CacheAction,CheckQuotaMock" },
      },
    ],
    [{ id: "launch-fixture-background", toolName: "CacheAction", args: {} }],
  );
  const result = await value.run("Perform the local fixture", { sessionId, behaviorMode });
  expect(result).toMatchObject({ reason: "completed", completionKind: "background_wait" });
  expect(script).toHaveLength(0);
  const definitions = calls.at(-1)!.tools;
  expect(definitions.map((tool) => tool.name)).toEqual([
    "ToolSearch",
    "CacheAction",
    "CheckQuotaMock",
  ]);
  expect(value.getSessionManager().readSessionState(sessionId)).toMatchObject({
    toolSelection: { version: 1, names: definitions.map((tool) => tool.name) },
  });
  return definitions;
}

test("background continuation keeps discovered definitions and order across runs and Engine restart", async () => {
  const root = directory();
  const sessionId = "background-tool-selection";
  const first = engine(root);
  const definitions = await loadAndPark(first, sessionId);

  completeNext();
  expect(
    (await first.run(backgroundNotification, { sessionId, behaviorMode, injected: true })).reason,
  ).toBe("completed");
  expect(calls.at(-1)!.tools).toEqual(definitions);

  await first.dispose();
  const restarted = engine(root);
  completeNext();
  expect(
    (await restarted.run(backgroundNotification, { sessionId, behaviorMode, injected: true }))
      .reason,
  ).toBe("completed");
  expect(calls.at(-1)!.tools).toEqual(definitions);
  expect(script).toHaveLength(0);
});

test("selection in the same batch as a background yield is saved before another model step", async () => {
  const root = directory();
  const sessionId = "same-batch-tool-selection";
  const first = engine(root);
  script.push(
    [
      {
        id: "select-background-action",
        toolName: "ToolSearch",
        args: { query: "select:CacheAction" },
      },
    ],
    [
      {
        id: "select-before-background-yield",
        toolName: "ToolSearch",
        args: { query: "select:CheckQuotaMock" },
      },
      { id: "yield-with-pending-selection", toolName: "CacheAction", args: {} },
    ],
  );
  expect(await first.run("Perform the local fixture", { sessionId, behaviorMode })).toMatchObject({
    reason: "completed",
    completionKind: "background_wait",
  });
  expect(script).toHaveLength(0);
  expect(calls).toHaveLength(2);
  // The newly selected schema has never been sent to the provider when the run parks.
  expect(calls.at(-1)!.tools.map((tool) => tool.name)).toEqual(["ToolSearch", "CacheAction"]);
  const selectedNames = ["ToolSearch", "CacheAction", "CheckQuotaMock"];
  expect(first.getSessionManager().readSessionState(sessionId)).toMatchObject({
    toolSelection: { version: 1, names: selectedNames },
  });

  await first.dispose();
  const restarted = engine(root);
  completeNext();
  expect(
    (await restarted.run(backgroundNotification, { sessionId, behaviorMode, injected: true }))
      .reason,
  ).toBe("completed");
  expect(calls.at(-1)!.tools.map((tool) => tool.name)).toEqual(selectedNames);
  expect(calls).toHaveLength(3);
});

test("a genuine new user intent appends routed tools without reordering previously loaded tools", async () => {
  const value = engine(directory());
  const sessionId = "new-user-tool-intent";
  const definitions = await loadAndPark(value, sessionId);
  completeNext();
  expect(
    (await value.run("Show the cron reminder and source catalog", { sessionId, behaviorMode }))
      .reason,
  ).toBe("completed");
  const nextDefinitions = calls.at(-1)!.tools;
  expect(nextDefinitions.slice(0, definitions.length)).toEqual(definitions);
  expect(nextDefinitions.map((tool) => tool.name)).toEqual([
    "ToolSearch",
    "CacheAction",
    "CheckQuotaMock",
    "CronList",
    "ListSources",
  ]);
  expect(value.getSessionManager().readSessionState(sessionId)).toMatchObject({
    toolSelection: { version: 1, names: nextDefinitions.map((tool) => tool.name) },
  });
});

test("another Session and a legacy injected continuation do not inherit or reroute tools", async () => {
  const value = engine(directory());
  await loadAndPark(value, "origin-tool-session");
  completeNext();
  expect(
    (await value.run("Perform another local fixture", { sessionId: "other-session", behaviorMode }))
      .reason,
  ).toBe("completed");
  expect(calls.at(-1)!.tools.map((tool) => tool.name)).toEqual(["ToolSearch"]);

  completeNext();
  expect(
    (
      await value.run(backgroundNotification, {
        sessionId: "legacy-background-session",
        behaviorMode,
        injected: true,
      })
    ).reason,
  ).toBe("completed");
  expect(calls.at(-1)!.tools.map((tool) => tool.name)).toEqual(["ToolSearch"]);
});

test("restored names respect the current allowlist and use current definitions after restart", async () => {
  const root = directory();
  const sessionId = "revoked-tool-selection";
  const first = engine(root);
  const definitions = await loadAndPark(first, sessionId);
  await first.dispose();

  const restarted = engine(root, "v2");
  completeNext();
  expect(
    (
      await restarted.run(backgroundNotification, {
        sessionId,
        behaviorMode,
        injected: true,
        toolAllowlist: ["ToolSearch", "CacheAction"],
      })
    ).reason,
  ).toBe("completed");
  const resumed = calls.at(-1)!.tools;
  expect(resumed.map((tool) => tool.name)).toEqual(["ToolSearch", "CacheAction"]);
  expect(resumed[0]).toEqual(definitions[0]);
  expect(resumed[1]).toMatchObject({
    description: "Local CacheAction definition v2",
    inputSchema: { properties: { revision: { enum: ["v2"] } } },
  });
  expect(resumed[1]).not.toEqual(definitions[1]);
});
