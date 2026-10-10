import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";
import { installLocalNetworkGuard } from "../../scripts/runtime-cost-smoke-isolation.mjs";
import type { EngineConfig, EngineResult } from "../../packages/core/src/engine/engine.js";
import type { AgentModule } from "../../packages/core/src/composition/types.js";
import type { CreateMessageOptions } from "../../packages/core/src/llm/types.js";
import type { LLMResponse } from "../../packages/core/src/types.js";

// The outer test uses createBunTestEnvironment, never the operator's HOME or
// provider credentials. Complete these checks and negative probes before Core.
const home = process.env.HOME!;
const evidenceDir = process.env.CODESHELL_SESSION_INITIALIZATION_EVIDENCE_DIR!;
assert.equal(realpathSync(home), home);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
assert.equal(realpathSync(evidenceDir), evidenceDir);
assert.equal(process.env.NODE_ENV, "test");
for (const key of Object.keys(process.env)) {
  assert.ok(!/^(https?_proxy|all_proxy|no_proxy)$/i.test(key));
  assert.ok(!/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PROVIDER_KEY)$/i.test(key));
}
const origin = "http://127.0.0.1:9"; // Guard identity only; no service is started.
installLocalNetworkGuard(origin);
let deniedRequests = 0;
const deny = () => {
  deniedRequests++;
  throw new Error("Session initialization fixture denies every HTTP request");
};
globalThis.fetch = deny as typeof fetch;
for (const transport of [http, https]) {
  transport.request = deny as typeof transport.request;
  transport.get = deny as typeof transport.get;
}
syncBuiltinESMExports();
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
writeFileSync(
  join(evidenceDir, "preimport-guard.json"),
  JSON.stringify({ phase: "before-Core-import", guard }, null, 2) + "\n",
  { mode: 0o600 },
);

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
async function within<T>(promise: Promise<T>, label: string, milliseconds = 1_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function makeControl(pending: boolean) {
  return {
    pending,
    sessionEntered: deferred(),
    releasePending: deferred(),
    modelEntered: deferred(),
    modelAborted: deferred(),
    releaseModel: deferred(),
    calls: 0,
    releasedA: 0,
    releasedB: 0,
    events: [] as string[],
  };
}
let control: ReturnType<typeof makeControl>;
const provider = "session-initialization-local-fixture";
const usage = { promptTokens: 7, completionTokens: 3, totalTokens: 10 };
class LocalClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    control.calls++;
    assert.equal(control.pending, false, "pending initialization must never reach a model");
    assert.ok(options.signal);
    control.events.push("model-entered");
    control.modelEntered.resolve();
    await new Promise<void>((resolve) => {
      if (options.signal!.aborted) resolve();
      else options.signal!.addEventListener("abort", () => resolve(), { once: true });
    });
    control.events.push("model-aborted");
    control.modelAborted.resolve();
    await control.releaseModel.promise;
    control.events.push("model-finished");
    this.recordUsage(usage, options);
    return { text: "Synthetic local result", toolCalls: [], stopReason: "stop", usage };
  }
}
registerProvider(provider, LocalClient);

function coldState(sessionsDir: string, sid: string) {
  const state = new SessionManager(sessionsDir).readSessionState(sid);
  if (!state) return undefined;
  const { status, runId, stateRevision, tokenUsage, turnCount, cumulativePromptTokens } = state;
  return { status, runId, stateRevision, tokenUsage, turnCount, cumulativePromptTokens };
}
function fixture(id: string, pending: boolean) {
  control = makeControl(pending);
  const cwd = join(home, id);
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
  const modules: AgentModule[] = [
    {
      id: "session-canceller",
      engine: {
        privateService: {
          scope: "session",
          create() {
            control.events.push("service-A-created");
            return {};
          },
          dispose() {
            control.releasedA++;
            control.events.push("service-A-released");
            control.releasePending.resolve();
          },
        },
      },
    },
    {
      id: "session-pending",
      engine: {
        privateService: {
          scope: "session",
          async create() {
            control.events.push("service-B-entered");
            control.sessionEntered.resolve();
            if (control.pending) await control.releasePending.promise;
            control.events.push("service-B-returned");
            return {};
          },
          dispose() {
            control.releasedB++;
            control.events.push("service-B-released");
          },
        },
      },
    },
  ];
  const manager = new ChatSessionManager({
    runtime,
    engineFactory: () =>
      new Engine({
        llm: { provider, model: provider, apiKey: "synthetic" },
        cwd,
        runtime,
        settingsScope: "isolated",
        sessionStorageDir: sessionsDir,
        isSubAgent: true,
        headless: true,
        maxTurns: 1,
        customSystemPrompt: "Finish the synthetic local fixture.",
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
        modules,
      } as EngineConfig),
  });
  return { id, sessionsDir, manager, runtime };
}
type TurnOutcome = { result: EngineResult } | { error: string };

