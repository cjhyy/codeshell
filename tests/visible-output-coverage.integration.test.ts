import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
const { SessionManager, sessionsRoot } = await import("../packages/core/src/index.js");
const { SessionOutputJournal, readOutputJournal, readOutputJournalLegacyBase } =
  await import("../packages/core/src/session/output-journal.js");
const { SessionOutputCoverageStore } =
  await import("../packages/core/src/session/output-coverage-state.js");
const { SessionSnapshotStore } =
  await import("../packages/desktop/src/main/SessionSnapshotStore.js");
const { publishOwnedExternalStream } =
  await import("../packages/desktop/src/main/owned-external-stream.js");
const { registerSessionTranscriptIpc } =
  await import("../packages/desktop/src/main/session-transcript-ipc.js");
const { recoverDesktopOutputJournal } =
  await import("../packages/desktop/src/renderer/app/outputJournalRecovery.js");
const { MobileOutputRecovery } =
  await import("../packages/desktop/src/main/mobile-remote/output-recovery.js");
const { recoverMobileOutput } = await import("../packages/web/src/lib/mobileOutputRecovery.js");
const { HubRunReplay } = await import("../packages/server/src/hub/run-replay.js");
const { chatFromOutputJournal } = await import("../packages/web/app/chat.js");
const { initialChatState, reduceStream } = await import("../packages/web/src/lib/streamReducer.js");
const { applyTranscriptStreamEvent } =
  await import("../packages/desktop/src/renderer/transcripts.js");
const { NotificationQueue, agentNotificationBus } =
  await import("../packages/core/src/tool-system/builtin/agent-notifications.js");
const { outputUserInputFixture } = await import("./fixtures/output-journal-user-input.js");
const { lockSync } = await import("../packages/core/src/utils/lockfile.js");
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
let sequence = 0;
function fixture() {
  const root = sessionsRoot(),
    id = `coverage-${++sequence}`;
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", id);
  manager.startSessionRun(session.state, "run");
  const writer = new SessionOutputJournal(root, id, "run", session.transcript.getEvents()[0].id);
  const makeStore = () =>
    new SessionSnapshotStore({
      maxPerSession: 1,
      coverage: new SessionOutputCoverageStore(() => root),
    });
  let snapshots = makeStore();
  const sends: any[] = [];
  const windows = [
    {
      isDestroyed: () => false,
      webContents: { id: 7, send: (_channel: string, value: unknown) => sends.push(value) },
    },
  ];
  const emit = (event: any) => publishOwnedExternalStream(snapshots, windows, 7, id, event);
  const publish = (event: any) => emit({ ...event, outputCursor: writer.append(event) });
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSessionTranscriptIpc({
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
  });
  const read = async (options = {}) =>
    handlers.get("sessions:outputJournal")!({}, id, { ...options, maxFrames: 2 });
  const desktop = () =>
    recoverDesktopOutputJournal({
      read,
      snapshot: async () => snapshots.get(id) as any,
      canContinue: () => true,
      latestObservedCursor: () => undefined,
    });
  let authority = "root-authority";
  const replies: any[] = [];
  const mobile = new MobileOutputRecovery({
    root: () => root,
    authority: async () => authority,
    authenticated: () => true,
    snapshot: () => snapshots.get(id),
    reply: (_viewer, event) => replies.push(event),
  });
  const mobileSelect = () =>
    mobile.handle({
      type: "session.select",
      sessionId: id,
      recoveryId: "selection",
      viewerId: "viewer",
      deviceId: "device",
    });
  const mobileRead = async (options = {}) => {
    await mobile.handle({
      type: "session.outputJournal",
      sessionId: id,
      recoveryId: "selection",
      requestId: "read",
      viewerId: "viewer",
      deviceId: "device",
      ...options,
    });
    return replies.at(-1);
  };
  const mobileRecover = () =>
    recoverMobileOutput({
      read: mobileRead,
      canContinue: () => true,
      latestCursor: () => undefined,
    });
  publish({ type: "session_user_message", text: "question", clientMessageId: "input" });
  publish({ type: "stream_request_start", turnNumber: 1, messageId: "reply" });
  publish({ type: "text_delta", text: "recorded answer" });
  publish({ type: "turn_complete", reason: "completed", turnNumber: 1 });
  cleanups.push(() => rmSync(join(root, id), { recursive: true, force: true }));
  return {
    root,
    id,
    manager,
    session,
    writer,
    emit,
    publish,
    sends,
    snapshots: () => snapshots,
    restart: () => {
      snapshots = makeStore();
    },
    desktop,
    mobileSelect,
    mobileRead,
    mobileRecover,
    revoke: () => {
      authority = "revoked";
    },
  };
}

