import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "./engine.js";
import { EngineRuntime } from "./runtime.js";
import { currentUsageOwner } from "../cost-ledger/context.js";
import { CostTracker } from "../cost-tracker.js";
import { ModelPool } from "../llm/model-pool.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { SettingsManager } from "../settings/manager.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse } from "../types.js";
import { AgentClient } from "../protocol/client.js";
import { AgentServer } from "../protocol/server.js";
import { createInProcessTransport } from "../protocol/transport.js";

const provider = "cost-engine-fixture";
let paidCalls = 0;
let parentCalls = 0;
const billedCalls: Array<{ sid: string; purpose: string }> = [];
let titleGate: Promise<void> | undefined;
let titleStarted: (() => void) | undefined;
class Client extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    paidCalls++;
    const owner = currentUsageOwner()!;
    billedCalls.push({ sid: owner.sessionId, purpose: owner.purpose });
    if (options.usagePurpose === "title") {
      titleStarted?.();
      await titleGate;
    }
    const spawn = options.tools?.some((t) => t.name === "CostChild") && parentCalls++ === 0;
    const usage = {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 40,
    };
    this.recordUsage(usage, options);
    return {
      text: spawn ? "" : "fixture answer",
      toolCalls: spawn ? [{ id: "child-call", toolName: "CostChild", args: {} }] : [],
      stopReason: spawn ? "tool_use" : "stop",
      usage,
    };
  }
}
registerProvider(provider, Client);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  paidCalls = 0;
  billedCalls.length = 0;
  parentCalls = 0;
  titleGate = undefined;
  titleStarted = undefined;
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), "engine-cost-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function config(root: string) {
  return {
    llm: { provider, providerKind: "openai", model: "gpt-4o", apiKey: "synthetic" },
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated" as const,
    headless: true,
    maxTurns: 3,
    customSystemPrompt: "Finish the fixture.",
    permissionMode: "bypassPermissions" as const,
    behaviorProfiles: [
      {
        id: "quiet",
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableMcp: true,
        disableSessionTitle: true,
      },
    ],
  };
}
function engine(root: string, runtime?: EngineRuntime) {
  const e = new Engine({ ...config(root), runtime });
  // Local receipt fixtures never execute installed user plugin hooks.
  e.getHookRegistry().clear();
  cleanups.push(() => e.dispose());
  return e;
}
function runtime(root: string) {
  const registry = new ToolRegistry({ builtinTools: [] });
  const value = new EngineRuntime({
    modelPool: new ModelPool(),
    toolRegistry: registry,
    mcpPool: new MCPManager(registry),
    settings: new SettingsManager(root, "isolated"),
    costTracker: new CostTracker(),
    usageStorageDir: join(root, "ledger"),
  });
  cleanups.push(() => value.close());
  return value;
}

test("real Engine child execution rolls up leaf costs once and keeps Session/Runtime views distinct", async () => {
  const root = directory();
  const rt = runtime(root);
  const parent = engine(root, rt);
  parent.registerCustomTool(
    {
      name: "CostChild",
      description: "Run one child",
      inputSchema: { type: "object", properties: {} },
      source: "builtin",
      permissionDefault: "allow",
    },
    async (_args, ctx) => {
      return (
        await ctx!.subAgentSpawner!.spawn({
          agentId: "cost-child",
          description: "cost child",
          prompt: "finish child",
          maxTurns: 1,
          signal: ctx!.signal ?? new AbortController().signal,
          toolAllowlist: [],
        })
      ).text;
    },
  );
  const result = await parent.run("Run the fixture", {
    sessionId: "cost-parent",
    behaviorMode: "quiet",
    clientMessageId: "input-1",
  });
  expect(result.reason).toBe("completed");
  expect(parent.getSessionManager().readParentSessionId("cost-child")).toBe("cost-parent");
  expect(
    billedCalls.filter((call) => call.sid === "cost-parent" && call.purpose === "main"),
  ).toHaveLength(2);
  expect(
    billedCalls.filter((call) => call.sid === "cost-child" && call.purpose === "subagent"),
  ).toHaveLength(1);
  for (const sid of ["cost-parent", "cost-child"]) {
    expect(parent.getUsageSummary({ scope: "session", sessionId: sid }).requests).toBe(
      billedCalls.filter((call) => call.sid === sid).length,
    );
  }
  expect(
    parent.getUsageSummary({ scope: "session", sessionId: "cost-parent", includeChildren: true })
      .requests,
  ).toBe(paidCalls);
  expect(rt.costTracker.getRequestCount()).toBe(paidCalls);
  expect(rt.usageLedger.summary().totalTokens).toBe(paidCalls * 120);
  expect(rt.usageLedger.summary().byPurpose.find((p) => p.purpose === "title")?.requests).toBe(1);
  expect(rt.usageLedger.summary().unknownCostRequests).toBe(0);
});

