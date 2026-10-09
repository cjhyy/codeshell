import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type MobileServerEvent, type StreamEvent } from "@cjhyy/code-shell-core";
import { SessionOutputJournal } from "@cjhyy/code-shell-core/internal";
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
) {
  const root = mkdtempSync(join(tmpdir(), "mobile-journal-"));
  roots.push(root);
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", "native");
  for (const message of legacy) session.transcript.append("message", message);
  manager.startSessionRun(session.state, "run");
  let writer = new SessionOutputJournal(
    root,
    "native",
    "run",
    session.transcript.getEvents().at(-1)!.id,
  );
  let snapshots = new SessionSnapshotStore({ maxPerSession: 2 });
  const publish = (event: StreamEvent) =>
    snapshots.append("native", { ...event, outputCursor: writer.append(event) });
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
  return {
    root,
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
      snapshots = new SessionSnapshotStore();
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
  expect(result?.snapshot.inputIds).toEqual(["submit-1"]);
  expect(result?.chat.items.filter((item) => item.kind === "user")).toHaveLength(1);
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
  expect(result?.snapshot.inputIds).toEqual(["submit-1"]);
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
