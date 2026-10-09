import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, mock, test } from "bun:test";
import { installLocalNetworkGuard } from "../../scripts/runtime-cost-smoke-isolation.mjs";
import type { EngineConfig, EngineResult } from "../../packages/core/src/engine/engine.js";
import type { CreateMessageOptions } from "../../packages/core/src/llm/types.js";
import type { LLMResponse, SessionState } from "../../packages/core/src/types.js";

// Run only through run-bun-test-shard: do not load Core against operator state.
const home = process.env.HOME!;
assert.equal(realpathSync(home), home);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
for (const key of Object.keys(process.env)) {
  assert.ok(!/^(https?_proxy|all_proxy|no_proxy)$/i.test(key));
  assert.ok(!/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PROVIDER_KEY)$/i.test(key));
}
const origin = "http://127.0.0.1:9"; // Identifies the fixture; no HTTP service is started.
installLocalNetworkGuard(origin);
let deniedRequests = 0;
const deny = () => {
  deniedRequests++;
  throw new Error("Active-close fixture denies every HTTP request");
};
globalThis.fetch = deny as typeof fetch;
for (const transport of [http, https]) {
  transport.request = deny as typeof transport.request;
  transport.get = deny as typeof transport.get;
}
syncBuiltinESMExports();
// Bun snapshots built-in named exports before syncBuiltinESMExports. Ensure later
// Core imports receive the same deny-all boundary as default/CJS HTTP imports.
mock.module("node:http", () => ({ ...http, default: http, request: deny, get: deny }));
mock.module("node:https", () => ({ ...https, default: https, request: deny, get: deny }));
const { request: namedRequest } = await import("node:http");
const { get: namedHttpsGet } = await import("node:https");
assert.equal(namedRequest, deny);
assert.equal(namedHttpsGet, deny);
const probes = [
  () => fetch(origin),
  () => fetch("https://example.invalid/negative-probe"),
  () => http.request(origin),
  () => namedRequest(new URL(origin)),
  () => http.get(origin),
  () => https.request("https://example.invalid/negative-probe"),
  () => https.get("https://example.invalid/negative-probe"),
  () => namedHttpsGet("https://example.invalid/negative-probe"),
];
for (const probe of probes) assert.throws(probe, /denies every HTTP request/);
assert.equal(deniedRequests, probes.length);
deniedRequests = 0;
const guard = {
  pid: process.pid,
  ppid: process.ppid,
  runtime: process.versions,
  homeId: createHash("sha256").update(home).digest("hex"),
  origin,
  negativeProbes: probes.length,
  privateHome: {
    actualHomeMatches: homedir() === home && realpathSync(home) === home,
    userProfileMatches: process.env.USERPROFILE === home,
    stateRootMatches: process.env.CODE_SHELL_HOME === join(home, ".code-shell"),
    testStateRootMatches: process.env.CODE_SHELL_TEST_HOME === process.env.CODE_SHELL_HOME,
    customDataRootAbsent: process.env.CODE_SHELL_DATA_ROOT === undefined,
  },
};
const evidenceDir = mkdtempSync(join(tmpdir(), "codeshell-active-close-evidence-"));
const preimportReceipt = join(evidenceDir, "preimport-guard.json");
writeFileSync(preimportReceipt, JSON.stringify({ phase: "before-Core-import", guard }) + "\n", {
  mode: 0o600,
});
console.log(`Active-close preimport evidence: ${preimportReceipt}`);

// Every Core runtime import follows the private-HOME checks and deny-all probes.
const { Engine } = await import("../../packages/core/src/engine/engine.js");
const { EngineRuntime } = await import("../../packages/core/src/engine/runtime.js");
const { ModelPool } = await import("../../packages/core/src/llm/model-pool.js");
const { SettingsManager } = await import("../../packages/core/src/settings/manager.js");
const { ToolRegistry } = await import("../../packages/core/src/tool-system/registry.js");
const { MCPManager } = await import("../../packages/core/src/tool-system/mcp-manager.js");
const { CostTracker } = await import("../../packages/core/src/cost-tracker.js");
const { LLMClientBase } = await import("../../packages/core/src/llm/client-base.js");
const { registerProvider } = await import("../../packages/core/src/llm/client-factory.js");
const { ChatSessionManager } =
  await import("../../packages/core/src/protocol/chat-session-manager.js");