test("late title stays with its original Session while same SID in another identity bills separately", async () => {
  const root = directory();
  const rt = runtime(root);
  const a = engine(join(root, "alice"), rt);
  const b = engine(join(root, "bob"), rt);
  let release!: () => void;
  titleGate = new Promise<void>((resolve) => (release = resolve));
  const entered = new Promise<void>((resolve) => (titleStarted = resolve));
  await a.run("First question", { sessionId: "same-sid", onStream: () => {} });
  await entered;
  await b.run("Second question", { sessionId: "same-sid", behaviorMode: "quiet" });
  release();
  const deadline = Date.now() + 3000;
  while (a.getUsageSummary({ scope: "session", sessionId: "same-sid" }).requests < 2) {
    if (Date.now() > deadline) throw new Error("late title did not settle");
    await Bun.sleep(10);
  }
  expect(a.getUsageSummary({ scope: "session", sessionId: "same-sid" }).requests).toBe(2);
  expect(b.getUsageSummary({ scope: "session", sessionId: "same-sid" }).requests).toBe(1);
  expect(rt.usageLedger.summary().bySession).toHaveLength(2);
  await a.summarizeContextPackage(
    [{ role: "user", content: "summarize context" }],
    undefined,
    "same-sid",
  );
  expect(
    a
      .getUsageSummary({ scope: "session", sessionId: "same-sid" })
      .byPurpose.find((p) => p.purpose === "context_package")?.requests,
  ).toBe(1);
  expect(b.getUsageSummary({ scope: "session", sessionId: "same-sid" }).requests).toBe(1);
});

test("restart, input replay and fork do not import a cumulative Runtime bill", async () => {
  const root = directory();
  const first = engine(root);
  const result = await first.run("One question", {
    sessionId: "original",
    behaviorMode: "quiet",
    clientMessageId: "unique-input",
  });
  const saved = first.getSessionManager().readSessionState("original");
  expect(saved.costState?.kind).toBe("usage-ledger");
  await first.dispose();
  const restarted = engine(root);
  expect(restarted.getUsageSummary().requests).toBe(0);
  expect(restarted.getUsageSummary({ scope: "session", sessionId: "original" }).requests).toBe(1);
  const replay = await restarted.run("One question", {
    sessionId: "original",
    behaviorMode: "quiet",
    clientMessageId: "unique-input",
  });
  expect(replay.runId).toBe(result.runId);
  expect(paidCalls).toBe(1);
  const fork = restarted.forkSession("original", { targetSessionId: "forked" });
  expect(fork.bundle.state.parentSessionId).toBeNull();
  expect(restarted.getUsageSummary({ scope: "session", sessionId: "forked" }).requests).toBe(0);
  await restarted.run("Follow up", {
    sessionId: "forked",
    behaviorMode: "quiet",
    clientMessageId: "fork-input",
  });
  expect(restarted.getUsageSummary({ scope: "session", sessionId: "original" }).requests).toBe(1);
  expect(restarted.getUsageSummary({ scope: "session", sessionId: "forked" }).requests).toBe(1);
  expect(restarted.getUsageSummary().requests).toBe(1);
  expect(restarted.getUsageSummary({ scope: "store" }).requests).toBe(2);
});

test("protocol usage defaults to owned Session and rejects aggregate escalation and unbounded reads", async () => {
  const root = directory();
  const e = engine(root);
  await e.run("A question", { sessionId: "visible", behaviorMode: "quiet" });
  const [serverTransport, clientTransport] = createInProcessTransport();
  const server = new AgentServer({ engine: e, transport: serverTransport });
  cleanups.push(() => server.close());
  const client = new AgentClient({ transport: clientTransport });
  expect((await client.query("usage", { sessionId: "visible" })).data).toMatchObject({
    scope: "session",
    requests: 1,
  });
  await expect(client.query("usage")).rejects.toThrow("owned Session");
  await expect(client.query("usage", { scope: "store", sessionId: "visible" })).rejects.toThrow(
    "owned Session",
  );
  await expect(client.query("usage", { sessionId: "visible", limit: 10001 })).rejects.toThrow(
    "Invalid usage query",
  );
  await expect(client.query("usage", { sessionId: "missing" })).rejects.toThrow(
    "Session not found",
  );
  const [hostTransport, hostClientTransport] = createInProcessTransport();
  const hostServer = new AgentServer({
    engine: e,
    transport: hostTransport,
    allowUsageAggregation: true,
  });
  cleanups.push(() => hostServer.close());
  const hostClient = new AgentClient({ transport: hostClientTransport });
  expect((await hostClient.query("usage", { scope: "store" })).data).toMatchObject({
    requests: 1,
    scope: "store",
  });
  expect(paidCalls).toBe(1);
});

test("identity-bearing external tool billing updates the owning budget counters once", async () => {
  const root = directory();
  const e = engine(root);
  const input = {
    source: "external-tool",
    requestId: "physical-external-one",
    provider: "openai",
    model: "gpt-4o",
    usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
  };
  e.registerCustomTool(
    {
      name: "CostChild",
      description: "Record one external request",
      inputSchema: { type: "object", properties: {} },
      source: "builtin",
      permissionDefault: "allow",
    },
    async (_args, ctx) => {
      ctx!.recordExternalBilledUsage!(input);
      ctx!.recordExternalBilledUsage!(input);
      return "external result";
    },
  );
  const result = await e.run("Run the fixture", {
    sessionId: "external-owner",
    behaviorMode: "quiet",
  });
  const summary = e.getUsageSummary({ scope: "session", sessionId: "external-owner" });
  expect(summary.requests).toBe(paidCalls + 1);
  expect(summary.byPurpose.find((p) => p.purpose === "external")?.requests).toBe(1);
  expect(result.usage.totalTokens).toBe(paidCalls * 120 + 10);
});
