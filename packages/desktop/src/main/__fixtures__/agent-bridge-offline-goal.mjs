/** Isolated native ingress fixture: real bridge, mailbox correlation and disk Goal CAS. */
import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import { installNativeBridgeServices } from "./native-bridge-services.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixtureNetworkGuard } from "../../../../../tests/helpers/network-fixture.js";

const network = installFixtureNetworkGuard(); // No allowed network origins, before Core imports.
// Sandbox lacks DiskManagement. Fixture the OS lookup only, keeping the actual
// persistent identity validation and all SessionManager disk operations.
const childProcess = await import("node:child_process");
const realExecFileSync = childProcess.execFileSync;
const diskInfo = spyOn(childProcess, "execFileSync").mockImplementation((file, args, options) => {
  if (file === "/usr/sbin/diskutil")
    return `<plist><dict><key>VolumeUUID</key><string>11111111-2222-3333-4444-555555555555</string><key>DeviceNode</key><string>${args[2]}</string><key>MountPoint</key><string>/private/tmp</string></dict></plist>`;
  return realExecFileSync(file, args, options);
});

// Electron and unrelated native services are fixture boundaries. The actual
// AgentBridge ingress, metadata preparation, worker transport, mobile handler,
// SessionManager and Web hook below are neither mocked nor rewritten.
installNativeBridgeServices({ stubCredentials: true });

const { AgentBridge } = await import("../agent-bridge.js");
const { WorkerBridgeCore } = await import("../../../../server/src/worker-bridge-core.js");
const { SessionManager } = await import("../../../../core/src/session/session-manager.js");
const { handleClientEvent } = await import("../mobile-remote/handle-client-event.js");

