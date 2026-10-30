import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { rmSync } from "node:fs";
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
  cancelBrowserActionsForStoppedRun: () => false,
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
const { SessionManager, sessionsRoot } = await import("@cjhyy/code-shell-core");
const {
  SessionOutputJournal,
  SessionOutputCoverageStore,
  OutputHistoryRecovery,
  outputUserMessage,
  readOutputJournal,
} = await import("@cjhyy/code-shell-core/internal");
const { MainOutputPublisher } = await import("../main-output-publisher.ts");
const { SessionSnapshotStore } = await import("../SessionSnapshotStore.ts");
const { registerSessionTranscriptIpc } = await import("../session-transcript-ipc.ts");
const { recoverDesktopOutputJournal } = await import("../../renderer/app/outputJournalRecovery.ts");
const { WorkerRunOwnership } = await import("../worker-run-ownership.ts");
const { PanelHostWindowRoutes } = await import("../panel-host-routing.ts");
const { bucketForSession } = await import("../browser-driver/active-guest.ts");
const sessionId = "runtime-restart";
const root = sessionsRoot();
const manager = new SessionManager(root);
const bundle = manager.create("/fixture/project", "fixture", "fixture", sessionId);
manager.startSessionRun(bundle.state, "first-run");
let writer = new SessionOutputJournal(
  root,
  sessionId,
  "first-run",
  bundle.transcript.getEvents()[0].id,
);
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
function createBridge() {
  const bridge = Object.create(AgentBridge.prototype);
  bridge.snapshots = new SessionSnapshotStore({
    coverage: new SessionOutputCoverageStore(() => root),
  });
  bridge.workerRuns = new WorkerRunOwnership();
  bridge.mainOutput = new MainOutputPublisher({
    root: () => root,
    latest: (id) => bridge.getSnapshot(id).outputCursor,
    worker: () => {
      throw new Error("Owned replay must never enter the broadcast worker path");
    },
  });
  bridge.sessionCwd = new Map();
  bridge.hostReservations = new Map();
  bridge.panelHostWindowRoutes = new PanelHostWindowRoutes();
  bridge.windows = new Set([owner]);
  bridge.ownedExternalTaps = new Set();
  bridge.ownedExternalOutputSources = new Map();
  return bridge;
}
const bridge = createBridge();
let forgottenOutput = 0;
const forget = bridge.mainOutput.forget.bind(bridge.mainOutput);
bridge.mainOutput.forget = (id) => {
  forgottenOutput++;
  forget(id);
};
const committed = (event) => ({ ...event, outputCursor: writer.append(event) });
const publish = (event) => bridge.ingestOwnedExternalEvent(sessionId, committed(event));
bridge.registerExternalSession(sessionId, "/fixture/project", owner.webContents.id);
publish({ type: "session_started", sessionId, runId: "first-run", promptTokens: 0 });
publish({ type: "stream_request_start", turnNumber: 1, messageId: "first-assistant" });
for (let index = 0; index < 8; index++) publish({ type: "text_delta", text: "first " });
publish({ type: "turn_complete", reason: "completed" });
const first = envelopes.splice(0);
const before = bridge.getSnapshot(sessionId);
assert.equal(before.topLevelRunning, false);
assert.equal(before.outputUnpaired, undefined);

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
manager.updateSessionState(sessionId, { status: "completed" }, "first-run");
manager.startSessionRun(manager.readSessionState(sessionId), "second-run");
writer = new SessionOutputJournal(root, sessionId, "second-run");
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

// An independent background completion must join a committed provider frame
// whose live notification is still in flight, through the same owner-only path.
manager.updateSessionState(sessionId, { status: "completed" }, "second-run");
manager.startSessionRun(manager.readSessionState(sessionId), "background-overlap");
writer = new SessionOutputJournal(root, sessionId, "background-overlap");
publish({ type: "session_started", sessionId, runId: "background-overlap", promptTokens: 0 });
publish({ type: "stream_request_start", turnNumber: 1, messageId: "overlap-assistant" });
envelopes.length = 0;