const { SessionManager } = await import("../../packages/core/src/session/session-manager.js");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const provider = "active-close-in-memory-fixture";
const firstUsage = { promptTokens: 11, completionTokens: 7, totalTokens: 18, cacheReadTokens: 4 };
const nextUsage = { promptTokens: 13, completionTokens: 3, totalTokens: 16 };
let control: ReturnType<typeof makeControl>;
function makeControl() {
  return {
    entered: deferred(),
    aborted: deferred(),
    release: deferred(),
    sessionEntered: deferred(),
    sessionRelease: deferred(),
    finalEntered: deferred(),
    finalRelease: deferred(),
    titleEntered: deferred(),
    titleRelease: deferred(),
    titleReturned: deferred(),
    titleWritten: deferred(),
    blockMainCall: 1,
    normalGate: false,
    mainCalls: 0,
    progress: false,
    recordLateUsage: undefined as undefined | ((input: any) => unknown),
    calls: 0,
    events: [] as string[],
  };
}
class LocalClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    control.calls++;
    if (options.usagePurpose === "title") {
      control.titleEntered.resolve();
      await control.titleRelease.promise;
      const usage = { promptTokens: 5, completionTokens: 2, totalTokens: 7, cacheReadTokens: 1 };
      this.recordUsage(usage, options);
      control.titleReturned.resolve();
      return { text: "Synthetic title", toolCalls: [], stopReason: "stop", usage };
    }
    if (options.usagePurpose === "tool_summary") {
      const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      this.recordUsage(usage, options);
      return { text: "Local continuation", toolCalls: [], stopReason: "stop", usage };
    }
    const call = ++control.mainCalls;
    if (call === control.blockMainCall) {
      assert.ok(options.signal);
      control.entered.resolve();
      if (!control.normalGate) {
        await new Promise<void>((resolve) => {
          if (options.signal!.aborted) resolve();
          else options.signal!.addEventListener("abort", () => resolve(), { once: true });
        });
        control.aborted.resolve();
      }
      await control.release.promise;
      control.events.push(
        control.normalGate ? "normal-request-settled" : "cancelled-request-settled",
      );
    }
    const usage = call === 1 ? firstUsage : nextUsage;
    this.recordUsage(usage, options);
    const continueLocal = control.progress && call === 1;
    return {
      text: "Synthetic local result",
      toolCalls: continueLocal ? [{ id: "local-call", toolName: "ContinueLocal", args: {} }] : [],
      stopReason: continueLocal ? "tool_use" : "stop",
      usage,
    };
  }
}
registerProvider(provider, LocalClient);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  control?.release.resolve();
  control?.sessionRelease.resolve();
  control?.finalRelease.resolve();
  control?.titleRelease.resolve();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(
  name: string,
  resetControl = true,
  options: {
    sessionGate?: boolean;
    sessionFailure?: boolean;
    finalGate?: boolean;
    title?: boolean;
    progress?: boolean;
    maxTurns?: number;
  } = {},
) {
  if (resetControl) control = makeControl();
  if (options.progress) {
    control.progress = true;
    control.blockMainCall = 2;
  }
  const cwd = join(home, name);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const sessionsDir = join(cwd, "sessions");
  const registry = new ToolRegistry({ builtinTools: [] });
  const runtime = new EngineRuntime({
    modelPool: new ModelPool(),
    toolRegistry: registry,
    settings: new SettingsManager(cwd, "isolated"),
    mcpPool: new MCPManager(registry),
    costTracker: new CostTracker(),
  });
  const manager = new ChatSessionManager({
    runtime,
    engineFactory: () => {
      const engine = new Engine({
        llm: { provider, model: provider, apiKey: "synthetic" },
        cwd,
        runtime,
        settingsScope: "isolated",
        sessionStorageDir: sessionsDir,
        isSubAgent: true,
        headless: true,
        ...(options.progress ? { permissionMode: "bypassPermissions" } : {}),
        maxTurns: options.maxTurns ?? (options.progress ? 3 : 1),
        customSystemPrompt: "Finish the synthetic local fixture.",
        behaviorProfiles: [
          {
            id: "quiet",
            disableHooks: true,
            disableInstructions: true,
            disableMemoryContext: true,
            disableMcp: true,
            disableSessionTitle: !options.title,
          },
        ],
        modules: [
          {
            id: "close-proof",
            engine: {
              ...(options.sessionGate || options.sessionFailure
                ? {
                    privateService: {
                      scope: "session",
                      async create() {
                        if (options.sessionFailure) throw new Error("Synthetic activation failure");
                        control.sessionEntered.resolve();
                        await control.sessionRelease.promise;
                        return {};
                      },
                    },
                  }
                : {}),
              ...(options.finalGate
                ? {
                    hooks: [
                      {
                        event: "on_agent_end",
                        async handler() {
                          control.finalEntered.resolve();
                          await control.finalRelease.promise;
                          control.recordLateUsage?.({
                            source: "external-tool",
                            requestId: "late-own-aux",
                            provider,
                            model: provider,
                            usage: {
                              promptTokens: 5,
                              completionTokens: 2,
                              totalTokens: 7,
                              cacheReadTokens: 1,
                            },
                          });
                          return {};
                        },
                      },
                    ],
                  }
                : {}),
              ...(options.progress
                ? {
                    tools: [
                      {
                        kind: "always",
                        tool: {
                          definition: {
                            name: "ContinueLocal",
                            description: "Continue the local acceptance fixture",
                            inputSchema: { type: "object", properties: {} },
                            source: "builtin",
                            permissionDefault: "allow",
                          },
                          async execute(_args, ctx) {
                            control.recordLateUsage = ctx!.recordExternalBilledUsage;
                            return "Local continuation";
                          },
                        },
                      },
                    ],
                  }
                : {}),
            },
            activateEngine(ctx) {
              ctx.own(() => {
                control.events.push("engine-disposed");
              });
            },
          },
        ],
      } as EngineConfig);
      return engine;
    },
  });
  cleanups.push(async () => {
    await manager.closeAllAsync();
    await runtime.close();
  });
  return { manager, runtime, sessions: new SessionManager(sessionsDir), sid: name };
}
function stateFields(state: SessionState | undefined) {
  assert.ok(state);
  const {
    status,
    runId,
    turnSeq,
    turnCount,
    tokenUsage,
    cumulativePromptTokens,
    cumulativeCacheReadTokens,
    cumulativeCacheCreationTokens,
    lastCompletionKind,
    contextUsageAnchor,
    costState,
    completedSnapshotVersion,
    completedThroughEventId,
  } = state;
  return {
    status,
    runId,
    turnSeq,
    turnCount,
    tokenUsage,
    cumulativePromptTokens,
    cumulativeCacheReadTokens,
    cumulativeCacheCreationTokens,
    lastCompletionKind,
    contextUsageAnchor,
    costState,
    completedSnapshotVersion,
    completedThroughEventId,
  };
}
function record(name: string, data: object) {
  const path = join(evidenceDir, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        guard,
        calls: control.calls,
        events: control.events,
        deniedRequestsAfterProbes: deniedRequests,
        networkRequests: 0,
        workerProcesses: 0,
        ...data,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  expect(deniedRequests).toBe(0);
  console.log(`Active-close private evidence: ${path}`);
}
async function active(name: string) {
  const f = fixture(name);
  const chat = await f.manager.getOrCreate(f.sid, {});
  const turn = chat.enqueueTurn("Synthetic local acceptance", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
  });
  await control.entered.promise;
  const before = stateFields(f.sessions.readSessionState(f.sid));
  expect(before.status).toBe("active");
  return { ...f, chat, turn, before };
}
function receipt(sessions: InstanceType<typeof SessionManager>, sid: string): EngineResult {
  const value = sessions.resume(sid).transcript.findRunResultByClientMessageId("first-input");
  assert.ok(value);
  return value;
}

