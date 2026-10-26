import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  appendFileSync,
  renameSync,
  cpSync,
} from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { initialChatState, reduceStream } from "../../../../web/src/lib/streamReducer.js";
import { transcriptToStreamEvents } from "../../../../web/src/lib/transcriptReplay.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type MobileServerEvent, type StreamEvent } from "@cjhyy/code-shell-core";
import { SessionOutputJournal, SessionOutputCoverageStore } from "@cjhyy/code-shell-core/internal";
import { SessionSnapshotStore } from "../SessionSnapshotStore.js";
import { MobileOutputRecovery } from "./output-recovery.js";
import { recoverMobileOutput } from "../../../../web/src/lib/mobileOutputRecovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(
  legacy: Record<string, unknown>[] = [],
  preliminary: Record<string, unknown>[] = [],
  oldHeader = false,
) {
  const root = mkdtempSync(join(tmpdir(), "mobile-journal-"));
  roots.push(root);
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", "native");
  for (const message of legacy) session.transcript.append("message", message);
  const transcript = session.transcript.getEvents();
  manager.startSessionRun(session.state, "run");
  if (oldHeader)
    writeFileSync(
      join(root, "native", "output-journal.jsonl"),
      JSON.stringify({
        version: 1,
        storageScope: createHash("sha256").update(realpathSync(root)).digest("hex"),
        sessionIncarnation: "old-incarnation",
        journalId: "old-journal",
        sessionId: "native",
        startedAt: session.state.startedAt,
        legacyBaseThroughEventId: transcript.at(-1)!.id,
      }) + "\n",
    );
  let writer = new SessionOutputJournal(
    root,
    "native",
    "run",
    session.transcript.getEvents().at(-1)!.id,
  );
  let snapshots = new SessionSnapshotStore({
    maxPerSession: 2,
    coverage: new SessionOutputCoverageStore(() => root),
  });
  const published: StreamEvent[] = [];
  const publish = (event: StreamEvent) => {
    published.push(event);
    return snapshots.append("native", { ...event, outputCursor: writer.append(event) });
  };
  for (const event of preliminary) snapshots.append("native", event);
  publish({ type: "session_user_message", text: "question", clientMessageId: "submit-1" });
  publish({
    type: "session_started",
    sessionId: "native",
    runId: "run",
    clientMessageId: "submit-1",
  });
  publish({ type: "stream_request_start", turnNumber: 1, messageId: "reply" });
  for (let index = 0; index < 20; index++)
    publish({ type: "text_delta", text: "中🙂".repeat(16000) });
  let authority = "mounted-project-root-incarnation";
  const replies: Array<{ viewer: string; event: MobileServerEvent }> = [];
  let resolveAuthority = async () => authority;
  const service = new MobileOutputRecovery({
    root: () => root,
    authority: () => resolveAuthority(),
    snapshot: () => snapshots.get("native"),
    reply: (viewer, event) => replies.push({ viewer, event }),
  });
  const select = () =>
    service.handle({
      type: "session.select",
      sessionId: "native",
      recoveryId: "selection",
      viewerId: "tab",
      deviceId: "device",
    });
  const read = async (options: { after?: string; through?: string } = {}) => {
    await service.handle({
      type: "session.outputJournal",
      sessionId: "native",
      recoveryId: "selection",
      requestId: "page",
      viewerId: "tab",
      deviceId: "device",
      ...options,
    });
    return replies.at(-1)!.event as Extract<MobileServerEvent, { type: "session.outputJournal" }>;
  };
  let baseRequests = 0;
  return {
    root,
    transcript,
    published,
    readBase: async (options: { throughEventId?: string; cursor?: string }, override = {}) => {
      const before = replies.length;
      const requestId = `base-page-${++baseRequests}`;
      await service.handle({
        type: "session.legacyBase",
        sessionId: "native",
        recoveryId: "selection",
        requestId,
        viewerId: "tab",
        deviceId: "device",
        ...options,
        ...override,
      } as any);
      const reply = replies
        .slice(before)
        .find(({ event }) => event.type === "session.legacyBase" && event.requestId === requestId);
      if (!reply) throw new Error("legacy base dispatch returned no reply");
      return reply.event as any;
    },
    service,
    select,
    read,
    publish,
    startNextRun: (runId: string) => {
      manager.startSessionRun(manager.readSessionState("native")!, runId);
      writer = new SessionOutputJournal(root, "native", runId);
      publish({ type: "session_started", sessionId: "native", runId });
    },
    replies,
    snapshots: () => snapshots,
    observe: (event: Record<string, unknown>) => snapshots.append("native", event),
    restart: () => {
      snapshots = new SessionSnapshotStore({
        coverage: new SessionOutputCoverageStore(() => root),
      });
    },
    revokeProject: () => {
      authority = "different-root";
    },
    blockAuthority: (resolve: () => Promise<string>) => {
      resolveAuthority = resolve;
    },
  };
}

