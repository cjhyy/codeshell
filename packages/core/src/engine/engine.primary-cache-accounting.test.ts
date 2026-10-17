import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent, TokenUsage } from "../types.js";

// Install confinement before importing Core, which can initialize user services.
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME)
  throw new Error("Private HOME required");
const originalFetch = globalThis.fetch;
const originalHttp = [http.request, http.get, https.request, https.get];
const guardMarker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousGuardMarker = Object.getOwnPropertyDescriptor(globalThis, guardMarker);
installLocalNetworkGuard("http://127.0.0.1:9");
expect(() => fetch("https://cache-accounting.invalid/")).toThrow("non-fixture");
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
const { initialToolsFixtureModule } = await import("./initial-tools-preset.fixture.js");

const provider = "primary-cache-accounting-fixture";
const model = "gpt-4o";
const cleanups: Array<() => Promise<void> | void> = [];
const calls: Array<{ model: string; purpose: string; sessionId: string }> = [];
let primaryCalls = 0;
let mainPromptTokens = 1000;
let summarizeTool = false;
let auxiliaryGate: ReturnType<typeof gate> | undefined;
let primaryGate: ReturnType<typeof gate> | undefined;

function gate() {
  let release!: () => void;
  let entered!: () => void;
  return {
    released: new Promise<void>((resolve) => (release = resolve)),
    started: new Promise<void>((resolve) => (entered = resolve)),
    release: () => release(),
    enter: () => entered(),
  };
}

class Client extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const owner = currentUsageOwner();
    if (!owner) throw new Error("Fixture request is missing its billing owner");
    const auxiliary = owner.purpose === "context_package";
    if (!auxiliary && owner.purpose !== "main")
      throw new Error(`Unexpected fixture request purpose: ${owner.purpose}`);
    calls.push({ model: this.model, purpose: owner.purpose, sessionId: owner.sessionId });
    const requestGate = auxiliary ? auxiliaryGate : primaryGate;
    requestGate?.enter();
    await requestGate?.released;
    const usage: TokenUsage = auxiliary
      ? { promptTokens: 500, completionTokens: 10, totalTokens: 510, cacheReadTokens: 0 }
      : {
          promptTokens: mainPromptTokens,
          completionTokens: 20,
          totalTokens: mainPromptTokens + 20,
          cacheReadTokens: mainPromptTokens * 0.8,
        };
    this.recordUsage(usage, options);
    const useTool = !auxiliary && summarizeTool && primaryCalls++ === 0;
    return {
      text: auxiliary ? "Selected context summary." : useTool ? "" : "Fixture complete.",
      toolCalls: useTool
        ? [{ id: "cache-summary-call", toolName: "CacheFixtureSummary", args: {} }]
        : [],
      stopReason: useTool ? "tool_use" : "stop",
      usage,
    };
  }
}
registerProvider(provider, Client);

afterEach(async () => {
  auxiliaryGate?.release();
  primaryGate?.release();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  calls.length = 0;
  primaryCalls = 0;
  mainPromptTokens = 1000;
  summarizeTool = false;
  auxiliaryGate = undefined;
  primaryGate = undefined;
});