function expectFinalState(after: ReturnType<typeof stateFields>, result: EngineResult) {
  expect(result.reason).toBe("aborted_streaming");
  expect(after.status).toBe(result.reason);
  expect(after.tokenUsage).toEqual({ ...firstUsage, cacheCreationTokens: 0 });
  expect(after.turnCount).toBe(1);
  expect(after.cumulativePromptTokens).toBe(11);
  expect(after.cumulativeCacheReadTokens).toBe(4);
  expect(after.contextUsageAnchor).toMatchObject({ promptTokens: 11 });
  expect(after.costState).toMatchObject({
    kind: "usage-ledger",
    summary: { requests: 1, totalTokens: 18, unknownCostRequests: 1 },
  });
}

test("ordinary cancel persists the actual Engine terminal state and usage", async () => {
  const f = await active("ordinary-cancel");
  f.chat.cancel();
  await control.aborted.promise;
  control.release.resolve();
  const result = await f.turn;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { before: f.before, after, result, receipt: receipt(f.sessions, f.sid) });
  expectFinalState(after, result);
});

test("active individual close preserves terminal state and the immediate successor fence", async () => {
  const f = await active("individual-close");
  const oldWriter = f.chat.engine.getSessionManager();
  const oldState = oldWriter.readSessionState(f.sid)!;
  let closed = false;
  const closing = f.manager.close(f.sid);
  void closing.then(() => {
    closed = true;
  });
  const reopening = f.manager.getOrCreate(f.sid, {});
  let reopened = false;
  void reopening.then(() => {
    reopened = true;
  });
  await control.aborted.promise;
  expect(closed).toBe(false);
  expect(reopened).toBe(false);
  expect(oldWriter.saveState(oldState)).toBe(false); // Epoch must already be revoked.
  control.release.resolve();
  const result = await f.turn;
  await closing;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  const firstReceipt = receipt(f.sessions, f.sid);
  const successor = await reopening;
  const reopenedBeforeRun = stateFields(f.sessions.readSessionState(f.sid));
  const next = await successor.enqueueTurn("Synthetic successor", {
    behaviorMode: "quiet",
    clientMessageId: "successor-input",
  });
  const successorAfter = stateFields(f.sessions.readSessionState(f.sid));
  expect(oldWriter.saveState(oldState)).toBe(false);
  expect(
    oldWriter.saveStateOrUpdateFields(oldState, { status: "model_error" }, oldState.runId),
  ).toBe(false);
  record(f.sid, {
    before: f.before,
    after,
    result,
    receipt: firstReceipt,
    reopenedBeforeRun,
    next,
    successorAfter,
    oldWriterRejectedWhileClosing: true,
    oldWriterRejectedAfterSuccessor: true,
  });
  expect(next.reason).toBe("max_turns");
  expect(successorAfter.status).toBe(next.reason);
  expectFinalState(after, result);
  expect(reopenedBeforeRun).toEqual(after);
  expect(successorAfter.cumulativePromptTokens).toBe(24);
  expect(successorAfter.cumulativeCacheReadTokens).toBe(4);
  expect(successorAfter.contextUsageAnchor).toMatchObject({ promptTokens: 13 });
  expect(successorAfter.costState).toMatchObject({
    summary: { requests: 2, totalTokens: 34, promptTokens: 24, cacheReadTokens: 4 },
  });
});