test("selected viewer recovers evicted UTF-8 output, catches a frozen append and survives new Main epoch", async () => {
  const f = fixture();
  await f.select();
  let first = true;
  let through: string | undefined;
  const result = await recoverMobileOutput({
    canContinue: () => true,
    latestCursor: () => undefined,
    read: async (options) => {
      const reply = await f.read(options);
      if (first) {
        first = false;
        through = reply.page.through;
        f.publish({ type: "text_delta", text: "last" });
      } else if (options.through === through) expect(reply.page.through).toBe(through);
      return reply;
    },
  });
  expect(
    result?.chat.items
      .filter((item) => item.kind === "assistant")
      .map((item) => item.text)
      .join(""),
  ).toBe("中🙂".repeat(16000 * 20) + "last");
  expect(result?.chat.items.find((item) => item.kind === "user")).toMatchObject({
    clientMessageId: "submit-1",
  });
  expect(result?.chat.run).toBe("running");
  const oldEpoch = result!.snapshot.epoch;
  f.restart();
  const restarted = await recoverMobileOutput({
    read: f.read,
    canContinue: () => true,
    latestCursor: () => undefined,
  });
  expect(restarted?.outputCursor).toBe(result?.outputCursor);
  expect(restarted?.snapshot.epoch).not.toBe(oldEpoch);
  expect(restarted?.chat.run).toBe("running");
  f.publish({ type: "turn_complete", reason: "completed" });
  const finished = await recoverMobileOutput({
    read: f.read,
    canContinue: () => true,
    latestCursor: () => undefined,
  });
  expect(finished?.chat.run).toBe("completed");
});

test("arbitrary Session/selection/viewer and unselected requests receive no journal data", async () => {
  const f = fixture();
  await f.select();
  for (const override of [
    { sessionId: "other" },
    { recoveryId: "other" },
    { viewerId: "other-tab" },
    { deviceId: undefined },
  ]) {
    const before = f.replies.length;
    await f.service.handle({
      type: "session.outputJournal",
      sessionId: "native",
      recoveryId: "selection",
      requestId: "request",
      viewerId: "tab",
      deviceId: "device",
      ...override,
    });
    if (override.deviceId === undefined && "deviceId" in override)
      expect(f.replies.length).toBe(before);
    else
      expect(f.replies.at(-1)?.event).toMatchObject({ page: { status: "incomplete", frames: [] } });
  }
});

for (const change of ["project", "room", "cancel", "offline", "corrupt"] as const) {
  test(`${change} never releases a successful recovery prefix`, async () => {
    const f = fixture();
    await f.select();
    if (change === "project") f.revokeProject();
    else if (change === "room")
      await f.service.handle({
        type: "room.open",
        roomId: "room",
        viewerId: "tab",
        deviceId: "device",
      });
    else if (change === "cancel")
      await f.service.handle({
        type: "session.recovery.cancel",
        viewerId: "tab",
        deviceId: "device",
      });
    else if (change === "offline") f.service.revoke("tab");
    else truncateSync(join(f.root, "native", "output-journal.jsonl"), 0);
    await expect(
      recoverMobileOutput({ read: f.read, canContinue: () => true, latestCursor: () => undefined }),
    ).rejects.toThrow();
    expect(f.replies.every(({ viewer }) => viewer === "tab")).toBe(true);
  });
}