async function pendingClose(id: string, name: string, owner: "engine" | "runtime" | "chat") {
  const f = fixture(id, true);
  let outcome = "failed";
  let failure: string | undefined;
  let before: ReturnType<typeof coldState>;
  let turn: Promise<TurnOutcome> | undefined;
  let closing: Promise<void> | undefined;
  let turnOutcome: TurnOutcome | undefined;
  let oldWriterRevoked: boolean | undefined;
  let assertionSnapshot: object | undefined;
  try {
    const chat = await f.manager.getOrCreate(id, {});
    await chat.engine.ready();
    turn = chat
      .enqueueTurn("Synthetic pending Session initialization", {
        behaviorMode: "quiet",
        clientMessageId: "local-input",
      })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error: String(error) }),
      );
    await within(control.sessionEntered.promise, "Session service entry");
    before = coldState(f.sessionsDir, id);
    expect(before?.status).toBe("active");
    expect(control.releasedA).toBe(0);
    expect(control.events).not.toContain("service-B-returned");
    const oldWriter = chat.engine.getSessionManager();
    const oldState = oldWriter.readSessionState(id)!;
    closing =
      owner === "engine"
        ? chat.engine.dispose()
        : owner === "runtime"
          ? f.runtime.close()
          : f.manager.close(id);
    void closing.catch(() => {});
    if (owner === "chat") {
      oldWriterRevoked = !oldWriter.saveState(oldState);
      expect(oldWriterRevoked).toBe(true);
    }
    await within(closing, `${owner} close while Session initialization is pending`);
    turnOutcome = await within(turn, "cancelled initialization run");
    const after = coldState(f.sessionsDir, id);
    assertionSnapshot = {
      after,
      releasedA: control.releasedA,
      releasedB: control.releasedB,
      events: [...control.events],
    };
    expect(after?.status).toBe("aborted_streaming");
    expect(after?.runId).toBe(before?.runId);
    expect(after?.tokenUsage.totalTokens).toBe(0);
    expect(control.calls).toBe(0);
    expect(control.releasedA).toBe(1);
    expect(control.releasedB).toBe(1);
    expect(control.events.indexOf("service-A-released")).toBeLessThan(
      control.events.indexOf("service-B-returned"),
    );
    expect(control.events.indexOf("service-B-returned")).toBeLessThan(
      control.events.indexOf("service-B-released"),
    );
    if (owner === "chat") {
      expect(turnOutcome).toMatchObject({ result: { reason: "aborted_streaming" } });
      expect(f.manager.get(id)).toBeUndefined();
      expect(f.manager.isClosed(id)).toBe(true);
      expect(oldWriter.saveState(oldState)).toBe(false);
    }
    outcome = "passed";
  } catch (error) {
    failure = String(error);
    throw error;
  } finally {
    // Deliberately break the baseline deadlock only after assertions finish or
    // time out. Red runs produce complete JUnit rather than hanging the suite.
    control.events.push("cleanup-release");
    control.releasePending.resolve();
    control.releaseModel.resolve();
    const cleanupErrors: string[] = [];
    try {
      if (turn) await within(turn, "cleanup run");
      if (closing) await within(closing, "cleanup close");
      await within(f.manager.closeAllAsync(), "cleanup ChatSessionManager");
      await within(f.runtime.close(), "cleanup Runtime");
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    writeFileSync(
      join(evidenceDir, `${id}.json`),
      JSON.stringify(
        {
          name,
          guard,
          outcome,
          failure,
          owner,
          before,
          after: coldState(f.sessionsDir, id),
          assertionSnapshot,
          turnOutcome,
          oldWriterRevoked,
          calls: control.calls,
          releasedA: control.releasedA,
          releasedB: control.releasedB,
          events: control.events,
          deniedRequestsAfterProbes: deniedRequests,
          cleanupErrors,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    expect(cleanupErrors).toEqual([]);
    expect(deniedRequests).toBe(0);
  }
}

test("Engine dispose cancels pending Session service initialization", () =>
  pendingClose(
    "engine-dispose",
    "Engine dispose cancels pending Session service initialization",
    "engine",
  ));
test("Runtime close cancels pending Session service initialization", () =>
  pendingClose(
    "runtime-close",
    "Runtime close cancels pending Session service initialization",
    "runtime",
  ));
test("ChatSessionManager busy close cancels pending Session service initialization", () =>
  pendingClose(
    "chat-busy-close",
    "ChatSessionManager busy close cancels pending Session service initialization",
    "chat",
  ));

test("active run keeps initialized Session services until settlement", async () => {
  const id = "active-run-control";
  const f = fixture(id, false);
  let outcome = "failed";
  let failure: string | undefined;
  let turn: Promise<TurnOutcome> | undefined;
  let closing: Promise<void> | undefined;
  let beforeRelease: object | undefined;
  let turnOutcome: TurnOutcome | undefined;
  try {
    const chat = await f.manager.getOrCreate(id, {});
    await chat.engine.ready();
    turn = chat.enqueueTurn("Synthetic initialized Session run", { behaviorMode: "quiet" }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: String(error) }),
    );
    await within(control.modelEntered.promise, "initialized Session model entry");
    let closed = false;
    closing = f.runtime.close().then(() => {
      closed = true;
    });
    void closing.catch(() => {});
    await within(control.modelAborted.promise, "active model cancellation");
    beforeRelease = {
      closed,
      releasedA: control.releasedA,
      releasedB: control.releasedB,
      events: [...control.events],
    };
    // The provider has observed abort but cannot finish until this gate opens.
    // No timing sleep is needed to prove that the run is still unsettled.
    expect(closed).toBe(false);
    expect(control.releasedA).toBe(0);
    expect(control.releasedB).toBe(0);
    control.releaseModel.resolve();
    turnOutcome = await within(turn, "active run settlement");
    await within(closing, "active Runtime close");
    const after = coldState(f.sessionsDir, id);
    expect(after?.status).toBe("aborted_streaming");
    expect(after?.tokenUsage.totalTokens).toBe(usage.totalTokens);
    expect(control.calls).toBe(1);
    expect(control.releasedA).toBe(1);
    expect(control.releasedB).toBe(1);
    for (const event of ["service-A-released", "service-B-released"]) {
      expect(control.events.indexOf("model-finished")).toBeLessThan(control.events.indexOf(event));
    }
    outcome = "passed";
  } catch (error) {
    failure = String(error);
    throw error;
  } finally {
    control.events.push("cleanup-release");
    control.releasePending.resolve();
    control.releaseModel.resolve();
    const cleanupErrors: string[] = [];
    try {
      if (turn) await within(turn, "cleanup active run");
      if (closing) await within(closing, "cleanup active close");
      await within(f.manager.closeAllAsync(), "cleanup active ChatSessionManager");
      await within(f.runtime.close(), "cleanup active Runtime");
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    writeFileSync(
      join(evidenceDir, `${id}.json`),
      JSON.stringify(
        {
          name: "active run keeps initialized Session services until settlement",
          guard,
          outcome,
          failure,
          beforeRelease,
          after: coldState(f.sessionsDir, id),
          turnOutcome,
          calls: control.calls,
          releasedA: control.releasedA,
          releasedB: control.releasedB,
          events: control.events,
          deniedRequestsAfterProbes: deniedRequests,
          cleanupErrors,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    expect(cleanupErrors).toEqual([]);
    expect(deniedRequests).toBe(0);
  }
});