function directory() {
  const root = mkdtempSync(join(tmpdir(), "primary-cache-accounting-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function engine(root: string, withSummaryTool = false) {
  const value = new Engine({
    llm: { provider, providerKind: "openai", model, apiKey: "synthetic-fixture-key" },
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    headless: true,
    maxTurns: 3,
    customSystemPrompt: "Finish the local fixture.",
    permissionMode: "bypassPermissions",
    ...(withSummaryTool ? { modules: [initialToolsFixtureModule(["CacheFixtureSummary"])] } : {}),
    behaviorProfiles: [
      {
        id: "quiet-cache-fixture",
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableMcp: true,
        disableSessionTitle: true,
      },
    ],
  });
  value.getHookRegistry().clear();
  cleanups.push(() => value.dispose());
  return value;
}

type UsageEvent = Extract<StreamEvent, { type: "usage_update" }>;
function usageEvents(events: StreamEvent[]) {
  return events.filter((event): event is UsageEvent => event.type === "usage_update");
}

function expectCacheState(value: InstanceType<typeof Engine>, sid: string, promptTokens: number) {
  const state = value.getSessionManager().readSessionState(sid);
  expect(state).toMatchObject({
    cacheUsageVersion: 1,
    cumulativePromptTokens: promptTokens,
    cumulativeCacheReadTokens: promptTokens * 0.8,
    cumulativeCacheCreationTokens: 0,
  });
  return state;
}

test("same-model auxiliary usage is billed while live, final and restarted cache metrics stay foreground-only", async () => {
  const root = directory();
  const sid = "mixed-cache-session";
  const first = engine(root, true);
  const events: StreamEvent[] = [];
  mainPromptTokens = 500;
  summarizeTool = true;
  first.registerCustomTool(
    {
      name: "CacheFixtureSummary",
      description: "Summarize selected fixture context",
      inputSchema: { type: "object", properties: {} },
      source: "builtin",
      permissionDefault: "allow",
    },
    async () => {
      return (
        await first.summarizeContextPackage(
          [{ role: "user", content: "One selected context fact." }],
          undefined,
          sid,
        )
      ).summary;
    },
  );
  const result = await first.run("Complete the fixture using its summary tool", {
    sessionId: sid,
    behaviorMode: "quiet-cache-fixture",
    onStream: (event) => events.push(event),
  });
  expect(result.reason).toBe("completed");
  expect(calls).toEqual([
    { model, purpose: "main", sessionId: sid },
    { model, purpose: "context_package", sessionId: sid },
    { model, purpose: "main", sessionId: sid },
  ]);
  const updates = usageEvents(events);
  expect(updates).toContainEqual(
    expect.objectContaining({ singleTurnPromptTokens: 500, singleTurnCacheReadTokens: 400 }),
  );
  expect(updates.at(-1)).toMatchObject({
    singleTurnPromptTokens: 1000,
    singleTurnCacheReadTokens: 800,
    singleTurnCacheCreationTokens: 0,
  });
  const cumulative = updates.filter((event) => event.cumulativePromptTokens !== undefined);
  expect(cumulative.length).toBeGreaterThan(1);
  for (const update of cumulative) expect(update.cumulativeCacheHitRate).toBe(0.8);
  expect(cumulative.at(-1)).toMatchObject({
    cumulativePromptTokens: 1000,
    cumulativeCacheReadTokens: 800,
    cumulativeCacheHitRate: 0.8,
    sessionPromptTokens: 1000,
  });
  expect(expectCacheState(first, sid, 1000).tokenUsage).toMatchObject({
    promptTokens: 1500,
    completionTokens: 50,
    totalTokens: 1550,
  });
  expect(first.getUsageSummary({ scope: "session", sessionId: sid })).toMatchObject({
    requests: 3,
    promptTokens: 1500,
    totalTokens: 1550,
    cacheReadTokens: 800,
  });

  await first.dispose();
  const restarted = engine(root);
  expectCacheState(restarted, sid, 1000);
  expect(restarted.getUsageSummary({ scope: "session", sessionId: sid })).toMatchObject({
    requests: 3,
    promptTokens: 1500,
  });
  const restartedEvents: StreamEvent[] = [];
  const followup = await restarted.run("Continue the completed fixture", {
    sessionId: sid,
    behaviorMode: "quiet-cache-fixture",
    onStream: (event) => restartedEvents.push(event),
  });
  expect(followup.reason).toBe("completed");
  expect(expectCacheState(restarted, sid, 1500).tokenUsage.promptTokens).toBe(2000);
  expect(
    usageEvents(restartedEvents)
      .filter((event) => event.cumulativePromptTokens !== undefined)
      .at(-1),
  ).toMatchObject({
    cumulativePromptTokens: 1500,
    cumulativeCacheReadTokens: 1200,
    cumulativeCacheHitRate: 0.8,
  });
  expect(restarted.getUsageSummary({ scope: "session", sessionId: sid })).toMatchObject({
    requests: 4,
    promptTokens: 2000,
  });
});

test("an auxiliary response settling during the next run preserves cache counts and bills exactly once", async () => {
  const root = directory();
  const sid = "late-cache-session";
  const value = engine(root);
  expect(
    (
      await value.run("First fixture turn", {
        sessionId: sid,
        behaviorMode: "quiet-cache-fixture",
      })
    ).reason,
  ).toBe("completed");
  auxiliaryGate = gate();
  const auxiliary = value.summarizeContextPackage(
    [{ role: "user", content: "A previous turn's selected context." }],
    undefined,
    sid,
  );
  await auxiliaryGate.started;
  primaryGate = gate();
  const events: StreamEvent[] = [];
  const next = value.run("Second fixture turn", {
    sessionId: sid,
    behaviorMode: "quiet-cache-fixture",
    onStream: (event) => events.push(event),
  });
  await primaryGate.started;

  auxiliaryGate.release();
  await auxiliary;
  expect(expectCacheState(value, sid, 1000).tokenUsage.promptTokens).toBe(1500);
  expect(value.getUsageSummary({ scope: "session", sessionId: sid })).toMatchObject({
    requests: 2,
    promptTokens: 1500,
    cacheReadTokens: 800,
  });

  primaryGate.release();
  expect((await next).reason).toBe("completed");
  const saved = expectCacheState(value, sid, 2000);
  expect(saved.tokenUsage).toMatchObject({
    promptTokens: 2500,
    completionTokens: 50,
    totalTokens: 2550,
    cacheReadTokens: 1600,
  });
  const billing = value.getUsageSummary({ scope: "session", sessionId: sid });
  expect(billing).toMatchObject({ requests: 3, promptTokens: 2500, totalTokens: 2550 });
  expect(billing.byPurpose.find((row) => row.purpose === "context_package")).toMatchObject({
    requests: 1,
    promptTokens: 500,
    cacheReadTokens: 0,
  });
  const updates = usageEvents(events);
  expect(updates.at(-1)).toMatchObject({
    singleTurnPromptTokens: 1000,
    singleTurnCacheReadTokens: 800,
  });
  expect(
    updates.filter((event) => event.cumulativePromptTokens !== undefined).at(-1),
  ).toMatchObject({
    cumulativePromptTokens: 2000,
    cumulativeCacheReadTokens: 1600,
    cumulativeCacheHitRate: 0.8,
  });
  expect(calls.filter((call) => call.purpose === "context_package")).toEqual([
    { model, purpose: "context_package", sessionId: sid },
  ]);
});