test("actual owned Main publication + IPC/Desktop/Mobile recover a healthy cursor and fresh Host generation", async () => {
  const f = fixture();
  await f.mobileSelect();
  const desktop = await f.desktop(),
    mobile = await f.mobileRecover();
  expect(
    desktop?.state.messages.some(
      (item) => item.kind === "assistant" && item.text === "recorded answer",
    ),
  ).toBe(true);
  expect(
    mobile?.chat.items.some((item) => item.kind === "assistant" && item.text === "recorded answer"),
  ).toBe(true);
  const epoch = f.snapshots().epoch;
  f.restart();
  expect((await f.desktop())?.outputCursor).toBe(desktop?.outputCursor);
  expect((await f.mobileRecover())?.outputCursor).toBe(mobile?.outputCursor);
  expect(f.snapshots().epoch).not.toBe(epoch);
  expect(f.sends).toHaveLength(4);
});

for (const type of [
  "goal_updated",
  "error",
  "background_agent_completed",
  "context_compact",
] as const)
  test(`real ${type} gap survives eviction/run finish/restart at all three recovery entrances`, async () => {
    const f = fixture();
    const hub = new HubRunReplay(
      { maxEvents: 1, maxBytes: 1000 },
      new SessionOutputCoverageStore(() => f.root),
    );
    hub.begin(f.id, "request", 1);
    const event =
      type === "background_agent_completed"
        ? {
            type,
            agentId: "late-agent",
            description: "result",
            finalText: "PRIVATE_RESULT_CANARY",
            status: "completed",
            enqueuedAt: 1,
          }
        : type === "error"
          ? { type, error: "outside run" }
          : type === "context_compact"
            ? { type, strategy: "full", before: 100, after: 10 }
            : { type, goalId: "goal", revision: 1, goal: "new objective" };
    const beforeDisplay = type === "context_compact" ? (await f.desktop())!.state : undefined;
    f.emit(event);
    if (type === "context_compact") {
      const state = applyTranscriptStreamEvent(beforeDisplay!, event as any);
      expect(state.messages).toContainEqual(
        expect.objectContaining({ kind: "context_boundary", before: 100, after: 10 }),
      );
    }
    hub.append(f.id, event);
    f.emit({ type: "session_title", title: "metadata" });
    hub.append(f.id, { type: "session_title", title: "metadata" });
    hub.finish(f.id, "request");
    expect(hub.snapshot(f.id, []).liveStream).toBeUndefined();
    expect(f.snapshots().get(f.id).events).toHaveLength(1);
    await expect(f.desktop()).rejects.toThrow("unpaired");
    await f.mobileSelect();
    await expect(f.mobileRecover()).rejects.toThrow("unpaired");
    const page = readOutputJournal(f.root, f.id),
      base = readOutputJournalLegacyBase(f.root, f.id, page.legacyBaseThroughEventId);
    const hubRecover = (replay: InstanceType<typeof HubRunReplay>) =>
      chatFromOutputJournal(
        {
          state: {},
          transcript: base.events as unknown as Record<string, unknown>[],
          outputJournal: page,
          outputCoverage: replay.outputCoverage(f.id),
        },
        async (options) => readOutputJournal(f.root, f.id, options),
        [],
        () => undefined,
        async () => replay.outputCoverage(f.id),
      );
    await expect(hubRecover(hub)).rejects.toThrow("unpaired");
    f.restart();
    await expect(f.desktop()).rejects.toThrow("unpaired");
    await expect(f.mobileRecover()).rejects.toThrow("unpaired");
    const restartedHub = new HubRunReplay(undefined, new SessionOutputCoverageStore(() => f.root));
    await expect(hubRecover(restartedHub)).rejects.toThrow("unpaired");
    const state = f.manager.readSessionState(f.id)!;
    expect(state.outputRecoveryIncomplete).toBeUndefined();
    expect(JSON.stringify(state.outputCoverage)).not.toContain("PRIVATE_RESULT_CANARY");
    // The old recorded cursor remains a valid prefix: the proof never invents a terminal.
    expect(readOutputJournal(f.root, f.id).status).toBe("ok");
  });

