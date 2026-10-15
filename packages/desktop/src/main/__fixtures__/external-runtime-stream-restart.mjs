import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { join, resolve } from "node:path";
import { mock } from "bun:test";

// Run separately so Electron/service mocks cannot affect other renderer tests.
// Install the network guard before importing Core; no provider is involved.
const denyNetwork = () => {
  throw new Error("Runtime restart fixture cannot use the network");
};
globalThis.fetch = denyNetwork;
for (const module of [http, https]) {
  module.request = denyNetwork;
  module.get = denyNetwork;
}
const main = resolve(import.meta.dir, "..");
const released = [];
mock.module("electron", () => ({
  ipcMain: new EventEmitter(),
  BrowserWindow: { fromWebContents: () => undefined },
  app: { getPath: () => process.env.HOME },
}));
mock.module(join(main, "desktop-logger.ts"), () => ({ dlog: () => {} }));
mock.module(join(main, "browser-runtime/index.ts"), () => ({
  browserRuntime: { close: (owner) => released.push(["browser", owner]) },
  builtInBrowserHandoffGrants: { clearSession: (id) => released.push(["handoff", id]) },
  chromeExtensionRuntimeService: { forgetSession: (id) => released.push(["extension", id]) },
  annotateBrowserRuntimeStreamEvent: (event) => event,
  dispatchInteractiveBrowserRuntimeAction: () => {},
  releaseChildBrowserRuntime: () => {},
  activateChildBrowserRuntime: () => {},
  interactiveBrowserRuntimeOwner: (id) => id,
  replaceStreamEventInLine: (line) => line,
}));
mock.module(join(main, "credential-action.ts"), () => ({
  resolveCookieCredentialForBrowser: () => ({ ok: false }),
}));
mock.module(join(main, "cookie-credential-browser.ts"), () => ({
  restoreCookieCredentialToBrowser: () => {},
}));
mock.module(join(main, "credential-access-service.ts"), () => ({
  buildCredentialSnapshot: () => ({ revision: 1, entries: [] }),
  materializeCredentialCookieForWorker: () => {},
  resolveCredentialValueForWorker: () => {},
}));
mock.module(join(main, "automation-service.ts"), () => ({ reloadAutomations: () => {} }));
mock.module(join(main, "trust-store.ts"), () => ({ getTrustCachedSync: () => "trusted" }));
mock.module(join(main, "project-store.ts"), () => ({ getProjectStore: () => {} }));
mock.module(join(main, "session-cwd-index.ts"), () => ({
  getSessionCwdIndex: () => ({ forget: (id) => released.push(["cwd", id]) }),
}));
mock.module(join(main, "external-runtime-state.ts"), () => ({
  readExternalRuntimeBinding: () => {},
}));
mock.module(join(main, "session-workspace-service.ts"), () => ({
  switchSessionWorkspaceForUi: () => {},
}));

const { AgentBridge } = await import("../agent-bridge.ts");
const { SessionSnapshotStore } = await import("../SessionSnapshotStore.ts");
const { WorkerRunOwnership } = await import("../worker-run-ownership.ts");
const { PanelHostWindowRoutes } = await import("../panel-host-routing.ts");
const { bucketForSession } = await import("../browser-driver/active-guest.ts");
const sessionId = "runtime-restart";
const envelopes = [];
const owner = {
  isDestroyed: () => false,
  webContents: {
    id: 77,
    send: (channel, envelope) => {
      assert.equal(channel, "agent:streamEvent");
      envelopes.push(envelope);
    },
  },
};
// Exercise the production lifecycle and publication methods without spawning
// Electron, a worker or a provider process.
const bridge = Object.create(AgentBridge.prototype);
bridge.snapshots = new SessionSnapshotStore();
bridge.workerRuns = new WorkerRunOwnership();
let forgottenOutput = 0;
bridge.mainOutput = { forget: () => forgottenOutput++ };
bridge.sessionCwd = new Map();
bridge.hostReservations = new Map();
bridge.panelHostWindowRoutes = new PanelHostWindowRoutes();
bridge.windows = new Set([owner]);
bridge.ownedExternalTaps = new Set();
const publish = (event) => bridge.ingestOwnedExternalEvent(sessionId, event);
bridge.registerExternalSession(sessionId, "/fixture/project", owner.webContents.id);
publish({ type: "session_started", sessionId, runId: "first-run", promptTokens: 0 });
publish({ type: "stream_request_start", turnNumber: 1, messageId: "first-assistant" });
for (let index = 0; index < 8; index++) publish({ type: "text_delta", text: "first " });
publish({ type: "turn_complete", reason: "completed" });
const first = envelopes.splice(0);
const before = bridge.getSnapshot(sessionId);
assert.equal(before.topLevelRunning, false);
assert.equal(before.outputUnpaired, true);

bridge.releaseExternalSession(sessionId);
assert.deepEqual(bridge.getSnapshot(sessionId), before);
assert.equal(forgottenOutput, 0);
assert.equal(bridge.hasKnownSession(sessionId), false);
assert.equal(bridge.hostReservation(sessionId), undefined);
assert.equal(bridge.panelOwnerWebContentsId(sessionId), undefined);
assert.equal(bucketForSession(sessionId), null);
assert.deepEqual(released, [
  ["cwd", sessionId],
  ["browser", sessionId],
  ["handoff", sessionId],
  ["extension", sessionId],
]);

bridge.registerExternalSession(sessionId, "/fixture/project", owner.webContents.id);
publish({ type: "session_started", sessionId, runId: "second-run", promptTokens: 0 });
publish({ type: "stream_request_start", turnNumber: 1, messageId: "second-assistant" });
publish({ type: "text_delta", text: "second reply" });
publish({ type: "tool_use_start", toolCall: { id: "read", toolName: "Read", args: {} } });
publish({ type: "tool_result", result: { id: "read", toolName: "Read", result: "read ok" } });
publish({ type: "turn_complete", reason: "completed" });
const second = envelopes.splice(0);
assert.equal(second[0].epoch, first[0].epoch);
assert.equal(second[0].seq, before.nextSeq);
assert.equal(bridge.getSnapshot(sessionId).topLevelRunning, false);
assert.deepEqual(
  bridge.getSnapshot(sessionId, before.nextSeq - 1).events,
  second.map(({ seq, event }) => ({ seq, event })),
);

// A late old-runtime release must not mark a successor run idle.
publish({ type: "session_started", sessionId, runId: "successor", promptTokens: 0 });
bridge.releaseExternalSession(sessionId);
assert.equal(bridge.getSnapshot(sessionId).topLevelRunning, true);
assert.equal(forgottenOutput, 0);
bridge.forgetSession(sessionId);
assert.equal(forgottenOutput, 1);
assert.equal(bridge.getSnapshot(sessionId).nextSeq, 1);
assert.deepEqual(bridge.getSnapshot(sessionId).events, []);
assert.equal(bridge.getSnapshot(sessionId).outputUnpaired, undefined);
console.log(JSON.stringify({ first, second }));