const cwd = mkdtempSync(join(tmpdir(), "offline-goal-ingress-"));
try {
  const sessions = new SessionManager(join(cwd, "sessions"));
  const { state } = sessions.create(cwd, "fixture", "openai", "offline-goal");
  assert.equal(
    sessions.saveActiveGoal(state, {
      objective: "finish",
      goalId: "original",
      revision: 1,
      paused: true,
    }),
    true,
  );
  const bridge = Object.create(AgentBridge.prototype);
  bridge.core = new WorkerBridgeCore({
    entryPath: "/fixture-worker-must-not-spawn",
    prepareInbound: (line, meta) => bridge.prepareInboundLine(line, meta),
  });
  bridge.lastRunContext = { cwd, sessionId: state.sessionId };
  bridge.outboundTaps = new Set();
  bridge.webConfiguration = { runBlocked: false, settleRun() {} };
  bridge.sessionMainRootMigrationClaims = new Set();
  bridge.fallbackSessions = sessions;
  bridge.safeSend = () => {};
  const replies = [];
  const ctx = {
    getBridge: () => bridge,
    deviceState: () => ({ selectedSessionId: state.sessionId, selectedCwd: cwd }),
    externalCommands: {
      observe() {},
      isExternal: () => false,
      authorizeNative: async () => ({ assertCurrent() {} }),
    },
    remote: {
      sendToViewer: (_id, event) => replies.push(event),
      sendToDevice: (_id, event) => replies.push(event),
    },
  };
  await handleClientEvent(ctx, {
    type: "goal.clear",
    sessionId: state.sessionId,
    deviceId: "device",
    viewerId: "viewer",
    requestId: "clear-1",
    expectedGoalId: "original",
    expectedRevision: 1,
  });
  assert.equal(replies[0]?.ok, true, JSON.stringify(replies));
  assert.equal(sessions.readActiveGoal(state.sessionId), undefined);
  assert.equal(bridge.core.hasChild(), false);
  assert.equal(bridge.outboundTaps.size, 0);
  // The same physical ingress with a cold in-process worker transport. Only the
  // process boundary is substituted; AgentServer, ChatSessionManager and Engine run.
  const { AgentServer } = await import("../../../../core/src/protocol/server.js");
  const { ChatSessionManager } =
    await import("../../../../core/src/protocol/chat-session-manager.js");
  const { Engine } = await import("../../../../core/src/engine/engine.js");
  const { LLMClientBase } = await import("../../../../core/src/llm/client-base.js");
  const { PROVIDER_REGISTRY, registerProvider } =
    await import("../../../../core/src/llm/client-factory.js");
  const savedProviders = new Map(PROVIDER_REGISTRY);
  let entered;
  const modelEntered = new Promise((done) => {
    entered = done;
  });
  let calls = 0;
  class FixtureProvider extends LLMClientBase {
    initClient() {}
    async createMessage(request) {
      calls++;
      entered();
      await new Promise((_, reject) => {
        const abort = () =>
          reject(Object.assign(new Error("fixture stopped"), { name: "AbortError" }));
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
  PROVIDER_REGISTRY.clear();
  registerProvider("openai", FixtureProvider);
  const goal = {
    objective: "resume the same Goal",
    goalId: "resume-goal",
    revision: 1,
    paused: true,
  };
  assert.equal(sessions.saveActiveGoal(state, goal), true);
  const manager = new ChatSessionManager({
    runtime: {},
    sessionStorageDir: sessions.getStorageDir(),
    engineFactory: () =>
      new Engine({
        cwd,
        sessionStorageDir: sessions.getStorageDir(),
        llm: {
          provider: "openai",
          providerKind: "openai",
          model: "fixture",
          apiKey: "fixture",
          enableStreaming: false,
        },
        enabledBuiltinTools: [],
        headless: false,
        maxTurns: 1,
      }),
  });
  let deliver;
  const server = new AgentServer({
    chatManager: manager,
    readActiveGoalFromDisk: (id) => sessions.readActiveGoal(id),
    updateActiveGoalOnDisk: (id, patch) => sessions.updateActiveGoal(id, patch)?.goal,
    transport: {
      send: (reply) => bridge.publishFallbackReply(JSON.stringify(reply)),
      onMessage: (callback) => {
        deliver = callback;
      },
      close() {},
    },
  });
  let workerStarts = 0;
  let ready = false;
  const waitingInput = [];
  bridge.core.ensureWorker = (root) => {
    assert.equal(root, cwd);
    if (bridge.core.canSend()) return;
    workerStarts++;
    bridge.core.child = {
      stdin: {
        destroyed: false,
        write: (line) => (ready ? deliver(JSON.parse(line)) : waitingInput.push(line)),
      },
    };
  };
  try {
    await handleClientEvent(ctx, {
      type: "goal.update",
      sessionId: state.sessionId,
      deviceId: "device",
      viewerId: "viewer",
      requestId: "resume-1",
      paused: false,
      expectedGoalId: goal.goalId,
      expectedRevision: 1,
    });
    // The real control deadline expires while the cold worker is not ready.
    // Expiring the response tap never cancels the command already in stdin.
    assert.equal(replies.at(-1)?.ok, false, JSON.stringify(replies.at(-1)));
    assert.match(replies.at(-1)?.message, /未确认/);
    assert.equal(sessions.readActiveGoal(state.sessionId).paused, true);
    assert.equal(calls, 0);
    assert.equal(waitingInput.length, 1);
    assert.equal(bridge.outboundTaps.size, 0);
    ready = true;
    for (const line of waitingInput.splice(0)) deliver(JSON.parse(line));
    await modelEntered;
    assert.equal(workerStarts, 1);
    assert.equal(calls, 1);
    assert.deepEqual(sessions.readActiveGoal(state.sessionId), {
      objective: goal.objective,
      goalId: goal.goalId,
      revision: 2,
    });
    await handleClientEvent(ctx, {
      type: "goal.update",
      sessionId: state.sessionId,
      deviceId: "device",
      viewerId: "viewer",
      requestId: "stale",
      paused: false,
      expectedGoalId: goal.goalId,
      expectedRevision: 1,
    });
    assert.equal(replies.at(-1)?.ok, false);
    assert.equal(sessions.readActiveGoal(state.sessionId).revision, 2);
    assert.equal(bridge.outboundTaps.size, 0);
    await handleClientEvent(ctx, {
      type: "goal.clear",
      sessionId: state.sessionId,
      deviceId: "device",
      viewerId: "viewer",
      requestId: "live-clear",
      expectedGoalId: goal.goalId,
      expectedRevision: 2,
    });
    assert.equal(replies.at(-1)?.ok, true);
    assert.equal(replies.at(-1)?.cleared, true);
    assert.equal(sessions.readActiveGoal(state.sessionId), undefined);
  } finally {
    await server.close();
    await manager.closeAllAsync();
    PROVIDER_REGISTRY.clear();
    for (const [name, provider] of savedProviders) PROVIDER_REGISTRY.set(name, provider);
  }
  process.stdout.write(
    JSON.stringify({
      cleared: true,
      workerSpawned: false,
      coldResume: true,
      staleRejected: true,
      delayedReadyAfterTimeout: true,
    }),
  );
} finally {
  network.restore();
  diskInfo.mockRestore();
  rmSync(cwd, { recursive: true, force: true });
}