test("room switch while authority awaits cannot mint a late selection grant", async () => {
  const f = fixture();
  let release!: (value: string) => void;
  f.blockAuthority(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const binding = f.select();
  await f.service.handle({
    type: "room.open",
    roomId: "room",
    viewerId: "tab",
    deviceId: "device",
  });
  release("mounted-project-root-incarnation");
  await binding;
  expect(f.replies).toEqual([]);
  expect((await f.read()).page.status).toBe("incomplete");
});

test("legacy cutover wire contains display-only history, no hidden inputs or image bytes", async () => {
  const image = Buffer.from("IMAGE_RAW_SENTINEL").toString("base64");
  const f = fixture([
    { role: "user", injected: true, content: "INJECTED_RAW_SENTINEL" },
    { role: "user", authority: "agent", content: "AGENT_RAW_SENTINEL" },
    { role: "user", authority: "system", content: "SYSTEM_RAW_SENTINEL" },
    { role: "user", authority: "policy", content: "POLICY_RAW_SENTINEL" },
    { role: "system", content: "SYSTEM_ROLE_SENTINEL" },
    {
      role: "user",
      clientMessageId: "old-submit",
      displayText: "old visible question",
      content: [
        {
          type: "text",
          text: '<attached-file path="notes.txt">\nabsolutePath: /private/PLUMBING_SENTINEL/notes.txt\norigin: user\nsize: 11\nmime: text/plain\n</attached-file>\n<attached-image-paths>photo.png</attached-image-paths>',
        },
        { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
      ],
    },
  ]);
  await f.select();
  const wire = await f.read();
  expect(wire.page.status).toBe("ok");
  expect(wire.legacyBaseComplete).toBe(true);
  expect(wire.legacyBase?.throughEventId).toBe(wire.page.legacyBaseThroughEventId);
  const serialized = JSON.stringify(wire);
  for (const sentinel of [
    "INJECTED_RAW_SENTINEL",
    "AGENT_RAW_SENTINEL",
    "SYSTEM_RAW_SENTINEL",
    "POLICY_RAW_SENTINEL",
    "SYSTEM_ROLE_SENTINEL",
    "PLUMBING_SENTINEL",
    image,
    "<attached-file",
    "<attached-image-paths",
    '"base64"',
  ])
    expect(serialized).not.toContain(sentinel);
  expect(
    wire.legacyBase?.events.find((event) => event.clientMessageId === "old-submit"),
  ).toMatchObject({
    type: "user_message",
    text: "old visible question",
    attachments: [
      { name: "notes.txt", path: "notes.txt", size: 11, mime: "text/plain" },
      { name: "photo.png", path: "photo.png", size: 18, mime: "image/png" },
    ],
  });
  const restored = await recoverMobileOutput({
    read: f.read,
    canContinue: () => true,
    latestCursor: () => undefined,
  });
  expect(restored?.chat.items.filter((item) => item.kind === "user")).toHaveLength(2);
});

test("mobile keeps its 1 MiB raw base budget even when display projection would be tiny", async () => {
  const f = fixture(
    Array.from({ length: 3 }, () => ({
      role: "user",
      injected: true,
      content: "x".repeat(650000),
    })),
  );
  await f.select();
  const wire = await f.read();
  expect(wire.page.status).toBe("ok");
  expect(wire.legacyBaseComplete).toBe(false);
  expect(wire.legacyBase?.events).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(2 * 1024 * 1024);
});

test("actual Main handler cannot restore a selection revoked during authority resolution", async () => {
  const { handleClientEvent } = await import("./handle-client-event.js");
  const f = fixture();
  let release!: (value: string) => void;
  f.blockAuthority(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const state = {
    selectedSessionId: "initial",
    selectedProjectId: "current-project",
    selectedRootId: "current-root",
  };
  let lookups = 0;
  const ctx = {
    outputRecovery: f.service,
    getBridge: () => ({ getLastRunContext: () => ({}) }),
    deviceState: () => state,
    lookupDiskSessionCwd: async () => {
      lookups++;
      return "/old";
    },
    sendMobilePermissionMode() {},
    replayPendingMobileApprovals() {},
  } as unknown as import("./handle-client-event.js").OrchestratorCtx;
  const pending = handleClientEvent(ctx, {
    type: "session.select",
    sessionId: "native",
    recoveryId: "retired",
    viewerId: "tab",
    deviceId: "device",
  });
  // A new selection goes through the actual outer handler while the old authority awaits.
  await handleClientEvent(ctx, {
    type: "session.select",
    sessionId: "newer",
    viewerId: "tab",
    deviceId: "device",
  });
  const newer = { ...state };
  expect(state.selectedSessionId).toBe("newer");
  release("mounted-project-root-incarnation");
  await pending;
  expect(state).toEqual(newer);
  expect(lookups).toBe(1);
  expect(f.replies).toEqual([]);
});

test("journal pages have one in-flight read per viewer and eight globally, without a queue", async () => {
  const f = fixture();
  for (let index = 0; index < 9; index++)
    await f.service.handle({
      type: "session.select",
      sessionId: "native",
      recoveryId: `selection-${index}`,
      viewerId: `tab-${index}`,
      deviceId: "device",
    });
  let release!: (value: string) => void;
  const authority = new Promise<string>((resolve) => {
    release = resolve;
  });
  f.blockAuthority(() => authority);
  const request = (index: number) =>
    f.service.handle({
      type: "session.outputJournal",
      sessionId: "native",
      recoveryId: `selection-${index}`,
      requestId: `page-${index}`,
      viewerId: `tab-${index}`,
      deviceId: "device",
    });
  const pending = Array.from({ length: 8 }, (_, index) => request(index));
  const before = f.replies.length;
  await request(8);
  await request(0);
  expect(f.replies.slice(before).map(({ event }) => event)).toEqual([
    expect.objectContaining({
      requestId: "page-8",
      page: expect.objectContaining({ status: "incomplete", frames: [] }),
    }),
    expect.objectContaining({
      requestId: "page-0",
      page: expect.objectContaining({ status: "incomplete", frames: [] }),
    }),
  ]);
  release("mounted-project-root-incarnation");
  await Promise.all(pending);
  expect(f.replies.slice(before + 2)).toHaveLength(8);
  expect(
    f.replies
      .slice(before + 2)
      .every(({ event }) => event.type === "session.outputJournal" && event.page.status === "ok"),
  ).toBe(true);
});

for (const type of ["error", "goal_updated", "goal_cleared", "session_started"] as const) {
  test(`evicted wrapper-external ${type} cannot be skipped by a journal join`, async () => {
    const f = fixture();
    f.observe({ type, message: "not durable", goal: { objective: "not durable" } });
    f.publish({ type: "text_delta", text: "later" });
    f.publish({ type: "turn_complete", reason: "completed" });
    f.startNextRun("next-run");
    f.publish({ type: "turn_complete", reason: "completed" });
    expect(
      f
        .snapshots()
        .get("native")
        .events.every(({ event }) => {
          const raw = event as { type: string; outputCursor?: string };
          return raw.type !== type || typeof raw.outputCursor === "string";
        }),
    ).toBe(true);
    await f.select();
    await expect(
      recoverMobileOutput({ read: f.read, canContinue: () => true, latestCursor: () => undefined }),
    ).rejects.toThrow("unpaired");
  });
}

test("stable preliminary input is covered by the candidate's same submit identity", async () => {
  const f = fixture(
    [],
    [{ type: "session_user_message", text: "question", clientMessageId: "submit-1" }],
  );
  await f.select();
  const result = await recoverMobileOutput({
    read: f.read,
    canContinue: () => true,
    latestCursor: () => undefined,
  });
  expect(result?.snapshot.inputIds ?? []).toEqual([]);
  expect(result?.chat.items.filter((item) => item.kind === "user")).toMatchObject([
    { text: "question", clientMessageId: "submit-1" },
  ]);
});

for (const [preliminary, message] of [
  [[{ type: "session_user_message", text: "no identity" }], "unpaired"],
  [[{ type: "session_user_message", clientMessageId: "different-submit" }], "recorded anchor"],
] as const) {
  test("unidentified or unmatched preliminary input stays behind the barrier", async () => {
    const f = fixture([], [...preliminary]);
    await f.select();
    await expect(
      recoverMobileOutput({ read: f.read, canContinue: () => true, latestCursor: () => undefined }),
    ).rejects.toThrow(message);
  });
}

test("repeat submit identity is paired to its original recorded input, not caller text", async () => {
  const f = fixture(
    [],
    [
      { type: "session_user_message", text: "question", clientMessageId: "submit-1" },
      { type: "session_user_message", text: "not a new task", clientMessageId: "submit-1" },
    ],
  );
  await f.select();
  const result = await recoverMobileOutput({
    read: f.read,
    canContinue: () => true,
    latestCursor: () => undefined,
  });
  expect(result?.snapshot.inputIds ?? []).toEqual([]);
  expect(result?.chat.items.filter((item) => item.kind === "user")).toMatchObject([
    { text: "question", clientMessageId: "submit-1" },
  ]);
  expect(JSON.stringify(result?.chat)).not.toContain("not a new task");
});

test("a recorded new run cannot silently erase older no-run Goal metadata", async () => {
  const f = fixture([], [{ type: "goal_updated", goal: { objective: "old no-run state" } }]);
  await f.select();
  await expect(
    recoverMobileOutput({ read: f.read, canContinue: () => true, latestCursor: () => undefined }),
  ).rejects.toThrow("unpaired");
});

test("reselecting the same viewer cannot overlap its retired page read", async () => {
  const f = fixture();
  await f.select();
  const releases: Array<(value: string) => void> = [];
  f.blockAuthority(() => new Promise((resolve) => releases.push(resolve)));
  const oldRead = f.read();
  const newSelection = f.select();
  releases[1]("mounted-project-root-incarnation");
  await newSelection;
  const busy = await f.read();
  expect(busy.page.status).toBe("incomplete");
  expect(releases).toHaveLength(2);
  releases[0]("mounted-project-root-incarnation");
  await oldRead;
  f.blockAuthority(async () => "mounted-project-root-incarnation");
  expect((await f.read()).page.status).toBe("ok");
});

function mirrorFixture() {
  const snapshots = new SessionSnapshotStore({ maxPerSession: 2 });
  const replies: Array<{ viewer: string; event: MobileServerEvent }> = [];
  let owner: number | undefined = 77;
  let authorized = true;
  let authority = "original-incarnation";
  let pending: (() => Promise<string>) | undefined;
  const service = new MobileOutputRecovery({
    root: () => "unused-by-live-mirror",
    authority: async () => (pending ? pending() : authority),
    snapshot: (id, since) => snapshots.get(id, since),
    reply: (viewer, event) => replies.push({ viewer, event }),
    owner: () => owner,
    authenticated: (viewer, device) => authorized && device === "phone" && viewer !== "revoked",
  });
  const select = (viewer = "tab", sessionId = "external") =>
    service.handle({
      type: "session.select",
      sessionId,
      recoveryId: `selection-${viewer}`,
      viewerId: viewer,
      deviceId: "phone",
    });
  const publish = (event: StreamEvent) => {
    const entry = snapshots.append("external", event);
    service.mirrorOwned({
      ...entry,
      sessionId: "external",
      epoch: snapshots.epoch,
      ownerWebContentsId: 77,
    });
    return entry;
  };
  return {
    service,
    snapshots,
    replies,
    select,
    publish,
    revoke: () => {
      authorized = false;
    },
    ownerChange: () => {
      owner = 88;
    },
    incarnationChange: () => {
      authority = "replacement";
    },
    block: (fn: () => Promise<string>) => {
      pending = fn;
    },
  };
}
const flushMirror = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test("owned mirror targets exact selected viewers, preserving Main seq/epoch and never repeating native frames", async () => {
  const f = mirrorFixture();
  await f.select();
  await f.select("second-tab");
  await f.select("other-project", "other");
  f.replies.length = 0;
  const first = f.publish({ type: "text_delta", text: "owned" });
  f.snapshots.append("external", { type: "text_delta", text: "native-already-mirrored" });
  await flushMirror();
  const streams = f.replies.filter((row) => row.event.type === "session.stream");
  expect(streams.map((row) => row.viewer)).toEqual(["tab", "second-tab"]);
  for (const row of streams)
    expect(row.event).toMatchObject({
      seq: first.seq,
      epoch: f.snapshots.epoch,
      event: { text: "owned" },
    });
});

for (const change of ["revoke", "ownerChange", "incarnationChange"] as const) {
  test(`owned mirror drops captured output after ${change} during asynchronous authority`, async () => {
    const f = mirrorFixture();
    await f.select();
    f.replies.length = 0;
    let release!: (value: string) => void;
    f.block(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    f.publish({ type: "text_delta", text: "private" });
    f[change]();
    // Only the first authority read is delayed; the post-read check sees the
    // actual changed incarnation rather than blocking on a second promise.
    f.block(async () => (change === "incarnationChange" ? "replacement" : "original-incarnation"));
    release("original-incarnation");
    await flushMirror();
    expect(f.replies).toEqual(
      change === "revoke"
        ? []
        : [
            {
              viewer: "tab",
              event: {
                type: "session.recovery.ready",
                sessionId: "external",
                recoveryId: "selection-tab",
                ok: false,
              },
            },
          ],
    );
  });
}

test("large or evicted owned frame advertises only its true committed cursor for bounded page recovery", async () => {
  const f = mirrorFixture();
  await f.select();
  f.replies.length = 0;
  const root = mkdtempSync(join(tmpdir(), "mobile-mirror-journal-"));
  roots.push(root);
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", "external");
  manager.startSessionRun(session.state, "run");
  const writer = new SessionOutputJournal(root, "external", "run");
  const raw: StreamEvent = { type: "text_delta", text: "界".repeat(190000) };
  const cursor = writer.append(raw);
  f.publish({ ...raw, outputCursor: cursor });
  await flushMirror();
  expect(f.replies).toEqual([
    {
      viewer: "tab",
      event: {
        type: "session.snapshot",
        sessionId: "external",
        epoch: f.snapshots.epoch,
        nextSeq: 2,
        entries: [],
        outputCursor: cursor,
      },
    },
  ]);
  // A coalesced control is not an invented visible output event.
  expect(f.replies.some(({ event }) => event.type === "session.stream")).toBe(false);
});

test("owned mirror has eight active authority reads and only one coalesced header per selected viewer", async () => {
  const f = mirrorFixture();
  for (let i = 0; i < 20; i++) await f.select(`tab-${i}`);
  f.replies.length = 0;
  const releases: Array<() => void> = [];
  let active = 0,
    maximum = 0;
  f.block(
    () =>
      new Promise((done) => {
        active++;
        maximum = Math.max(maximum, active);
        releases.push(() => {
          active--;
          done("original-incarnation");
        });
      }),
  );
  f.publish({ type: "text_delta", text: "first" });
  expect(active).toBe(8);
  for (let i = 0; i < 30; i++) f.publish({ type: "text_delta", text: `tail-${i}` });
  expect(active).toBe(8);
  // Resolve the captured first reads, then leave later reads unblocked.
  f.block(async () => "original-incarnation");
  for (const release of releases.splice(0)) release();
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(maximum).toBe(8);
  const streams = f.replies.filter((row) => row.event.type === "session.stream");
  expect(streams.length).toBe(12);
  expect(new Set(streams.map((row) => row.viewer)).size).toBe(12);
  expect(
    streams.every((row) => (row.event as { event: { text: string } }).event.text === "tail-29"),
  ).toBe(true);
  // The first eight evicted frames had no durable cursor; they revoke instead
  // of inventing a recovered prefix or retaining an unbounded event queue.
  expect(
    f.replies.filter((row) => row.event.type === "session.recovery.ready" && !row.event.ok),
  ).toHaveLength(8);
});

const largeLegacy = () => [
  { role: "tool", tool_call_id: "future-tool", content: "result before its definition" },
  ...Array.from({ length: 7 }, (_, index) => ({
    role: "assistant",
    content: [{ type: "text", text: `${index}:` + "汉🙂".repeat(70_000) }],
  })),
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "future-tool", name: "Read", input: { path: "fixture" } }],
  },
];
for (const oldHeader of [false, true])
  test(`${oldHeader ? "old" : "sealed"} 3 MiB base pages concatenate to the whole projection within 1 MiB replies`, async () => {
    const f = fixture(largeLegacy(), [], oldHeader);
    await f.select();
    const first = await f.read();
    expect(first.page.status).toBe("ok");
    expect(first.legacyBaseComplete).toBe(false);
    const events: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 40; page++) {
      const reply = await f.readBase(
        cursor ? { cursor } : { throughEventId: first.page.legacyBaseThroughEventId },
      );
      expect(reply.ok).toBe(true);
      expect(reply.index).toBe(events.length);
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(1024 * 1024);
      events.push(...reply.events);
      if (reply.complete) {
        expect(reply.next).toBeUndefined();
        break;
      }
      expect(reply.next).not.toBe(cursor);
      cursor = reply.next;
    }
    expect(events).toEqual(transcriptToStreamEvents(f.transcript));
    expect(events.filter((event: any) => event.type === "session_started")).toHaveLength(1);
    const restored = await recoverMobileOutput({
      read: f.read,
      readBase: f.readBase,
      canContinue: () => true,
      latestCursor: () => undefined,
    });
    let expected = initialChatState();
    for (const event of transcriptToStreamEvents(f.transcript))
      expected = reduceStream(expected, event);
    expected = { ...expected, run: expected.run === "error" ? "error" : "idle", liveByAgent: {} };
    for (const event of f.published) expected = reduceStream(expected, event);
    expect(restored?.chat).toEqual(expected);
    expect(restored?.chat.items.find((item) => item.kind === "tool")).toMatchObject({
      id: "future-tool",
      name: "Read",
      args: { path: "fixture" },
      result: "result before its definition",
      done: true,
    });
  });