const taps = [];
bridge.ownedExternalTaps.add((entry) => taps.push(entry));
const foreign = [];
bridge.windows.add({
  isDestroyed: () => false,
  webContents: { id: 88, send: (...args) => foreign.push(args) },
});
const late = committed({ type: "text_delta", text: "late provider output" });
bridge.ingestOwnedExternalEvent(sessionId, {
  type: "background_agent_completed",
  agentId: "delegated-job",
  description: "Independent review",
  status: "completed",
  finalText: "review passed",
  enqueuedAt: Date.now(),
});
assert.equal(foreign.length, 0);
assert.equal(envelopes.length, 2);
assert.equal(envelopes[0].event.text, "late provider output");
assert.equal(envelopes[1].event.type, "background_agent_completed");
assert.equal(taps.length, 2);
assert.ok(taps.every((entry) => entry.ownerWebContentsId === 77));
const joinedSeq = bridge.getSnapshot(sessionId).nextSeq;
bridge.ingestOwnedExternalEvent(sessionId, late);
assert.equal(bridge.getSnapshot(sessionId).nextSeq, joinedSeq);
assert.equal(envelopes.length, 2);
assert.equal(taps.length, 2);
assert.equal(bridge.getSnapshot(sessionId).outputUnpaired, undefined);
const journal = readOutputJournal(root, sessionId, {
  after: late.outputCursor,
  through: envelopes[1].event.outputCursor,
});
assert.equal(journal.status, "ok");
assert.equal(journal.frames.length, 1);
assert.equal(journal.frames[0].producer.kind, "host");
assert.equal(journal.frames[0].runId, undefined);
assert.equal(journal.frames[0].event.type, "background_agent_completed");

// A new Main with no in-memory suffix must still recover that completion.
const handlers = new Map();
registerSessionTranscriptIpc({ handle: (channel, listener) => handlers.set(channel, listener) });
const restarted = new SessionSnapshotStore({
  coverage: new SessionOutputCoverageStore(() => root),
});
const recovered = await recoverDesktopOutputJournal({
  read: (options) => handlers.get("sessions:outputJournal")({}, sessionId, options),
  snapshot: async () => restarted.get(sessionId),
  canContinue: () => true,
  latestObservedCursor: () => undefined,
});
assert.ok(recovered);
assert.equal(recovered.outputCursor, envelopes[1].event.outputCursor);
assert.ok(
  recovered.state.messages.some(
    (message) => message.kind === "assistant" && message.text.includes("late provider output"),
  ),
);
assert.ok(
  recovered.state.messages.some(
    (message) => message.kind === "system" && message.text.includes("review passed"),
  ),
);
envelopes.length = 0;

// A cold runtime with an existing journal can receive a result/control event
// before sending another provider turn. Registration binds that existing log.
const cold = createBridge();
cold.registerExternalSession(sessionId, "/fixture/project", owner.webContents.id);
cold.ingestOwnedExternalEvent(sessionId, { type: "goal_cleared" });
assert.ok(envelopes.some(({ event }) => event.type === "goal_cleared" && event.outputCursor));
assert.equal(cold.getSnapshot(sessionId).outputUnpaired, undefined);
const coldCursor = cold.getSnapshot(sessionId).outputCursor;
assert.equal(
  readOutputJournal(root, sessionId, { after: coldCursor, through: coldCursor }).status,
  "ok",
);
envelopes.length = 0;

// A late old-runtime release must not mark a successor run idle.
manager.updateSessionState(sessionId, { status: "completed" }, "background-overlap");
manager.startSessionRun(manager.readSessionState(sessionId), "successor");
writer = new SessionOutputJournal(root, sessionId, "successor");
publish({ type: "session_started", sessionId, runId: "successor", promptTokens: 0 });
bridge.releaseExternalSession(sessionId);
assert.equal(bridge.getSnapshot(sessionId).topLevelRunning, true);
assert.equal(forgottenOutput, 0);
const absentOwnerSeq = bridge.getSnapshot(sessionId).nextSeq;
const tapsBeforeAbsentOwner = taps.length;
const deliveriesBeforeAbsentOwner = envelopes.length;
bridge.ingestOwnedExternalEvent(sessionId, {
  type: "background_agent_completed",
  agentId: "owner-closed-job",
  description: "Finishes after owner closes",
  status: "completed",
  enqueuedAt: Date.now(),
});
assert.ok(bridge.getSnapshot(sessionId).nextSeq > absentOwnerSeq);
assert.equal(bridge.getSnapshot(sessionId).outputUnpaired, undefined);
assert.equal(taps.length, tapsBeforeAbsentOwner);
assert.equal(envelopes.length, deliveriesBeforeAbsentOwner);
assert.equal(foreign.length, 0);
// A captured asynchronous producer cannot write into a recreated Session id.
rmSync(join(root, sessionId), { recursive: true });
manager.create("/fixture/project", "replacement", "fixture", sessionId);
const deliveredBeforeReuse = envelopes.length;
bridge.ingestOwnedExternalEvent(sessionId, {
  type: "background_agent_completed",
  agentId: "stale-job",
  description: "Old Session result",
  status: "completed",
  enqueuedAt: Date.now(),
});
assert.equal(envelopes.length, deliveredBeforeReuse);
assert.equal(readOutputJournal(root, sessionId).status, "unavailable");
bridge.forgetSession(sessionId);
assert.equal(forgottenOutput, 1);
assert.equal(bridge.getSnapshot(sessionId).nextSeq, 1);
assert.deepEqual(bridge.getSnapshot(sessionId).events, []);
assert.equal(bridge.getSnapshot(sessionId).outputUnpaired, undefined);
rmSync(join(root, sessionId), { recursive: true });