test("active manager shutdown awaits finalization and persists terminal state", async () => {
  const f = await active("manager-shutdown");
  let closed = false;
  const closing = f.manager.closeAllAsync();
  void closing.then(() => {
    closed = true;
  });
  await control.aborted.promise;
  expect(closed).toBe(false);
  await expect(f.manager.getOrCreate(f.sid, {})).rejects.toThrow("closed");
  control.release.resolve();
  const result = await f.turn;
  await closing;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { before: f.before, after, result, receipt: receipt(f.sessions, f.sid) });
  expect(control.events).toEqual(["cancelled-request-settled", "engine-disposed"]);
  expectFinalState(after, result);
});

test("direct Runtime shutdown persists terminal state without a manager close epoch", async () => {
  const f = await active("runtime-shutdown");
  const closing = f.runtime.close();
  await control.aborted.promise;
  control.release.resolve();
  const result = await f.turn;
  await closing;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { before: f.before, after, result, receipt: receipt(f.sessions, f.sid) });
  expectFinalState(after, result);
});

test("a different actual Engine owner can replace the run without being overwritten by close", async () => {
  const f = await active("competing-owner");
  const closing = f.manager.close(f.sid);
  await control.aborted.promise;
  const competing = fixture(f.sid, false);
  const successor = await competing.manager.getOrCreate(f.sid, {});
  const next = await successor.enqueueTurn("Synthetic competing owner", {
    behaviorMode: "quiet",
    clientMessageId: "competing-input",
  });
  const winner = competing.sessions.readSessionState(f.sid)!;
  expect(next.reason).toBe("max_turns");
  expect(winner.runId).toBe(next.runId);
  control.release.resolve();
  const result = await f.turn;
  await closing;
  const after = competing.sessions.readSessionState(f.sid)!;
  record(f.sid, {
    before: f.before,
    result,
    receipt: receipt(f.sessions, f.sid),
    winner: stateFields(winner),
    after: stateFields(after),
  });
  expect(result.runId).not.toBe(next.runId);
  expect(result.usage.totalTokens).toBe(18);
  expect(after).toEqual(winner); // Includes the successor's revision/domain fields.
});

for (const phase of ["before", "after", "both"] as const) {
  test(`independent real ledger auxiliary usage survives ${phase} close intent`, async () => {
    const f = await active(`independent-aux-${phase}`);
    const anchor = { promptTokens: 999, messageCount: 9, estimateAtAnchor: 9, recordedAt: 9 };
    const addAux = (id: string, promptTokens: number) => {
      const usage = {
        promptTokens,
        completionTokens: 2,
        totalTokens: promptTokens + 2,
        cacheReadTokens: 1,
      };
      f.chat.engine.recordExternalUsage(f.sid, {
        source: "external-tool",
        requestId: id,
        provider,
        model: provider,
        usage,
      });
      f.sessions.recordAuxiliaryUsage(f.sid, usage);
      f.sessions.updateSessionState(f.sid, {
        contextUsageAnchor: anchor,
        title: "Independent title",
        workspaceProfile: "independent-profile",
      });
      return usage;
    };
    let extraPrompt = 0;
    let extraTotal = 0;
    let auxCalls = 0;
    if (phase !== "after") {
      const usage = addAux("before-close", 5);
      extraPrompt += usage.promptTokens;
      extraTotal += usage.totalTokens;
      auxCalls++;
    }
    const closing = f.manager.close(f.sid);
    await control.aborted.promise;
    if (phase !== "before") {
      const usage = addAux("after-close", 9);
      extraPrompt += usage.promptTokens;
      extraTotal += usage.totalTokens;
      auxCalls++;
    }
    control.release.resolve();
    const result = await f.turn;
    await closing;
    const after = stateFields(f.sessions.readSessionState(f.sid));
    record(f.sid, { after, result, receipt: receipt(f.sessions, f.sid) });
    expect(after.status).toBe("aborted_streaming");
    expect(after.tokenUsage.totalTokens).toBe(18 + extraTotal);
    expect(after.cumulativePromptTokens).toBe(11 + extraPrompt);
    expect(after.cumulativeCacheReadTokens).toBe(4 + auxCalls);
    expect(after.contextUsageAnchor).toEqual(anchor);
    expect(after.costState).toMatchObject({
      summary: { requests: 1 + auxCalls, totalTokens: 18 + extraTotal },
    });
    expect(f.sessions.readSessionState(f.sid)).toMatchObject({
      title: "Independent title",
      workspaceProfile: "independent-profile",
    });
  });
}