for (const damage of [
  "mac",
  "index",
  "total",
  "recovery",
  "session",
  "cancel",
  "reselect",
  "project",
  "rewrite",
  "truncate",
  "directory",
] as const)
  test(`legacy continuation fails closed on ${damage} without releasing events`, async () => {
    const f = fixture(largeLegacy());
    await f.select();
    const first = await f.read();
    const page = await f.readBase({ throughEventId: first.page.legacyBaseThroughEventId });
    expect(page.ok).toBe(true);
    let cursor = page.next;
    let override = {};
    if (["mac", "index", "total"].includes(damage)) {
      const [payload, mac] = cursor.split(".");
      if (damage === "mac") cursor = payload + "." + (mac[0] === "a" ? "b" : "a") + mac.slice(1);
      else {
        const json = JSON.parse(Buffer.from(payload, "base64url").toString());
        json[damage] += 1;
        cursor = Buffer.from(JSON.stringify(json)).toString("base64url") + "." + mac;
      }
    } else if (damage === "recovery") override = { recoveryId: "other" };
    else if (damage === "session") override = { sessionId: "other" };
    else if (damage === "cancel") f.service.revoke("tab");
    else if (damage === "reselect") await f.select();
    else if (damage === "project") f.revokeProject();
    else if (damage === "rewrite") {
      const file = join(f.root, "native", "transcript.jsonl");
      writeFileSync(file, readFileSync(file, "utf8").replace("0:", "X:"));
    } else if (damage === "truncate") truncateSync(join(f.root, "native", "transcript.jsonl"), 100);
    else renameSync(join(f.root, "native"), join(f.root, "retired"));
    expect(await f.readBase({ cursor }, override)).toMatchObject({
      ok: false,
      reason: "incomplete",
    });
  });