// Registration alone must not cut over an oversized legacy transcript. A
// notice without any durable anchor remains visibly incomplete instead.
const legacyId = "runtime-legacy-without-journal";
const legacy = manager.create("/fixture/project", "fixture", "fixture", legacyId);
legacy.transcript.appendMessage("assistant", "x".repeat(1024 * 1024));
legacy.transcript.sync();
const legacyBridge = createBridge();
legacyBridge.registerExternalSession(legacyId, "/fixture/project", owner.webContents.id);
assert.equal(readOutputJournal(root, legacyId).status, "unavailable");
legacyBridge.ingestOwnedExternalEvent(legacyId, {
  type: "background_agent_completed",
  agentId: "unanchored-job",
  description: "No committed journal",
  status: "completed",
  enqueuedAt: Date.now(),
});
assert.equal(legacyBridge.getSnapshot(legacyId).outputUnpaired, true);
assert.equal(envelopes.at(-1).event.outputRecovery, "incomplete");
assert.equal(readOutputJournal(root, legacyId).status, "unavailable");
rmSync(join(root, legacyId), { recursive: true });

// Cold registration pins history independently of Main's applied cursor. A
// long history must not consume the live join/deduplication budgets again.
const longId = "runtime-long-cold-history";
const longBundle = manager.create("/fixture/project", "fixture", "fixture", longId);
manager.startSessionRun(longBundle.state, "historic-run");
const historicWriter = new SessionOutputJournal(
  root,
  longId,
  "historic-run",
  longBundle.transcript.getEvents()[0].id,
);
for (let batch = 0; batch < 129; batch++)
  historicWriter.appendBatch(
    Array.from({ length: 64 }, () => ({ type: "text_delta", text: "historic" })),
  );
const historicHead = readOutputJournal(root, longId, { maxFrames: 1 }).through;
const longCold = createBridge();
envelopes.length = 0;
longCold.registerExternalSession(longId, "/fixture/project", owner.webContents.id);
assert.equal(longCold.getSnapshot(longId).outputCursor, undefined);
assert.equal(longCold.getSnapshot(longId).nextSeq, 1);
assert.deepEqual(longCold.getSnapshot(longId).events, []);
manager.updateSessionState(longId, { status: "completed" }, "historic-run");
manager.startSessionRun(manager.readSessionState(longId), "live-after-register");
const liveWriter = new SessionOutputJournal(root, longId, "live-after-register");
const pendingEvents = [
  { type: "session_started", sessionId: longId, runId: "live-after-register", promptTokens: 0 },
  { type: "stream_request_start", turnNumber: 1, messageId: "new-live-assistant" },
  { type: "text_delta", text: "committed after cold registration" },
].map((event) => ({ ...event, outputCursor: liveWriter.append(event) }));
longCold.ingestOwnedExternalEvent(longId, { type: "goal_cleared" });
assert.equal(envelopes.length, 4);
assert.deepEqual(
  envelopes.slice(0, 3).map(({ event }) => event),
  pendingEvents,
);
assert.equal(envelopes[3].event.type, "goal_cleared");
assert.equal(longCold.getSnapshot(longId).outputUnpaired, undefined);
assert.equal(longCold.getSnapshot(longId).nextSeq, 5);
const longCursor = longCold.getSnapshot(longId).outputCursor;
const longSuffix = readOutputJournal(root, longId, { after: historicHead, through: longCursor });
assert.equal(longSuffix.status, "ok");
assert.equal(longSuffix.frames.length, 4);
assert.equal(longSuffix.frames[3].producer.kind, "host");
assert.equal(longSuffix.frames[3].runId, undefined);
for (const event of pendingEvents) longCold.ingestOwnedExternalEvent(longId, event);
assert.equal(envelopes.length, 4);
assert.equal(longCold.getSnapshot(longId).nextSeq, 5);
assert.equal(longCold.getSnapshot(longId).outputUnpaired, undefined);
rmSync(join(root, longId), { recursive: true });