test("a previous run's real delayed title billing does not become the next run's checkpoint", async () => {
  const f = fixture("previous-run-title", true, { title: true });
  control.blockMainCall = 2;
  const chat = await f.manager.getOrCreate(f.sid, {});
  const first = await chat.enqueueTurn("Synthetic first run", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
    onStream: (event) => {
      if (event.type === "session_title") control.titleWritten.resolve();
    },
  });
  await control.titleEntered.promise;
  const secondTurn = chat.enqueueTurn("Synthetic second run", {
    behaviorMode: "quiet",
    clientMessageId: "second-input",
  });
  await control.entered.promise;
  control.titleRelease.resolve();
  await control.titleWritten.promise;
  const beforeClose = stateFields(f.sessions.readSessionState(f.sid));
  expect(beforeClose.tokenUsage.totalTokens).toBe(25);
  const closing = f.manager.close(f.sid);
  await control.aborted.promise;
  control.release.resolve();
  const second = await secondTurn;
  await closing;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { first, beforeClose, second, after });
  expect(after.status).toBe("aborted_streaming");
  expect(after.tokenUsage.totalTokens).toBe(41);
  expect(after.cumulativePromptTokens).toBe(29);
  expect(after.cumulativeCacheReadTokens).toBe(5);
  expect(after.costState).toMatchObject({ summary: { requests: 3, totalTokens: 41 } });
});

test("a normal next run retains previous-run delayed title usage in disk and live cumulative updates", async () => {
  const f = fixture("normal-previous-run-title", true, { title: true, maxTurns: 2 });
  control.blockMainCall = 2;
  control.normalGate = true;
  const chat = await f.manager.getOrCreate(f.sid, {});
  const first = await chat.enqueueTurn("Synthetic first run", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
    onStream: (event) => {
      if (event.type === "session_title") control.titleWritten.resolve();
    },
  });
  await control.titleEntered.promise;
  const updates: unknown[] = [];
  const secondTurn = chat.enqueueTurn("Synthetic second run", {
    behaviorMode: "quiet",
    clientMessageId: "second-input",
    onStream: (event) => {
      if (event.type === "usage_update" && event.cumulativePromptTokens !== undefined)
        updates.push(event);
    },
  });
  await control.entered.promise;
  control.titleRelease.resolve();
  await control.titleWritten.promise;
  const afterAux = stateFields(f.sessions.readSessionState(f.sid));
  expect(afterAux.tokenUsage.totalTokens).toBe(25);
  control.release.resolve();
  const second = await secondTurn;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { first, afterAux, second, after, updates, receipt: receipt(f.sessions, f.sid) });
  expect(second.reason).toBe("completed");
  expect(after.tokenUsage.totalTokens).toBe(41);
  expect(after.cumulativePromptTokens).toBe(29);
  expect(after.cumulativeCacheReadTokens).toBe(5);
  expect(updates.at(-1)).toMatchObject({
    cumulativePromptTokens: 29,
    cumulativeCacheReadTokens: 5,
  });
  expect(after.costState).toMatchObject({ summary: { requests: 3, totalTokens: 41 } });
});

test("normal progress preserves independent usage between checkpoints without counting it twice at finalization", async () => {
  const f = fixture("normal-progress-independent-aux", true, { progress: true });
  control.normalGate = true;
  const chat = await f.manager.getOrCreate(f.sid, {});
  const updates: unknown[] = [];
  const turn = chat.enqueueTurn("Synthetic continuation", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
    toolAllowlist: ["ContinueLocal"],
    onStream: (event) => {
      if (event.type === "usage_update" && event.cumulativePromptTokens !== undefined)
        updates.push(event);
    },
  });
  await control.entered.promise;
  const firstCheckpoint = stateFields(f.sessions.readSessionState(f.sid));
  expect(firstCheckpoint.tokenUsage.totalTokens).toBe(18);
  const usage = { promptTokens: 5, completionTokens: 2, totalTokens: 7, cacheReadTokens: 1 };
  chat.engine.recordExternalUsage(f.sid, {
    source: "external-tool",
    requestId: "independent-between-checkpoints",
    provider,
    model: provider,
    usage,
  });
  f.sessions.recordAuxiliaryUsage(f.sid, usage);
  const afterAux = stateFields(f.sessions.readSessionState(f.sid));
  expect(afterAux.tokenUsage.totalTokens).toBe(25);
  control.release.resolve();
  const result = await turn;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, {
    firstCheckpoint,
    afterAux,
    result,
    after,
    updates,
    receipt: receipt(f.sessions, f.sid),
  });
  expect(result.reason).toBe("completed");
  expect(after.tokenUsage.totalTokens).toBe(41);
  expect(after.cumulativePromptTokens).toBe(29);
  expect(after.cumulativeCacheReadTokens).toBe(5);
  expect(updates.at(-1)).toMatchObject({
    cumulativePromptTokens: 29,
    cumulativeCacheReadTokens: 5,
  });
  expect(after.costState).toMatchObject({ summary: { totalTokens: 41 } });
});