for (const oldHeader of [false, true])
  test(`${oldHeader ? "old" : "sealed"} legacy pages keep the frozen prefix across legal transcript append`, async () => {
    const f = fixture(largeLegacy(), [], oldHeader);
    await f.select();
    const first = await f.read();
    let page = await f.readBase({ throughEventId: first.page.legacyBaseThroughEventId });
    expect(page.ok).toBe(true);
    const events = [...page.events];
    appendFileSync(
      join(f.root, "native", "transcript.jsonl"),
      JSON.stringify({
        id: "later",
        type: "message",
        timestamp: 1,
        data: { role: "assistant", content: "not in prefix" },
      }) + "\n",
    );
    for (let i = 0; !page.complete && i < 40; i++) {
      page = await f.readBase({ cursor: page.next });
      expect(page.ok).toBe(true);
      events.push(...page.events);
    }
    expect(events).toEqual(transcriptToStreamEvents(f.transcript));
  });

test("legacy rejects arbitrary prefixes and a single projected event exceeding the page budget", async () => {
  const f = fixture([{ role: "assistant", content: "x".repeat(1024 * 1024 - 20_000) }]);
  await f.select();
  const first = await f.read();
  expect(first.page.status).toBe("ok");
  expect(first.legacyBaseComplete).toBe(true); // The original 1 MiB inline path still fits.
  expect(await f.readBase({ throughEventId: f.transcript[0].id })).toMatchObject({
    ok: false,
    reason: "incomplete",
  });
  expect(await f.readBase({ throughEventId: first.page.legacyBaseThroughEventId })).toMatchObject({
    ok: false,
    reason: "incomplete",
  });
});

