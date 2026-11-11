import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";
import type { AgentModule } from "../composition/types.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, Message, ToolCall, ToolDefinition } from "../types.js";

// Install before importing Core: no fixture can use operator credentials or paid endpoints.
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME)
  throw new Error("Private HOME required");
const originalFetch = globalThis.fetch;
const originalHttp = [http.request, http.get, https.request, https.get];
const guardMarker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousGuardMarker = Object.getOwnPropertyDescriptor(globalThis, guardMarker);
installLocalNetworkGuard("http://127.0.0.1:9");
expect(() => fetch("https://append-only-tools.invalid/")).toThrow("non-fixture");
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
const provider = "append-only-tools-fixture";
const behaviorMode = "quiet-append-only-tools";
const cleanups: Array<() => Promise<void> | void> = [];
const calls: Array<{ tools: ToolDefinition[]; systemPrompt: string; messages: Message[] }> = [];
const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
const script: Array<{ tools: ToolCall[]; text?: string; promptTokens?: number }> = [];
let summaryCalls = 0;

class Client extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    if (options.systemPrompt.includes("conversation summarizer")) {
      summaryCalls++;
      return {
        text: `The fixture discovered ComplexA and performed local checks. ${"condensed context ".repeat(12)}`,
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
      };
    }
    const owner = currentUsageOwner();
    if (owner?.purpose !== "main")
      throw new Error(`Unexpected fixture request purpose: ${owner?.purpose}`);
    const next = script.shift();
    if (!next) throw new Error("Unexpected model request: fixture script exhausted");
    calls.push(
      structuredClone({
        tools: options.tools ?? [],
        systemPrompt: options.systemPrompt,
        messages: options.messages,
      }),
    );
    const promptTokens = next.promptTokens ?? 100;
    const usage = { promptTokens, completionTokens: 10, totalTokens: promptTokens + 10 };
    this.recordUsage(usage, options);
    return {
      text: next.text ?? (next.tools.length ? "" : "Fixture complete."),
      toolCalls: next.tools,
      stopReason: next.tools.length ? "tool_use" : "stop",
      usage,
    };
  }
}
registerProvider(provider, Client);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  script.length = 0;
  calls.length = 0;
  executed.length = 0;
  summaryCalls = 0;
});

function directory() {
  const root = mkdtempSync(join(tmpdir(), "append-only-tools-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const fixtureModule: AgentModule = {
  id: "append-only-tools-fixture",
  engine: {
    defaultPreset: "append-only-tools-fixture",
    presets: [
      {
        name: "append-only-tools-fixture",
        label: "Append-only tools fixture",
        description: "Offline provider prefix contract",
        promptSections: [],
        builtinTools: ["ToolSearch", "complete_goal", "cancel_goal"],
        initialToolNames: ["ToolSearch", "Warmup", "complete_goal", "cancel_goal"],
        defaultPermissionRules: [],
        initialToolRouting: {
          managedToolNames: [
            "ToolSearch",
            "Warmup",
            "complete_goal",
            "cancel_goal",
            "RoutedAction",
          ],
          coreToolNames: ["ToolSearch", "Warmup", "complete_goal", "cancel_goal"],
          rules: [{ id: "routes", terms: ["catalog", "cron"], toolNames: ["RoutedAction"] }],
        },
      },
    ],
  },
};

const complexArgs = {
  operation: "inspect",
  target: { id: "fixture-1", labels: ["local", "cached"] },
  filters: [{ field: "count", operator: "gte", value: 3 }],
  options: { limit: 7, includeArchived: false },
};
const complexSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation: { type: "string", enum: ["inspect", "update"] },
    target: {
      type: "object",
      properties: { id: { type: "string" }, labels: { type: "array", items: { type: "string" } } },
      required: ["id"],
    },
    filters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          operator: { type: "string", enum: ["eq", "gte"] },
          value: { type: "number" },
        },
        required: ["field", "operator", "value"],
      },
    },
    options: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1 }, includeArchived: { type: "boolean" } },
    },
  },
  required: ["operation", "target", "filters"],
};

function registerAction(value: InstanceType<typeof Engine>, name: string, revision = "v1") {
  value.registerCustomTool(
    {
      name,
      description: `Local ${name} schema ${revision}`,
      inputSchema: name === "Warmup" ? { type: "object", properties: {} } : complexSchema,
      source: "builtin",
      permissionDefault: "allow",
    },
    async (args) => {
      const { __signal: _signal, ...modelArgs } = args;
      executed.push({ name, args: structuredClone(modelArgs) });
      return `Executed ${name}`;
    },
  );
}

