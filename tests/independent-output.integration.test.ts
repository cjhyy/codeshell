import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

// Deny before importing any Core/Host/producer. This shard never needs a socket.
const surfaces = [
  [globalThis, "fetch"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
  [net, "connect"],
  [net, "createConnection"],
  [net.Socket.prototype, "connect"],
] as const;
const previous = surfaces.map(([target, key]) => ({
  target: target as unknown as Record<string, unknown>,
  key,
  descriptor: Object.getOwnPropertyDescriptor(target, key),
}));
let denied = 0;
for (const { target, key } of previous)
  target[key] = () => {
    denied++;
    throw new Error("coverage fixture denied outbound network");
  };
syncBuiltinESMExports();
expect(() => fetch("https://outside.invalid/probe")).toThrow("denied outbound");
expect(() => https.get("https://outside.invalid/probe")).toThrow("denied outbound");
const { SessionManager, sessionsRoot, AgentServer } = await import("../packages/core/src/index.js");
const { SessionOutputJournal, readOutputJournal, readOutputJournalLegacyBase } =
  await import("../packages/core/src/session/output-journal.js");
const { SessionOutputCoverageStore } =
  await import("../packages/core/src/session/output-coverage-state.js");
const { SessionSnapshotStore } =
  await import("../packages/desktop/src/main/SessionSnapshotStore.js");
const { registerSessionTranscriptIpc } =
  await import("../packages/desktop/src/main/session-transcript-ipc.js");
const { recoverDesktopOutputJournal } =
  await import("../packages/desktop/src/renderer/app/outputJournalRecovery.js");
const { MobileOutputRecovery } =
  await import("../packages/desktop/src/main/mobile-remote/output-recovery.js");
const { recoverMobileOutput } = await import("../packages/web/src/lib/mobileOutputRecovery.js");
const { HubRunReplay } = await import("../packages/server/src/hub/run-replay.js");
const { chatFromOutputJournal } = await import("../packages/web/app/chat.js");
const { NotificationQueue } =
  await import("../packages/core/src/tool-system/builtin/agent-notifications.js");
const { lockSync } = await import("../packages/core/src/utils/lockfile.js");
const { SessionOutputPublisher } = await import("../packages/core/src/session/output-publisher.js");
const cleanups: Array<() => void> = [];
afterAll(() => {
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      expect(denied).toBe(2);
    } catch (cause) {
      failures.push(cause);
    }
  } finally {
    for (const item of previous) {
      try {
        if (item.descriptor) Object.defineProperty(item.target, item.key, item.descriptor);
        else Reflect.deleteProperty(item.target, item.key);
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      syncBuiltinESMExports();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Coverage fixture cleanup failed");
});
let serial = 0;
function fixture() {
  const root = sessionsRoot();
  const id = `independent-${++serial}`;
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", id);
  const makeSnapshots = () =>
    new SessionSnapshotStore({
      coverage: new SessionOutputCoverageStore(() => root),
      maxPerSession: 1,
    });
  let snapshots = makeSnapshots();
  let hub = new HubRunReplay(undefined, new SessionOutputCoverageStore(() => root));
  const sent: any[] = [];
  let deliver: (message: any) => void = () => {};
  const transport = {
    send(message: any) {
      if (message.method === "agent/streamEvent") {
        const event = message.params.event;
        if (event.outputCursor)
          expect(readOutputJournal(root, id).through).toBe(event.outputCursor);
        snapshots.append(id, event);
        hub.append(id, event);
      }
      sent.push(message);
    },
    onMessage(handler: (message: any) => void) {
      deliver = handler;
    },
    close() {},
  };
  const server = new AgentServer({
    transport,
    chatManager: { get: () => undefined } as any,
    sessionDiskRoot: root,
    ownsBackgroundWakeups: false,
    readActiveGoalFromDisk: (sid) => manager.readActiveGoal(sid),
    updateActiveGoalOnDisk: (sid, patch) => manager.updateActiveGoal(sid, patch)?.goal,
    clearActiveGoalOnDisk: (sid, expected) => manager.clearActiveGoal(sid, expected),
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSessionTranscriptIpc({ handle: (key, handler) => handlers.set(key, handler) });
  const read = async (options = {}) =>
    handlers.get("sessions:outputJournal")!({}, id, {
      ...options,
      maxFrames: 2,
    });
  const desktop = () =>
    recoverDesktopOutputJournal({
      read,
      snapshot: async () => snapshots.get(id) as any,
      canContinue: () => true,
      latestObservedCursor: () => undefined,
    });
  const hubRecover = async () => {
    const page = readOutputJournal(root, id);
    const base = readOutputJournalLegacyBase(root, id, page.legacyBaseThroughEventId);
    return chatFromOutputJournal(
      {
        state: {},
        transcript: base.events as any,
        outputJournal: page,
        outputCoverage: hub.outputCoverage(id),
      },
      read,
      [],
      () => undefined,
      async () => hub.outputCoverage(id),
    );
  };
  let authority = "grant";
  const replies: any[] = [];
  const mobile = new MobileOutputRecovery({
    root: () => root,
    authority: async () => authority,
    authenticated: () => true,
    snapshot: () => snapshots.get(id),
    reply: (_viewer, event) => replies.push(event),
  });
  const selection = {
    sessionId: id,
    viewerId: "viewer",
    deviceId: "device",
    recoveryId: "selection",
  };
  const mobileRecover = async () => {
    await mobile.handle({ type: "session.select", ...selection });
    return recoverMobileOutput({
      read: async (options = {}) => {
        await mobile.handle({
          type: "session.outputJournal",
          requestId: "page",
          ...selection,
          ...options,
        });
        return replies.at(-1);
      },
      canContinue: () => true,
      latestCursor: () => undefined,
    });
  };
  cleanups.push(() => {
    server.disconnect();
    rmSync(join(root, id), { recursive: true, force: true });
  });
  return {
    root,
    id,
    manager,
    session,
    server,
    deliver: (message: any) => deliver(message),
    sent,
    desktop,
    hubRecover,
    mobileRecover,
    restart() {
      snapshots = makeSnapshots();
      hub = new HubRunReplay(undefined, new SessionOutputCoverageStore(() => root));
    },
    revoke() {
      authority = "revoked";
    },
    snapshots: () => snapshots,
  };
}

test("cold Goal controls persist real no-run events before Main/Hub publication and recover on all existing consumers", async () => {
  const f = fixture();
  expect(
    f.manager.saveActiveGoal(f.session.state, {
      objective: "original",
      goalId: "goal",
      revision: 1,
    } as any),
  ).toBe(true);
  f.deliver({
    jsonrpc: "2.0",
    id: "update",
    method: "agent/goalUpdate",
    params: {
      sessionId: f.id,
      objective: "updated",
      paused: true,
      expectedGoalId: "goal",
      expectedRevision: 1,
    },
  });
  expect(f.sent.find((message) => message.id === "update")?.result.updated).toBe(true);
  f.deliver({
    jsonrpc: "2.0",
    id: "clear",
    method: "agent/goalClear",
    params: {
      sessionId: f.id,
      expectedGoalId: "goal",
      expectedRevision: 2,
    },
  });
  const page = readOutputJournal(f.root, f.id);
  expect(page.status).toBe("ok");
  expect(page.frames.map((frame) => frame.event?.type)).toEqual(["goal_updated", "goal_cleared"]);
  expect(
    page.frames.every((frame) => frame.runId === undefined && frame.producer?.kind === "protocol"),
  ).toBe(true);
  expect(f.manager.readSessionState(f.id)?.runId).toBeUndefined();
  expect(f.snapshots().get(f.id).outputUnpaired).toBeUndefined();
  const before = await f.desktop();
  expect(before?.outputCursor).toBe(page.through);
  expect((await f.hubRecover())?.outputCursor).toBe(page.through);
  expect((await f.mobileRecover())?.outputCursor).toBe(page.through);
  const epoch = f.snapshots().epoch;
  f.restart();
  expect((await f.desktop())?.outputCursor).toBe(page.through);
  expect((await f.hubRecover())?.outputCursor).toBe(page.through);
  expect((await f.mobileRecover())?.outputCursor).toBe(page.through);
  expect(f.snapshots().epoch).not.toBe(epoch);
});

test("actual background queue completion remains durable during an active Run without borrowing its identity or finishing it", async () => {
  const f = fixture();
  const runId = f.session.transcript.appendMessage("user", "question").id;
  f.manager.startSessionRun(f.session.state, runId);
  const writer = new SessionOutputJournal(
    f.root,
    f.id,
    runId,
    f.session.transcript.getEvents()[0].id,
  );
  writer.append({ type: "session_user_message", text: "question", clientMessageId: "user" });
  writer.append({ type: "session_started", sessionId: f.id, promptTokens: 0 });
  writer.append({ type: "stream_request_start", turnNumber: 1 });
  writer.append({ type: "text_delta", text: "running" });
  const queue = new NotificationQueue();
  queue.enqueue(
    {
      agentId: "background",
      description: "result",
      finalText: "DURABLE_BG_汉🙂",
      status: "completed",
      enqueuedAt: 123,
    },
    f.id,
  );
  const notice = f.sent.find(
    (message) => message.params?.event?.type === "background_agent_completed",
  )?.params.event;
  expect(notice.outputCursor).toBeDefined();
  const bgPage = readOutputJournal(f.root, f.id);
  expect(bgPage.frames.at(-1)?.producer?.kind).toBe("protocol");
  expect(bgPage.frames.at(-1)?.runId).toBeUndefined();
  expect(f.manager.readSessionState(f.id)?.runId).toBe(runId);
  expect(
    (await f.desktop())?.state.messages.some(
      (item) => item.kind === "system" && item.text.includes("DURABLE_BG_汉🙂"),
    ),
  ).toBe(true);
  const hub = await f.hubRecover();
  expect(
    hub?.chat.items.some((item) => item.kind === "system" && item.text.includes("DURABLE_BG_汉🙂")),
  ).toBe(true);
  expect(hub?.chat.run).toBe("running");
  expect(
    (await f.mobileRecover())?.chat.items.some(
      (item) => item.kind === "system" && item.text.includes("DURABLE_BG_汉🙂"),
    ),
  ).toBe(true);
  // The original real owner can safely extend the shared verified chain.
  writer.append({ type: "text_delta", text: "continued" });
  expect(readOutputJournal(f.root, f.id).frames.at(-1)?.runId).toBe(runId);
  f.manager.startSessionRun(f.session.state, "next-run");
  expect(() => writer.append({ type: "text_delta", text: "late" })).toThrow("superseded");
  f.restart();
  expect(
    (await f.hubRecover())?.chat.items.some(
      (item) => item.kind === "system" && item.text.includes("DURABLE_BG_汉🙂"),
    ),
  ).toBe(true);
});

test("independent producers retain old gaps and reject deletion/reuse, corruption and malformed Session IDs", async () => {
  const f = fixture();
  const publisher = new SessionOutputPublisher(() => f.root, "host");
  const event = { type: "error", error: "recorded notice" };
  const published: any = publisher.project(f.id, event);
  expect(published.outputCursor).toBeDefined();
  const coverage = new SessionOutputCoverageStore(() => f.root);
  coverage.record(f.id, { unpaired: true, inputIds: [] });
  publisher.project(f.id, { type: "goal_cleared", goalId: "goal", revision: 3 });
  expect(coverage.read(f.id).unpaired).toBe(true);
  await expect(f.desktop()).rejects.toThrow("unpaired");
  expect(() => publisher.project("../outside", event)).toThrow();
  const file = join(f.root, f.id, "output-journal.jsonl");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace("recorded notice", "replaced notice"));
  expect(() => publisher.project(f.id, event)).toThrow();
  expect(readOutputJournal(f.root, f.id).status).toBe("incomplete");
  rmSync(join(f.root, f.id), { recursive: true, force: true });
  f.manager.create(f.root, "fixture", "fixture", f.id);
  expect(() => publisher.project(f.id, event)).toThrow("replaced");
});

test("pre-state user echoes stay pending and explicit persistence failures are never given a cursor", () => {
  const f = fixture();
  const publisher = new SessionOutputPublisher(() => f.root, "host");
  const echo = { type: "session_user_message", text: "pending", clientMessageId: "pending" };
  expect(publisher.project(f.id, echo)).toBe(echo);
  const store = new SessionOutputCoverageStore(() => f.root);
  store.record(f.id, { unpaired: false, inputIds: ["pending"] });
  const release = lockSync(join(f.root, f.id, "state.json"), { realpath: false, retries: 0 });
  try {
    expect(() => publisher.project(f.id, { type: "error", error: "failed" })).toThrow();
  } finally {
    release();
  }
  expect(readOutputJournal(f.root, f.id).status).toBe("unavailable");
  expect(store.read(f.id).inputIds).toEqual(["pending"]);
});