test("base read has a global single-reader busy gate and releases it after revoke or authority throws", async () => {
  const f = fixture(largeLegacy());
  await f.select();
  const first = await f.read();
  await f.service.handle({
    type: "session.select",
    sessionId: "native",
    recoveryId: "second",
    viewerId: "second-tab",
    deviceId: "device",
  });
  let release!: (value: string) => void;
  f.blockAuthority(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.readBase({ throughEventId: first.page.legacyBaseThroughEventId });
  expect(
    await f.readBase(
      { throughEventId: first.page.legacyBaseThroughEventId },
      { viewerId: "second-tab", recoveryId: "second" },
    ),
  ).toMatchObject({ ok: false, reason: "busy" });
  f.service.revoke("tab");
  release("mounted-project-root-incarnation");
  expect(await pending).toMatchObject({ ok: false, reason: "incomplete" });
  f.blockAuthority(async () => {
    throw new Error("gone");
  });
  expect(
    await f.readBase(
      { throughEventId: first.page.legacyBaseThroughEventId },
      { viewerId: "second-tab", recoveryId: "second" },
    ),
  ).toMatchObject({ ok: false, reason: "incomplete" });
  f.blockAuthority(async () => "mounted-project-root-incarnation");
  expect(
    await f.readBase(
      { throughEventId: first.page.legacyBaseThroughEventId },
      { viewerId: "second-tab", recoveryId: "second" },
    ),
  ).toMatchObject({ ok: true });
});

for (const oldHeader of [false, true])
  for (const damage of ["rewrite", "truncate"] as const)
    test(`${oldHeader ? "old" : "sealed"} cursor rejects ${damage} between pages and retains original evidence`, async () => {
      const f = fixture(largeLegacy(), [], oldHeader);
      await f.select();
      const first = await f.read();
      const page = await f.readBase({ throughEventId: first.page.legacyBaseThroughEventId });
      const file = join(f.root, "native", "transcript.jsonl");
      if (damage === "rewrite") writeFileSync(file, readFileSync(file, "utf8").replace("0:", "X:"));
      else truncateSync(file, 100);
      const damaged = readFileSync(file);
      expect(await f.readBase({ cursor: page.next })).toMatchObject({
        ok: false,
        reason: "incomplete",
      });
      expect(readFileSync(file)).toEqual(damaged);
    });

test("signed but malformed cursor payloads cannot expand the selected cutover", async () => {
  const f = fixture(largeLegacy());
  await f.select();
  const first = await f.read();
  const page = await f.readBase({ throughEventId: first.page.legacyBaseThroughEventId });
  const payload = JSON.parse(Buffer.from(page.next.split(".")[0], "base64url").toString());
  // White-box signing exercises decoder checks independently of the MAC check.
  const key = (f.service as any).bindings.get("tab").cursorKey;
  for (const patch of [
    { v: 2 },
    { path: "../outside" },
    { sessionId: "other" },
    { recoveryId: "other" },
    { throughEventId: f.transcript[0].id },
    { endOffset: 0 },
    { endOffset: 32 * 1024 * 1024 + 1 },
    { sha256: "f".repeat(64) },
    { sha256: "F".repeat(64) },
    { index: 0 },
    { index: -1 },
    { index: 1.5 },
    { index: "1" },
    { index: payload.total },
    { total: payload.total + 1 },
    { total: "100" },
    { total: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const body = Buffer.from(JSON.stringify({ ...payload, ...patch })).toString("base64url");
    const token = body + "." + createHmac("sha256", key).update(body).digest("base64url");
    expect(await f.readBase({ cursor: token })).toMatchObject({ ok: false, reason: "incomplete" });
  }
  for (const cursor of ["", "x".repeat(2049), page.next + "=", "e30.invalid", "é.bad", null, 1])
    expect(await f.readBase({ cursor } as any)).toMatchObject({ ok: false, reason: "incomplete" });
  // An independent viewer has a different key even on the same recovery/session.
  await f.service.handle({
    type: "session.select",
    sessionId: "native",
    recoveryId: "selection",
    viewerId: "other-tab",
    deviceId: "device",
  });
  expect(await f.readBase({ cursor: page.next }, { viewerId: "other-tab" })).toMatchObject({
    ok: false,
    reason: "incomplete",
  });
});

test("base pages share the original eight-global and per-viewer journal read limits", async () => {
  const f = fixture(largeLegacy());
  for (let index = 0; index < 9; index++)
    await f.service.handle({
      type: "session.select",
      sessionId: "native",
      recoveryId: `s-${index}`,
      viewerId: `v-${index}`,
      deviceId: "device",
    });
  const throughEventId = f.transcript.at(-1)!.id;
  let release!: (value: string) => void;
  const blocked = new Promise<string>((resolve) => {
    release = resolve;
  });
  f.blockAuthority(() => blocked);
  const journal = (index: number) =>
    f.service.handle({
      type: "session.outputJournal",
      sessionId: "native",
      recoveryId: `s-${index}`,
      requestId: `p-${index}`,
      viewerId: `v-${index}`,
      deviceId: "device",
    });
  const pending = Array.from({ length: 8 }, (_, index) => journal(index));
  expect(
    await f.readBase({ throughEventId }, { viewerId: "v-8", recoveryId: "s-8" }),
  ).toMatchObject({ ok: false, reason: "busy" });
  expect(
    await f.readBase({ throughEventId }, { viewerId: "v-0", recoveryId: "s-0" }),
  ).toMatchObject({ ok: false, reason: "busy" });
  release("mounted-project-root-incarnation");
  await Promise.all(pending);
  f.blockAuthority(async () => "mounted-project-root-incarnation");
  expect(
    await f.readBase({ throughEventId }, { viewerId: "v-8", recoveryId: "s-8" }),
  ).toMatchObject({ ok: true });
});

for (const action of ["revoke", "throw"] as const)
  test(`${action} after the raw read and projection still prevents any events and releases the large-read slot`, async () => {
    const f = fixture(largeLegacy());
    await f.select();
    const first = await f.read();
    let checks = 0;
    f.blockAuthority(async () => {
      if (++checks === 2) {
        if (action === "throw") throw new Error("authority revoked after projection");
        f.service.revoke("tab");
      }
      return "mounted-project-root-incarnation";
    });
    expect(await f.readBase({ throughEventId: first.page.legacyBaseThroughEventId })).toMatchObject(
      {
        ok: false,
        reason: "incomplete",
      },
    );
    expect(checks).toBe(2);
    f.blockAuthority(async () => "mounted-project-root-incarnation");
    await f.select();
    expect(await f.readBase({ throughEventId: first.page.legacyBaseThroughEventId })).toMatchObject(
      {
        ok: true,
      },
    );
  });

test("one base and seven journal reads fill eight shared slots, including the base viewer", async () => {
  const f = fixture(largeLegacy());
  for (let index = 0; index < 9; index++)
    await f.service.handle({
      type: "session.select",
      sessionId: "native",
      recoveryId: `s-${index}`,
      viewerId: `v-${index}`,
      deviceId: "device",
    });
  const throughEventId = f.transcript.at(-1)!.id;
  let release!: (value: string) => void;
  const blocked = new Promise<string>((resolve) => {
    release = resolve;
  });
  f.blockAuthority(() => blocked);
  const base = f.readBase({ throughEventId }, { viewerId: "v-0", recoveryId: "s-0" });
  const journal = (index: number) =>
    f.service.handle({
      type: "session.outputJournal",
      sessionId: "native",
      recoveryId: `s-${index}`,
      requestId: `p-${index}`,
      viewerId: `v-${index}`,
      deviceId: "device",
    });
  const pending = Array.from({ length: 7 }, (_, index) => journal(index + 1));
  const before = f.replies.length;
  await journal(0);
  await journal(8);
  expect(f.replies.slice(before).map(({ event }) => event)).toMatchObject([
    { type: "session.outputJournal", page: { status: "incomplete" } },
    { type: "session.outputJournal", page: { status: "incomplete" } },
  ]);
  release("mounted-project-root-incarnation");
  await Promise.all(pending);
  expect(await base).toMatchObject({ ok: true });
});

test("replacing the Session directory between pages rejects the old cursor and preserves the retired files", async () => {
  const f = fixture(largeLegacy(), [], true);
  await f.select();
  const first = await f.read();
  const page = await f.readBase({ throughEventId: first.page.legacyBaseThroughEventId });
  const original = join(f.root, "native"),
    retired = join(f.root, "retired");
  renameSync(original, retired);
  cpSync(retired, original, { recursive: true });
  const evidence = readFileSync(join(retired, "transcript.jsonl"));
  expect(await f.readBase({ cursor: page.next })).toMatchObject({
    ok: false,
    reason: "incomplete",
  });
  expect(readFileSync(join(retired, "transcript.jsonl"))).toEqual(evidence);
});