// Explicit history repair keeps the Session and transport sequence, but must
// retire every publisher bound to the old journal incarnation. Use the real
// verified checkpoint transaction; no worker, CLI or provider is involved.
const repairedId = "runtime-explicit-history-recovery";
const repairedBundle = manager.create("/fixture/project", "fixture", "codex", repairedId);
const base = repairedBundle.transcript.getEvents()[0].id;
const user = repairedBundle.transcript.appendMessage("user", "owned checkpoint question", {
  clientMessageId: "checkpoint-input",
});
manager.startSessionRun(repairedBundle.state, user.id);
const repairedWriter = new SessionOutputJournal(root, repairedId, user.id, base);
const repairedBridge = createBridge();
for (const event of [
  outputUserMessage(user.data, repairedId, "/fixture/project"),
  { type: "session_started", sessionId: repairedId, runId: user.id, promptTokens: 0 },
  { type: "stream_request_start", turnNumber: 1, messageId: "checkpoint-assistant" },
  { type: "text_delta", text: "owned checkpoint answer" },
  { type: "turn_complete", reason: "completed" },
]) {
  const committed = { ...event, outputCursor: repairedWriter.append(event) };
  repairedBridge.ingestOwnedExternalEvent(repairedId, committed);
}
repairedBundle.transcript.appendMessage("assistant", "owned checkpoint answer");
repairedBundle.transcript.appendTurnBoundary();
repairedBundle.transcript.sync();
manager.updateSessionState(repairedId, { status: "completed" });
repairedBridge.registerExternalSession(repairedId, "/fixture/project", owner.webContents.id);
const oldSource = repairedBridge.ownedExternalOutputSources.get(repairedId);
assert.ok(oldSource);
// The historical, unpaired notice is deliberately retained as a declared gap.
repairedBridge.snapshots.append(repairedId, {
  type: "background_agent_completed",
  agentId: "historical-notice",
  description: "Owned old notification",
  status: "completed",
  enqueuedAt: 1,
});
const oldSnapshot = repairedBridge.getSnapshot(repairedId);
assert.equal(oldSnapshot.outputUnpaired, true);
const checkpoint = new OutputHistoryRecovery(() => root);
const authority = { key: "owned-checkpoint", assertCurrent() {} };
const plan = checkpoint.plan(repairedId, authority);
assert.equal(plan.status, "ready");
assert.deepEqual(
  checkpoint.apply(repairedId, { planId: plan.planId, acceptHistoricalGap: true }, authority),
  { status: "applied", sessionId: repairedId, historicalGap: true },
);
repairedBridge.resetOutputHistoryRecovery(repairedId);
assert.equal(repairedBridge.getSnapshot(repairedId).nextSeq, oldSnapshot.nextSeq);
const checkpointHead = readOutputJournal(root, repairedId).through;
const freshNotice = { type: "goal_cleared" };
envelopes.length = 0;
assert.throws(() => oldSource.publish(freshNotice), /Session was replaced/);
assert.equal(readOutputJournal(root, repairedId).through, checkpointHead);
assert.equal(envelopes.length, 0);
assert.equal(
  readOutputJournal(root, repairedId, { after: oldSnapshot.outputCursor }).status,
  "cursor_invalid",
);
repairedBridge.registerExternalSession(repairedId, "/fixture/project", owner.webContents.id);
repairedBridge.ingestOwnedExternalEvent(repairedId, freshNotice);
assert.equal(envelopes.length, 1, "only the new independent output is published after recovery");
assert.equal(envelopes[0].event.type, "goal_cleared");
assert.equal(envelopes[0].seq, oldSnapshot.nextSeq);
assert.equal(repairedBridge.getSnapshot(repairedId).outputUnpaired, undefined);
const checkpointSuffix = readOutputJournal(root, repairedId, { after: checkpointHead });
assert.equal(checkpointSuffix.status, "ok");
assert.equal(checkpointSuffix.frames.length, 1);
assert.equal(checkpointSuffix.frames[0].event.type, "goal_cleared");
assert.equal(checkpointSuffix.frames[0].producer.kind, "host");
assert.equal(checkpointSuffix.historicalGap, true);
rmSync(join(root, repairedId), { recursive: true });
console.log(JSON.stringify({ first, second }));