test("repeated successful normal progress and final saves do not count own or independent usage twice", async () => {
  const f = fixture("normal-repeated-saves", true, { progress: true });
  control.normalGate = true;
  const chat = await f.manager.getOrCreate(f.sid, {});
  const engine = chat.engine as any;
  const repeated: unknown[] = [];
  for (const method of ["persistRunProgress", "persistFinalRunState"]) {
    const original = engine[method].bind(engine);
    engine[method] = (state: SessionState) => {
      const first = original(state);
      const before = stateFields(f.sessions.readSessionState(f.sid));
      const second = original(state);
      const after = stateFields(f.sessions.readSessionState(f.sid));
      repeated.push({ method, first, second, before, after });
      expect(after.tokenUsage).toEqual(before.tokenUsage);
      expect(after.cumulativePromptTokens).toBe(before.cumulativePromptTokens);
      return first && second;
    };
  }
  const turn = chat.enqueueTurn("Synthetic continuation", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
    toolAllowlist: ["ContinueLocal"],
  });
  await control.entered.promise;
  const usage = { promptTokens: 5, completionTokens: 2, totalTokens: 7, cacheReadTokens: 1 };
  chat.engine.recordExternalUsage(f.sid, {
    source: "external-tool",
    requestId: "independent-repeated",
    provider,
    model: provider,
    usage,
  });
  f.sessions.recordAuxiliaryUsage(f.sid, usage);
  control.release.resolve();
  const result = await turn;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { repeated, result, after, receipt: receipt(f.sessions, f.sid) });
  expect(result.reason).toBe("completed");
  expect(repeated).toHaveLength(3);
  expect(after.tokenUsage.totalTokens).toBe(41);
  expect(after.cumulativePromptTokens).toBe(29);
});

test("a CAS retry refreshes foreign receipts and checkpoints only its captured own usage", async () => {
  const f = fixture("normal-cas-retry", true, { progress: true });
  control.normalGate = true;
  const chat = await f.manager.getOrCreate(f.sid, {});
  const turn = chat.enqueueTurn("Synthetic continuation", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
    toolAllowlist: ["ContinueLocal"],
  });
  await control.entered.promise;
  const addForeign = (
    id: string,
    promptTokens: number,
    completionTokens: number,
    cacheReadTokens: number,
  ) => {
    const usage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cacheReadTokens,
    };
    chat.engine.recordExternalUsage(f.sid, {
      source: "external-tool",
      requestId: id,
      provider,
      model: provider,
      usage,
    });
    f.sessions.recordAuxiliaryUsage(f.sid, usage);
  };
  addForeign("foreign-before-retry", 5, 2, 1);
  const owner = chat.engine.getSessionManager();
  const original = owner.updateSessionRunState.bind(owner);
  let retryCallbacks = 0;
  let inject = true;
  let checkpointAfterWinning: unknown;
  let checkpointAtFinal: unknown;
  let winningSnapshot: unknown;
  owner.updateSessionRunState = (sid, runId, update) => {
    if (!inject) {
      checkpointAtFinal = structuredClone((chat.engine as any).runningSession.committedUsage);
      return original(sid, runId, update);
    }
    inject = false;
    const revision = original(sid, runId, (latest) => {
      const patch = update(latest);
      if (retryCallbacks++ === 0) addForeign("foreign-during-cas", 4, 1, 2);
      return patch;
    });
    winningSnapshot = stateFields(f.sessions.readSessionState(f.sid));
    // A real billed tool callback settles after the winning snapshot but before
    // its caller receives the revision. It must remain uncommitted own usage.
    control.recordLateUsage?.({
      source: "external-tool",
      requestId: "own-after-winning-cas",
      provider,
      model: provider,
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4, cacheReadTokens: 1 },
    });
    checkpointAfterWinning = structuredClone((chat.engine as any).runningSession.committedUsage);
    return revision;
  };
  control.release.resolve();
  const result = await turn;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, {
    retryCallbacks,
    checkpointAfterWinning,
    checkpointAtFinal,
    winningSnapshot,
    result,
    after,
    receipt: receipt(f.sessions, f.sid),
  });
  expect(result.reason).toBe("completed");
  expect(retryCallbacks).toBe(2);
  expect(winningSnapshot).toMatchObject({
    tokenUsage: { totalTokens: 46 },
    costState: { summary: { totalTokens: 46 } },
  });
  expect(checkpointAtFinal).toMatchObject({ totalTokens: 34 });
  expect(after.tokenUsage.totalTokens).toBe(50);
  expect(after.cumulativePromptTokens).toBe(36);
  expect(after.cumulativeCacheReadTokens).toBe(8);
  expect(after.costState).toMatchObject({ summary: { totalTokens: 50 } });
});