test("actual notification queue/bus completion displays in Desktop and shared Hub/Mobile reducer without finishing active turn", async () => {
  const f = fixture();
  let desktop = (await f.desktop())!.state;
  let web = reduceStream(initialChatState(), { type: "stream_request_start", turnNumber: 1 });
  web = reduceStream(web, { type: "agent_start", agentId: "background", description: "working" });
  const unsubscribe = agentNotificationBus.subscribe((sessionId, event) => {
    if (sessionId !== f.id) return;
    f.emit(event);
    desktop = applyTranscriptStreamEvent(desktop, event);
    web = reduceStream(web, event);
  });
  try {
    const queue = new NotificationQueue();
    expect(
      queue.enqueue(
        {
          agentId: "background",
          description: "analysis complete",
          finalText: "actual queued result",
          status: "completed",
          enqueuedAt: 1,
        },
        f.id,
      ),
    ).toBeDefined();
    expect(f.sends.at(-1).event.type).toBe("background_agent_completed");
    expect(
      desktop.messages.some(
        (item) => item.kind === "system" && item.text.includes("actual queued result"),
      ),
    ).toBe(true);
    expect(
      web.items.some(
        (item) => item.kind === "system" && item.text.includes("actual queued result"),
      ),
    ).toBe(true);
    expect(web.items).toContainEqual(
      expect.objectContaining({ kind: "subagent", agentId: "background", status: "completed" }),
    );
    expect(web.run).toBe("running");
    await expect(f.desktop()).rejects.toThrow("unpaired");
  } finally {
    unsubscribe();
  }
});

test("pending user inputs settle only from real durable anchors across more than 128 healthy turns", async () => {
  const f = fixture();
  for (let index = 0; index < 140; index++) {
    const id = `next-${index}`;
    f.emit({ type: "session_user_message", text: "next", clientMessageId: id });
    expect(f.snapshots().get(f.id).outputInputIds).toContain(id);
    f.publish({ type: "session_user_message", text: "next", clientMessageId: id });
    expect(f.snapshots().get(f.id).outputInputIds).toBeUndefined();
  }
  expect(f.snapshots().get(f.id).outputUnpaired).toBeUndefined();
  expect((await f.desktop())?.outputCursor).toBeDefined();
  f.restart();
  expect((await f.desktop())?.outputCursor).toBeDefined();
});