function engine(
  root: string,
  options: { revision?: string; maxContextTokens?: number; model?: string; baseUrl?: string } = {},
) {
  const value = new Engine({
    llm: {
      provider,
      providerKind: "openai",
      model: options.model ?? "gpt-4o",
      apiKey: "synthetic-fixture-key",
      baseUrl: options.baseUrl,
    },
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: options.maxContextTokens ? "project" : "isolated",
    maxContextTokens: options.maxContextTokens,
    contextStrategy: "summary",
    headless: false,
    maxTurns: 24,
    customSystemPrompt: "Finish the local fixture.",
    permissionMode: "bypassPermissions",
    modules: [fixtureModule],
    behaviorProfiles: [
      {
        id: behaviorMode,
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableMemoryPipeline: true,
        disableCapabilityContext: true,
        disableSourcesContext: true,
        disableWorkspaceProfile: true,
        disableMcp: true,
        disableSessionTitle: true,
      },
    ],
  });
  value.getHookRegistry().clear();
  for (const name of ["Warmup", "ComplexA", "ComplexB", "ComplexC", "RoutedAction"])
    registerAction(value, name, options.revision);
  cleanups.push(() => value.dispose());
  return value;
}

function step(id: string, toolName: string, args: Record<string, unknown> = {}) {
  script.push({ tools: [{ id, toolName, args }] });
}
function select(name: string, id = `select-${name}`) {
  step(id, "ToolSearch", { query: `select:${name}` });
}
function invoke(name: string, id = `call-${name}`) {
  step(id, "CallTool", { name, args: structuredClone(complexArgs) });
}
function stop() {
  script.push({ tools: [] });
}

function stablePrefix(requests: typeof calls, baseline = requests[0]!) {
  const tools = JSON.stringify(baseline.tools);
  const system = JSON.stringify(baseline.systemPrompt);
  for (let index = 0; index < requests.length; index++) {
    const current = requests[index]!;
    expect(JSON.stringify(current.tools)).toBe(tools);
    expect(JSON.stringify(current.systemPrompt)).toBe(system);
    const previous = requests[index - 1];
    if (!previous) continue;
    expect(current.messages.length).toBeGreaterThan(previous.messages.length);
    expect(JSON.stringify(current.messages.slice(0, previous.messages.length))).toBe(
      JSON.stringify(previous.messages),
    );
  }
}

function toolResult(id: string, request = calls.at(-1)!) {
  return request.messages
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .find((block) => block.type === "tool_result" && block.tool_use_id === id);
}

function wireCalls(messages: Message[]) {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .filter((block) => block.type === "tool_use" && block.name === "CallTool");
}

test("three discovery batches append schemas and calls without changing one byte of earlier requests", async () => {
  const root = directory();
  const sessionId = "append-only-prefix";
  const first = engine(root);
  step("warmup-1", "Warmup");
  step("warmup-2", "Warmup");
  for (const name of ["ComplexA", "ComplexB", "ComplexC"]) {
    select(name);
    invoke(name);
  }
  stop();
  expect((await first.run("Run the local fixture", { sessionId, behaviorMode })).reason).toBe(
    "completed",
  );
  expect(script).toHaveLength(0);
  expect(calls).toHaveLength(9);
  stablePrefix(calls);
  expect(calls[0]!.tools.map((tool) => tool.name)).toContain("CallTool");
  expect(calls[0]!.tools.map((tool) => tool.name)).not.toContain("ComplexA");
  for (const name of ["ComplexA", "ComplexB", "ComplexC"]) {
    expect(executed).toContainEqual({ name, args: complexArgs });
    expect(toolResult(`select-${name}`)).toMatchObject({ type: "tool_result" });
    expect(toolResult(`select-${name}`)).not.toHaveProperty("is_error", true);
    expect(JSON.stringify(toolResult(`select-${name}`))).toContain("inputSchema");
    expect(JSON.stringify(toolResult(`select-${name}`))).toContain("includeArchived");
  }
  const wire = wireCalls(calls.at(-1)!.messages);
  expect(wire).toHaveLength(3);
  expect(wire[0]).toMatchObject({
    id: "call-ComplexA",
    name: "CallTool",
    input: { name: "ComplexA", args: complexArgs },
  });
  const state = first.getSessionManager().readSessionState(sessionId)!;
  expect(state.toolSelection).toMatchObject({
    version: 2,
    discovered: ["ComplexA", "ComplexB", "ComplexC"],
  });
  expect(state.toolSelection!.names).not.toContain("ComplexA");
  const transcript = readFileSync(join(root, "sessions", sessionId, "transcript.jsonl"), "utf8");
  expect(transcript).toContain('"name":"CallTool"');
  expect(transcript).toContain('"wireToolName":"CallTool"');

  const firstRequest = calls[0]!;
  const offset = calls.length;
  await first.dispose();
  const restarted = engine(root, { revision: "v2" });
  invoke("ComplexA", "restored-wrapper");
  step("restored-direct", "ComplexB", structuredClone(complexArgs));
  stop();
  expect(
    (await restarted.run("Continue the local fixture", { sessionId, behaviorMode })).reason,
  ).toBe("completed");
  stablePrefix(calls.slice(offset), firstRequest);
  expect(wireCalls(calls[offset]!.messages)).toEqual(wire);
  expect(executed.filter((entry) => entry.name === "ComplexA")).toHaveLength(2);
  expect(executed.filter((entry) => entry.name === "ComplexB")).toHaveLength(2);
  expect(toolResult("restored-wrapper")).not.toHaveProperty("is_error", true);
  expect(toolResult("restored-direct")).not.toHaveProperty("is_error", true);
});