test("a failed progress commit retains its checkpoint and only successful finalization publishes cumulative usage", async () => {
  const f = fixture("normal-failed-progress", true, { progress: true });
  control.normalGate = true;
  const chat = await f.manager.getOrCreate(f.sid, {});
  const updates: unknown[] = [];
  const turn = chat.enqueueTurn("Synthetic continuation", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
    toolAllowlist: ["ContinueLocal"],
    onStream: (event) => {
      if (event.type === "usage_update" && event.promptTokensSource === "session_cumulative")
        updates.push(event);
    },
  });
  await control.entered.promise;
  const usage = { promptTokens: 5, completionTokens: 2, totalTokens: 7, cacheReadTokens: 1 };
  chat.engine.recordExternalUsage(f.sid, {
    source: "external-tool",
    requestId: "foreign-failed-progress",
    provider,
    model: provider,
    usage,
  });
  f.sessions.recordAuxiliaryUsage(f.sid, usage);
  const owner = chat.engine.getSessionManager();
  const original = owner.updateSessionRunState.bind(owner);
  let failNext = true;
  let failedCheckpoint: unknown;
  owner.updateSessionRunState = (...args) => {
    if (failNext) {
      failNext = false;
      failedCheckpoint = structuredClone((chat.engine as any).runningSession.committedUsage);
      throw new Error("Synthetic state lock contention");
    }
    return original(...args);
  };
  control.release.resolve();
  const result = await turn;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { failedCheckpoint, updates, result, after, receipt: receipt(f.sessions, f.sid) });
  expect(failedCheckpoint).toMatchObject({ totalTokens: 18 });
  expect(result.reason).toBe("completed");
  expect(after.tokenUsage.totalTokens).toBe(41);
  expect(updates).toHaveLength(2); // First successful heartbeat and successful final commit.
  expect(updates.at(-1)).toMatchObject({
    cumulativePromptTokens: 29,
    cumulativeCacheReadTokens: 5,
  });
});

test("normal old-run progress and finalization cannot change a successor or publish its cumulative state", async () => {
  const f = fixture("normal-successor-fence", true, { progress: true });
  control.normalGate = true;
  const chat = await f.manager.getOrCreate(f.sid, {});
  const updates: unknown[] = [];
  const turn = chat.enqueueTurn("Synthetic continuation", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
    toolAllowlist: ["ContinueLocal"],
    onStream: (event) => {
      if (event.type === "usage_update" && event.promptTokensSource === "session_cumulative")
        updates.push(event);
    },
  });
  await control.entered.promise;
  const next = f.sessions.readSessionState(f.sid)!;
  f.sessions.startSessionRun(next, "synthetic-successor", "successor-input");
  f.sessions.updateSessionState(f.sid, {
    title: "Successor title",
    workspaceProfile: "successor-profile",
  });
  const winner = f.sessions.readSessionState(f.sid);
  const countBefore = updates.length;
  control.release.resolve();
  const result = await turn;
  const after = f.sessions.readSessionState(f.sid);
  record(f.sid, { winner, after, countBefore, updates, result });
  expect(after).toEqual(winner);
  expect(updates).toHaveLength(countBefore);
  expect(result.runId).not.toBe("synthetic-successor");
});

test("successful late own billing after failed progress and final saves cannot acknowledge uncommitted primary usage", async () => {
  const f = fixture("normal-failed-final-late-aux", true, { progress: true, finalGate: true });
  control.normalGate = true;
  const chat = await f.manager.getOrCreate(f.sid, {});
  const turn = chat.enqueueTurn("Synthetic continuation", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
    toolAllowlist: ["ContinueLocal"],
  });
  await control.entered.promise;
  const owner = chat.engine.getSessionManager();
  const original = owner.updateSessionRunState.bind(owner);
  let remainingFailures = 2;
  owner.updateSessionRunState = (...args) => {
    if (remainingFailures-- > 0) throw new Error("Synthetic state lock contention");
    return original(...args);
  };
  control.release.resolve();
  await control.finalEntered.promise;
  const beforeAux = stateFields(f.sessions.readSessionState(f.sid));
  expect(beforeAux.tokenUsage.totalTokens).toBe(18);
  control.recordLateUsage?.({
    source: "external-tool",
    requestId: "late-own-after-failed-final",
    provider,
    model: provider,
    usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7, cacheReadTokens: 1 },
  });
  const afterAux = stateFields(f.sessions.readSessionState(f.sid));
  const checkpointAfterAux = structuredClone((chat.engine as any).runningSession.committedUsage);
  expect(afterAux.tokenUsage.totalTokens).toBe(25);
  control.recordLateUsage = undefined; // The hook's actual billed callback was already delivered.
  const closing = f.manager.close(f.sid);
  control.finalRelease.resolve();
  const result = await turn;
  await closing;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, {
    beforeAux,
    afterAux,
    checkpointAfterAux,
    result,
    after,
    receipt: receipt(f.sessions, f.sid),
  });
  expect(checkpointAfterAux).toMatchObject({ totalTokens: 25 });
  expect(after.tokenUsage.totalTokens).toBe(41);
  expect(after.cumulativePromptTokens).toBe(29);
});

test("a claimed run closed during session activation leaves a cold terminal state", async () => {
  const f = fixture("pre-loop-close", true, { sessionGate: true });
  const chat = await f.manager.getOrCreate(f.sid, {});
  const turn = chat.enqueueTurn("Synthetic initialization", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
  });
  await control.sessionEntered.promise;
  const before = stateFields(f.sessions.readSessionState(f.sid));
  const closing = f.manager.close(f.sid);
  control.sessionRelease.resolve();
  const result = await turn;
  expect(result.reason).toBe("aborted_streaming"); // ChatSession's existing cancel wrapper.
  await closing;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { before, after, result });
  expect(after.status).toBe(result.reason);
  expect(after.tokenUsage.totalTokens).toBe(0);
  expect(control.calls).toBe(0);
});