test("real Engine-generated journal input and output remain recoverable with current coverage contract", async () => {
  const f = await outputUserInputFixture("normal");
  try {
    const replay = new HubRunReplay(undefined, new SessionOutputCoverageStore(() => f.sessionRoot));
    for (const event of f.events) replay.append(f.sessionId, event);
    const page = readOutputJournal(f.sessionRoot, f.sessionId),
      base = readOutputJournalLegacyBase(f.sessionRoot, f.sessionId, page.legacyBaseThroughEventId);
    const result = await chatFromOutputJournal(
      {
        state: {},
        transcript: base.events as unknown as Record<string, unknown>[],
        outputJournal: page,
        outputCoverage: replay.outputCoverage(f.sessionId),
      },
      async (options) => readOutputJournal(f.sessionRoot, f.sessionId, options),
      [],
      () => undefined,
      async () => replay.outputCoverage(f.sessionId),
    );
    expect(
      result?.chat.items.some(
        (item) => item.kind === "user" && item.clientMessageId === "fixture-input",
      ),
    ).toBe(true);
    expect(
      result?.chat.items.some((item) => item.kind === "assistant" && item.text.includes("reply")),
    ).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("whole-state save preserves coverage; a missing required field cannot become healthy after restart", async () => {
  const f = fixture(),
    stale = f.manager.readSessionState(f.id)!;
  f.emit({ type: "goal_cleared", goalId: "goal", revision: 1 });
  f.manager.saveState(stale);
  expect(f.manager.readSessionState(f.id)!.outputCoverage?.unpaired).toBe(true);
  const path = join(f.root, f.id, "state.json"),
    state = JSON.parse(readFileSync(path, "utf8"));
  delete state.outputCoverage;
  writeFileSync(path, JSON.stringify(state));
  f.restart();
  await expect(f.desktop()).rejects.toThrow("unpaired");
  await f.mobileSelect();
  await expect(f.mobileRecover()).rejects.toThrow("unpaired");
});

test("authority revocation and deletion/reuse during final join never publish a stale candidate or resurrect Session", async () => {
  const f = fixture();
  await f.mobileSelect();
  f.revoke();
  await expect(f.mobileRecover()).rejects.toThrow();
  const page = await (async () => {
    const handlers = new Map<string, any>();
    registerSessionTranscriptIpc({
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    });
    return handlers.get("sessions:outputJournal")({}, f.id);
  })();
  rmSync(join(f.root, f.id), { recursive: true, force: true });
  expect(new SessionOutputCoverageStore(() => f.root).read(f.id).status).toBe("unavailable");
  await expect(
    recoverDesktopOutputJournal({
      read: async () => page,
      snapshot: async () => {
        const replacement = f.manager.create(f.root, "fixture", "fixture", f.id);
        f.manager.startSessionRun(replacement.state, "new-run");
        const journal = new SessionOutputJournal(
          f.root,
          f.id,
          "new-run",
          replacement.transcript.getEvents()[0].id,
        );
        journal.append({
          type: "session_user_message",
          text: "new",
          clientMessageId: "replacement",
        });
        f.restart();
        return f.snapshots().get(f.id) as any;
      },
      canContinue: () => true,
      latestObservedCursor: () => undefined,
    }),
  ).rejects.toThrow("incarnation");
  // No proof write manufactures a missing state/directory.
  const missing = "coverage-missing";
  expect(
    new SessionOutputCoverageStore(() => f.root).record(missing, { unpaired: true, inputIds: [] })
      .status,
  ).toBe("unavailable");
  expect(() => readFileSync(join(f.root, missing, "state.json"))).toThrow();
});

test("actual Main publication survives coverage lock failure without sending the unproved event or banning the next healthy run", async () => {
  const f = fixture(),
    sent = f.sends.length;
  const release = lockSync(join(f.root, f.id, "state.json"), {
    realpath: false,
    retries: 0,
    stale: 10000,
    update: 5000,
  });
  try {
    expect(() => f.emit({ type: "goal_updated", goalId: "blocked", revision: 1 })).not.toThrow();
    expect(f.sends).toHaveLength(sent);
    expect(f.snapshots().get(f.id).outputUnpaired).toBe(true);
  } finally {
    release();
  }
  f.publish({ type: "stream_request_start", turnNumber: 2, messageId: "healthy-next" });
  f.publish({ type: "text_delta", text: "next healthy run" });
  f.publish({ type: "turn_complete", reason: "completed", turnNumber: 2 });
  expect(f.sends).toHaveLength(sent + 3);
  expect(f.manager.readSessionState(f.id)!.outputRecoveryIncomplete).toBeUndefined();
  await expect(f.desktop()).rejects.toThrow("unpaired");
  f.restart();
  expect(
    (await f.desktop())?.state.messages.some(
      (item) => item.kind === "assistant" && item.text === "next healthy run",
    ),
  ).toBe(true);
});

test("visible publication before a real Session exists is withheld and never manufactures lifecycle state", () => {
  const root = sessionsRoot(),
    store = new SessionSnapshotStore({ coverage: new SessionOutputCoverageStore(() => root) }),
    sends: any[] = [];
  const id = "not-created-yet";
  expect(
    publishOwnedExternalStream(
      store,
      [
        {
          isDestroyed: () => false,
          webContents: { id: 1, send: (_channel, value) => sends.push(value) },
        },
      ],
      1,
      id,
      { type: "background_agent_completed", agentId: "late", status: "completed", enqueuedAt: 1 },
    ),
  ).toBeUndefined();
  expect(sends).toHaveLength(0);
  expect(store.get(id).outputUnpaired).toBe(true);
  expect(() => readFileSync(join(root, id, "state.json"))).toThrow();
});

test("a valid page followed by plain Session deletion cannot become a legacy complete candidate", async () => {
  const f = fixture();
  const handlers = new Map<string, any>();
  registerSessionTranscriptIpc({ handle: (name, handler) => handlers.set(name, handler) });
  const page = await handlers.get("sessions:outputJournal")({}, f.id);
  rmSync(join(f.root, f.id), { recursive: true, force: true });
  f.restart();
  await expect(
    recoverDesktopOutputJournal({
      read: async () => page,
      snapshot: async () => f.snapshots().get(f.id) as any,
      canContinue: () => true,
      latestObservedCursor: () => undefined,
    }),
  ).rejects.toThrow();
});

test("FIFO state is rejected by a bounded guarded child without blocking Host coverage I/O", async () => {
  if (process.platform === "win32") return;
  const root = sessionsRoot(),
    id = "coverage-fifo";
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, id));
  cleanups.push(() => rmSync(join(root, id), { recursive: true, force: true }));
  expect(spawnSync("mkfifo", [join(root, id, "state.json")]).status).toBe(0);
  const script = `import http from "node:http";import https from "node:https";import net from "node:net";
  let denied=0;const deny=()=>{denied++;throw Error("child denied")};globalThis.fetch=deny;http.request=http.get=https.request=https.get=net.connect=net.createConnection=net.Socket.prototype.connect=deny;
  try{fetch("https://outside.invalid")}catch{}try{https.get("https://outside.invalid")}catch{}
  if(denied!==2)throw Error("guard missing");
  const {SessionOutputCoverageStore}=await import(${JSON.stringify(new URL("../packages/core/src/session/output-coverage-state.ts", import.meta.url).href)});
  const proof=new SessionOutputCoverageStore(()=>${JSON.stringify(root)}).read(${JSON.stringify(id)});
  if(proof.status!=="incomplete"||!proof.unpaired)throw Error("FIFO accepted");console.log(JSON.stringify({guardDenials:denied,status:proof.status}));`;
  const child = spawn(process.execPath, ["-e", script], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let forced = false,
    stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const timer = setTimeout(() => {
    forced = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 250).unref();
  }, 1500);
  const result = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  clearTimeout(timer);
  expect({ forced, ...result, stderr }).toEqual({
    forced: false,
    code: 0,
    signal: null,
    stderr: "",
  });
  expect(JSON.parse(stdout)).toEqual({ guardDenials: 2, status: "incomplete" });
});

test("finished persisted Hub coverage releases healthy RAM entries while retaining durable gaps", () => {
  const f = fixture(),
    hub = new HubRunReplay(undefined, new SessionOutputCoverageStore(() => f.root));
  for (let n = 0; n < 32; n++) {
    const id = `retired-${n}`,
      session = f.manager.create(f.root, "fixture", "fixture", id);
    cleanups.push(() => rmSync(join(f.root, id), { recursive: true, force: true }));
    f.manager.startSessionRun(session.state, "run");
    const journal = new SessionOutputJournal(
      f.root,
      id,
      "run",
      session.transcript.getEvents()[0].id,
    );
    const event = {
      type: "session_user_message" as const,
      text: "question",
      clientMessageId: "input",
    };
    hub.begin(id, "run", 1);
    hub.append(id, { ...event, outputCursor: journal.append(event) });
    hub.finish(id, "run");
  }
  expect((hub as any).coverage.size).toBe(0);
  hub.begin(f.id, "gap", 1);
  hub.append(f.id, {
    type: "background_agent_completed",
    agentId: "late",
    status: "completed",
    enqueuedAt: 1,
  });
  hub.finish(f.id, "gap");
  expect((hub as any).coverage.size).toBe(0);
  expect(hub.outputCoverage(f.id).unpaired).toBe(true);
  hub.clear();
  expect(hub.outputCoverage(f.id).unpaired).toBe(true);
  const oldId = "retired-without-journal";
  f.manager.create(f.root, "fixture", "fixture", oldId);
  cleanups.push(() => rmSync(join(f.root, oldId), { recursive: true, force: true }));
  hub.begin(oldId, "gap", 1);
  hub.append(oldId, { type: "context_compact", summary: "visible boundary" });
  hub.finish(oldId, "gap");
  expect((hub as any).coverage.size).toBe(0);
  expect(new SessionOutputCoverageStore(() => f.root).read(oldId)).toMatchObject({
    status: "unavailable",
    unpaired: true,
  });
  expect(hub.outputCoverage(oldId).unpaired).toBe(true);
});

test("journal-unavailable fallback retains legacy sessions but rejects published durable gaps and pending inputs", async () => {
  const root = sessionsRoot(),
    manager = new SessionManager(root);
  for (const kind of ["legacy", "background", "input"] as const) {
    const id = `without-journal-${kind}`;
    const session = manager.create(root, "fixture", "fixture", id);
    cleanups.push(() => rmSync(join(root, id), { recursive: true, force: true }));
    const makeStore = () =>
      new SessionSnapshotStore({
        maxPerSession: 1,
        coverage: new SessionOutputCoverageStore(() => root),
      });
    let snapshots = makeStore();
    const replay = new HubRunReplay(undefined, new SessionOutputCoverageStore(() => root));
    if (kind !== "legacy") {
      const event =
        kind === "input"
          ? { type: "session_user_message" as const, text: "question", clientMessageId: "pending" }
          : {
              type: "background_agent_completed" as const,
              agentId: "late",
              status: "completed" as const,
              enqueuedAt: 1,
            };
      const sends: unknown[] = [];
      expect(
        publishOwnedExternalStream(
          snapshots,
          [
            {
              isDestroyed: () => false,
              webContents: { id: 7, send: (_channel: string, value: unknown) => sends.push(value) },
            },
          ],
          7,
          id,
          event,
        ),
      ).toBeDefined();
      expect(sends).toHaveLength(1);
      replay.begin(id, "run", 1);
      replay.append(id, event);
      replay.finish(id, "run");
      snapshots = makeStore(); // All Main RAM is gone; the proof belongs to the Session.
    }
    const read = async () => readOutputJournal(root, id);
    expect((await read()).status).toBe("unavailable");
    const desktop = () =>
      recoverDesktopOutputJournal({
        read,
        snapshot: async () => snapshots.get(id) as any,
        canContinue: () => true,
        latestObservedCursor: () => undefined,
      });
    const replies: any[] = [];
    const mobile = new MobileOutputRecovery({
      root: () => root,
      authority: async () => "authority",
      authenticated: () => true,
      snapshot: () => snapshots.get(id),
      reply: (_viewer, reply) => replies.push(reply),
    });
    await mobile.handle({
      type: "session.select",
      sessionId: id,
      recoveryId: "selection",
      viewerId: "viewer",
      deviceId: "device",
    });
    const mobileRead = async () => {
      await mobile.handle({
        type: "session.outputJournal",
        sessionId: id,
        recoveryId: "selection",
        requestId: "read",
        viewerId: "viewer",
        deviceId: "device",
      });
      return replies.at(-1);
    };
    const consumers = [
      desktop,
      () =>
        recoverMobileOutput({
          read: mobileRead,
          canContinue: () => true,
          latestCursor: () => undefined,
        }),
      () =>
        chatFromOutputJournal(
          {
            state: session.state,
            transcript: session.transcript.getEvents() as any,
            running: false,
            outputJournal: readOutputJournal(root, id),
            outputCoverage: replay.outputCoverage(id),
          },
          read,
          [],
          undefined,
          async () => replay.outputCoverage(id),
        ),
    ];
    for (const consume of consumers) {
      if (kind === "legacy") expect(await consume()).toBeNull();
      else
        await expect(consume()).rejects.toThrow(
          kind === "background" ? "unpaired" : "recorded anchor",
        );
    }
  }
});

test("actual Mobile client holds a pending input before the first journal and recovers its later canonical boundary", async () => {
  const { MobileOutputClient } = await import("../packages/web/src/hooks/mobileOutputClient.js");
  const root = sessionsRoot(),
    id = "mobile-first-pending",
    manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", id);
  cleanups.push(() => rmSync(join(root, id), { recursive: true, force: true }));
  const snapshots = new SessionSnapshotStore({
    coverage: new SessionOutputCoverageStore(() => root),
  });
  const input = {
    type: "session_user_message" as const,
    text: "canonical question",
    clientMessageId: "pending",
  };
  snapshots.append(id, input);
  let client: InstanceType<typeof MobileOutputClient>;
  const commits: any[] = [],
    replies: any[] = [],
    pending: Promise<unknown>[] = [];
  let failures = 0;
  const service = new MobileOutputRecovery({
    root: () => root,
    authority: async () => "authority",
    authenticated: () => true,
    snapshot: () => snapshots.get(id),
    reply: (_viewer, event) => {
      replies.push(event);
      client.observe(event);
    },
  });
  client = new MobileOutputClient({
    current: () => ({ sessionId: id, revision: 1 }),
    send: (event) => {
      queueMicrotask(() =>
        pending.push(service.handle({ ...event, viewerId: "viewer", deviceId: "device" } as any)),
      );
      return true;
    },
    commit: (_id, result) => commits.push(result),
    failed: () => {
      failures++;
    },
    legacy: () => {
      throw Error("Pending input cannot become legacy success");
    },
  });
  cleanups.push(() => client.cancel(false));
  client.observe({
    type: "auth.ok",
    capabilities: { outputJournal: 1 },
    device: { id: "device", name: "fixture" },
  } as any);
  client.begin(id);
  expect(client.hold(id, input)).toBe("pending");
  for (let n = 0; n < 40; n++) {
    await Promise.resolve();
    await Promise.all(pending);
  }
  expect(
    replies.some(
      (r) =>
        r.type === "session.outputJournal" &&
        r.page.status === "unavailable" &&
        r.snapshot.inputIds[0] === "pending",
    ),
  ).toBe(true);
  expect(failures).toBe(0);
  expect(commits).toHaveLength(0);
  manager.startSessionRun(session.state, "run");
  const journal = new SessionOutputJournal(root, id, "run", session.transcript.getEvents()[0].id);
  snapshots.append(id, { ...input, outputCursor: journal.append(input) });
  const boundary = { type: "session_started" as const, sessionId: id, clientMessageId: "pending" };
  const outputCursor = journal.append(boundary as any);
  snapshots.append(id, { ...boundary, outputCursor });
  expect(client.hold(id, { ...boundary, outputCursor })).toBe("pending");
  for (let n = 0; n < 80 && !commits.length; n++) {
    await Promise.resolve();
    await Promise.all(pending);
  }
  expect(failures).toBe(0);
  expect(commits).toHaveLength(1);
  expect(commits[0].chat.items.filter((i: any) => i.kind === "user")).toMatchObject([
    { text: "canonical question", clientMessageId: "pending" },
  ]);
  expect(commits[0].outputCursor).toBe(outputCursor);
});