test("summary compaction starts a new cycle and promotes discovered schemas before the next request", async () => {
  const root = directory();
  mkdirSync(join(root, ".code-shell"), { recursive: true });
  writeFileSync(
    join(root, ".code-shell/settings.json"),
    JSON.stringify({
      context: { compactAtRatio: 0.28, summarizeAtRatio: 0.99, microcompactFloorRatio: 0.28 },
    }),
  );
  const value = engine(root, { maxContextTokens: 10_000, model: "fixture-small-context" });
  const sessionId = "append-only-compaction";
  select("ComplexA");
  invoke("ComplexA");
  for (let index = 0; index < 10; index++) {
    script.push({
      tools: [{ id: `long-history-${index}`, toolName: "Warmup", args: {} }],
      text: `Local assistant history ${"substantial earlier context ".repeat(220)}${index}`,
      promptTokens: index < 9 ? 2_000 : 5_000,
    });
  }
  step("after-summary-direct", "ComplexA", structuredClone(complexArgs));
  stop();
  expect(
    (await value.run("Complete the long local fixture", { sessionId, behaviorMode })).reason,
  ).toBe("completed");
  expect(summaryCalls).toBeGreaterThan(0);
  const promotedAt = calls.findIndex((call) => call.tools.some((tool) => tool.name === "ComplexA"));
  expect(promotedAt).toBeGreaterThan(0);
  stablePrefix(calls.slice(0, promotedAt));
  expect(calls[promotedAt]!.tools.map((tool) => tool.name)).toContain("ComplexA");
  expect(value.getSessionManager().readSessionState(sessionId)!.toolSelection).toMatchObject({
    version: 2,
    discovered: [],
  });
  expect(value.getSessionManager().readSessionState(sessionId)!.toolSelection!.names).toContain(
    "ComplexA",
  );
  expect(executed.filter((entry) => entry.name === "ComplexA")).toHaveLength(2);
  expect(toolResult("after-summary-direct")).not.toHaveProperty("is_error", true);
  expect(script).toHaveLength(0);

  // The tool listing in the system prompt must move at the same boundary as
  // the schemas. Otherwise the first run after compaction changes the prefix
  // again, despite there being no intervening model switch or compaction.
  const cycle = calls[promotedAt]!;
  expect(cycle.systemPrompt).toContain("ComplexA");
  for (const request of calls.slice(promotedAt)) {
    expect(JSON.stringify(request.tools)).toBe(JSON.stringify(cycle.tools));
    expect(request.systemPrompt).toBe(cycle.systemPrompt);
  }
  let offset = calls.length;
  step("same-engine-after-summary", "ComplexA", structuredClone(complexArgs));
  stop();
  expect(
    (await value.run("Continue the compacted fixture", { sessionId, behaviorMode })).reason,
  ).toBe("completed");
  stablePrefix(calls.slice(offset), cycle);

  await value.dispose();
  const restarted = engine(root, {
    maxContextTokens: 100_000,
    model: "fixture-small-context",
    revision: "v2",
  });
  offset = calls.length;
  step("restarted-after-summary", "ComplexA", structuredClone(complexArgs));
  stop();
  expect(
    (await restarted.run("Resume the compacted fixture", { sessionId, behaviorMode })).reason,
  ).toBe("completed");
  stablePrefix(calls.slice(offset), cycle);
  expect(executed.filter((entry) => entry.name === "ComplexA")).toHaveLength(4);
  expect(script).toHaveLength(0);
});