test("a genuine claimed-run activation failure remains a cold model error", async () => {
  const f = fixture("pre-loop-failure", true, { sessionFailure: true });
  const chat = await f.manager.getOrCreate(f.sid, {});
  await expect(chat.enqueueTurn("Synthetic failure", { behaviorMode: "quiet" })).rejects.toThrow(
    "Private service activation failed",
  );
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { after });
  expect(after.status).toBe("model_error");
  expect(after.tokenUsage.totalTokens).toBe(0);
  expect(control.calls).toBe(0);
});

test("foreign billing after close stays in the ledger without reopening ordinary writer authority", async () => {
  const f = fixture("foreign-after-close", true, { title: true });
  control.blockMainCall = 2;
  const chat = await f.manager.getOrCreate(f.sid, {});
  await chat.enqueueTurn("Synthetic first run", { behaviorMode: "quiet", onStream: () => {} });
  await control.titleEntered.promise;
  const turn = chat.enqueueTurn("Synthetic second run", { behaviorMode: "quiet" });
  await control.entered.promise;
  const closing = f.manager.close(f.sid);
  await control.aborted.promise;
  control.titleRelease.resolve();
  await control.titleReturned.promise;
  control.release.resolve();
  const result = await turn;
  await closing;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { after, result });
  expect(after.status).toBe("aborted_streaming");
  expect(after.tokenUsage.totalTokens).toBe(34);
  expect(after.cumulativePromptTokens).toBe(24);
  expect(after.costState).toMatchObject({ summary: { requests: 3, totalTokens: 41 } });
});

test("a successful turn checkpoint is added only once when the next request closes", async () => {
  const f = fixture("progress-close", true, { progress: true });
  const chat = await f.manager.getOrCreate(f.sid, {});
  const turn = chat.enqueueTurn("Synthetic continuation", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
    toolAllowlist: ["ContinueLocal"],
  });
  await control.entered.promise;
  const before = stateFields(f.sessions.readSessionState(f.sid));
  expect(before.tokenUsage.totalTokens).toBe(18);
  const closing = f.manager.close(f.sid);
  await control.aborted.promise;
  control.release.resolve();
  const result = await turn;
  await closing;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, { before, after, result, receipt: receipt(f.sessions, f.sid) });
  expect(after.status).toBe("aborted_streaming");
  expect(after.tokenUsage.totalTokens).toBe(34);
  expect(after.cumulativePromptTokens).toBe(24);
  expect(after.cumulativeCacheReadTokens).toBe(4);
  expect(after.costState).toMatchObject({ summary: { totalTokens: 34 } });
});

test("close waits through final hooks and includes real late billing owned by the same run", async () => {
  const f = fixture("final-hook-close", true, { progress: true, finalGate: true });
  const chat = await f.manager.getOrCreate(f.sid, {});
  await chat.engine.ready();
  expect(chat.engine.getHookRegistry().hasHooks("on_agent_end")).toBe(true);
  const cumulativeProof: unknown[] = [];
  const turn = chat.enqueueTurn("Synthetic final hook", {
    behaviorMode: "quiet",
    clientMessageId: "first-input",
    toolAllowlist: ["ContinueLocal"],
    onStream: (event) => {
      if (event.type === "usage_update" && event.promptTokensSource === "session_cumulative") {
        cumulativeProof.push({ event, durable: stateFields(f.sessions.readSessionState(f.sid)) });
      }
    },
  });
  await control.entered.promise;
  expect(typeof control.recordLateUsage).toBe("function");
  chat.cancel();
  await control.aborted.promise;
  control.release.resolve();
  await Promise.race([
    control.finalEntered.promise,
    turn.then((result) => {
      throw new Error(`Run finished before final hook: ${result.reason}`);
    }),
  ]);
  const beforeClose = stateFields(f.sessions.readSessionState(f.sid));
  expect(beforeClose.status).toBe("aborted_streaming");
  expect(beforeClose.tokenUsage.totalTokens).toBe(34);
  let closed = false;
  const closing = f.manager.close(f.sid).then(() => {
    closed = true;
  });
  expect(closed).toBe(false);
  control.finalRelease.resolve();
  const result = await turn;
  await closing;
  const after = stateFields(f.sessions.readSessionState(f.sid));
  record(f.sid, {
    beforeClose,
    after,
    result,
    cumulativeProof,
    receipt: receipt(f.sessions, f.sid),
  });
  expect(after.status).toBe("aborted_streaming");
  expect(after.tokenUsage.totalTokens).toBe(41);
  expect(after.cumulativePromptTokens).toBe(29);
  expect(after.cumulativeCacheReadTokens).toBe(5);
  expect(after.costState).toMatchObject({ summary: { totalTokens: 41 } });
  for (const proof of cumulativeProof as Array<{
    event: { cumulativePromptTokens: number };
    durable: { cumulativePromptTokens: number };
  }>) {
    expect(proof.event.cumulativePromptTokens).toBe(proof.durable.cumulativePromptTokens);
  }
});