for (const boundary of ["forceCompact", "archiveTurnRange", "appendArchiveMarker"] as const) {
  test(`${boundary} promotes removed discoveries durably and preserves the next cache cycle`, async () => {
    const root = directory();
    const sessionId = `append-only-manual-${boundary}`;
    const value = engine(root);
    select("ComplexA");
    invoke("ComplexA");
    for (let index = 0; index < 8; index++) {
      script.push({
        tools: [{ id: `manual-history-${index}`, toolName: "Warmup", args: {} }],
        text: `Earlier local history ${"substantial fixture context ".repeat(120)}${index}`,
      });
    }
    stop();
    expect(
      (
        await value.run("Discover and perform local work", {
          sessionId,
          behaviorMode,
          clientMessageId: "history-segment",
        })
      ).reason,
    ).toBe("completed");
    const firstRunCount = calls.length;
    stop();
    await value.run("Start the retained segment", {
      sessionId,
      behaviorMode,
      clientMessageId: "retained-segment",
    });
    expect(summaryCalls).toBe(0);
    expect(
      value.getSessionManager().readSessionState(sessionId)!.toolSelection!.discovered,
    ).toEqual(["ComplexA"]);
    stablePrefix(calls.slice(0, firstRunCount));
    stablePrefix(calls.slice(firstRunCount), calls[0]!);

    if (boundary === "forceCompact") {
      const result = await value.forceCompact(sessionId);
      expect(result.after).toBeLessThan(result.before);
      expect(summaryCalls).toBeGreaterThan(0);
    } else if (boundary === "archiveTurnRange") {
      const result = await value.archiveTurnRange(
        sessionId,
        { start: 0, end: 0 },
        {
          toClientMessageId: "retained-segment",
          segmentId: "tool-discovery-archive",
        },
      );
      expect(result.after).toBeLessThan(result.before);
      expect(summaryCalls).toBeGreaterThan(0);
    } else {
      expect(
        await value.appendArchiveMarker(sessionId, {
          toClientMessageId: "retained-segment",
          segmentId: "tool-discovery-archive",
          summary: `The fixture discovered ComplexA and completed earlier local work. ${"Retained decisions. ".repeat(8)}`,
        }),
      ).toBe(true);
      expect(summaryCalls).toBe(0);
    }
    const rebased = value.getSessionManager().readSessionState(sessionId)!.toolSelection!;
    expect(rebased.discovered).toEqual([]);
    expect(rebased.names).toContain("ComplexA");

    let offset = calls.length;
    step(`direct-after-${boundary}`, "ComplexA", structuredClone(complexArgs));
    stop();
    expect(
      (await value.run("Continue after the archive boundary", { sessionId, behaviorMode })).reason,
    ).toBe("completed");
    const cycle = calls[offset]!;
    expect(cycle.tools.map((tool) => tool.name)).toContain("ComplexA");
    expect(cycle.systemPrompt).toContain("ComplexA");
    expect(toolResult("select-ComplexA", cycle)).toBeUndefined();
    stablePrefix(calls.slice(offset), cycle);
    expect(toolResult(`direct-after-${boundary}`)).not.toHaveProperty("is_error", true);

    await value.dispose();
    const restarted = engine(root, { revision: "v2" });
    offset = calls.length;
    step(`restarted-after-${boundary}`, "ComplexA", structuredClone(complexArgs));
    stop();
    expect(
      (await restarted.run("Resume after the archive boundary", { sessionId, behaviorMode }))
        .reason,
    ).toBe("completed");
    stablePrefix(calls.slice(offset), cycle);
    expect(executed.filter((entry) => entry.name === "ComplexA")).toHaveLength(3);
    expect(script).toHaveLength(0);
  });
}

for (const change of ["model", "route"] as const) {
  test(`${change} changes start a new cycle and refresh promoted definitions`, async () => {
    const root = directory();
    const sessionId = `append-only-${change}`;
    const first = engine(root);
    select("ComplexA");
    stop();
    await first.run("Discover a local action", { sessionId, behaviorMode });
    const oldSelection = first.getSessionManager().readSessionState(sessionId)!.toolSelection!;
    expect(oldSelection.discovered).toEqual(["ComplexA"]);
    await first.dispose();

    const offset = calls.length;
    const next = engine(root, {
      revision: "v2",
      ...(change === "model" ? { model: "gpt-5.5" } : { baseUrl: "http://127.0.0.1:9/v2" }),
    });
    step(`after-${change}`, "ComplexA", structuredClone(complexArgs));
    stop();
    expect((await next.run("Use the discovered action", { sessionId, behaviorMode })).reason).toBe(
      "completed",
    );
    stablePrefix(calls.slice(offset));
    expect(calls[offset]!.tools.find((tool) => tool.name === "ComplexA")).toMatchObject({
      description: "Local ComplexA schema v2",
    });
    expect(next.getSessionManager().readSessionState(sessionId)!.toolSelection).toMatchObject({
      version: 2,
      discovered: [],
    });
    expect(executed).toContainEqual({ name: "ComplexA", args: complexArgs });
    expect(script).toHaveLength(0);
  });
}
