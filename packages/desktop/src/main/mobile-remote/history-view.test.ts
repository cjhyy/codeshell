import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  SessionManager,
  type MobileClientEvent,
  type MobileHistoryView,
  type MobileHistoryItem,
  type MobileHistoryDetail,
  type MobileServerEvent,
  type StreamEvent,
} from "@cjhyy/code-shell-core";
import { SessionOutputJournal, SessionOutputCoverageStore } from "@cjhyy/code-shell-core/internal";
import { initialChatState, reduceStream, transcriptToStreamEvents } from "@cjhyy/code-shell-web";
import { SessionSnapshotStore } from "../SessionSnapshotStore.js";
import { MobileOutputRecovery } from "./output-recovery.js";
import { projectHistoryView, UnsupportedHistoryView } from "./history-view-projection.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(
  events: StreamEvent[],
  options: { noBase?: boolean; producer?: boolean; legacyText?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "mobile-history-view-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", "history");
  if (options.legacyText) {
    for (let offset = 0; offset < options.legacyText.length; offset += 500_000)
      session.transcript.append("message", {
        role: "assistant",
        content: [{ type: "text", text: options.legacyText.slice(offset, offset + 500_000) }],
      });
  }
  manager.startSessionRun(session.state, "run");
  const writer = new SessionOutputJournal(
    root,
    "history",
    options.producer ? { kind: "protocol", id: "external-owner" } : "run",
    options.noBase ? undefined : session.transcript.getEvents().at(-1)!.id,
  );
  let chat = initialChatState();
  for (const event of options.noBase
    ? []
    : transcriptToStreamEvents(session.transcript.getEvents()))
    chat = reduceStream(chat, event);
  let outputCursor = "";
  let batch: StreamEvent[] = [];
  const flush = () => {
    if (batch.length) outputCursor = writer.appendBatch(batch).at(-1)!;
    batch = [];
  };
  for (const event of events) {
    chat = reduceStream(chat, event);
    if (Buffer.byteLength(JSON.stringify(event)) > 64 * 1024) {
      flush();
      outputCursor = writer.append(event);
    } else {
      batch.push(event);
      if (batch.length === 16) flush();
    }
  }
  flush();
  const snapshots = new SessionSnapshotStore({
    coverage: new SessionOutputCoverageStore(() => root),
  });
  if (outputCursor)
    snapshots.append("history", { type: "turn_complete", reason: "completed", outputCursor });
  const replies: MobileServerEvent[] = [];
  const state = {
    epoch: undefined as string | undefined,
    owner: 1,
    revision: 1,
    auth: true,
    authority: "mounted-root",
    root,
    beforeAuthority: undefined as undefined | (() => Promise<void>),
  };
  const service = new MobileOutputRecovery({
    root: () => state.root,
    authority: async () => {
      await state.beforeAuthority?.();
      return state.authority;
    },
    snapshot: (id) => {
      const value = snapshots.get(id);
      return state.epoch ? { ...value, epoch: state.epoch } : value;
    },
    reply: (_viewer, event) => replies.push(JSON.parse(JSON.stringify(event))),
    owner: () => state.owner,
    ownerRevision: () => state.revision,
    authenticated: () => state.auth,
  });
  let requestId = 0;
  const send = async (event: MobileClientEvent, viewer = "viewer", device = "device") => {
    await service.handle({ ...event, viewerId: viewer, deviceId: device });
    return replies.at(-1)!;
  };
  const select = (recoveryId = "recovery", viewer = "viewer") =>
    send({ type: "session.select", sessionId: "history", recoveryId }, viewer);
  const view = async (before?: string, recoveryId = "recovery", viewer = "viewer") => {
    const reply = await send(
      {
        type: "session.historyView",
        sessionId: "history",
        recoveryId,
        requestId: String(++requestId),
        ...(before ? { before } : {}),
      },
      viewer,
    );
    if (reply.type !== "session.historyView") throw new Error("Unexpected history reply");
    return reply.result;
  };
  const detail = async (
    ref: string,
    cursor?: string,
    recoveryId = "recovery",
    viewer = "viewer",
  ) => {
    const reply = await send(
      {
        type: "session.historyDetail",
        sessionId: "history",
        recoveryId,
        requestId: String(++requestId),
        ref,
        ...(cursor ? { cursor } : {}),
      },
      viewer,
    );
    if (reply.type !== "session.historyDetail") throw new Error("Unexpected detail reply");
    return reply.result;
  };
  return {
    root,
    session,
    writer,
    snapshots,
    replies,
    state,
    service,
    send,
    select,
    view,
    detail,
    chat,
    outputCursor,
  };
}
const input = (id: string): StreamEvent => ({
  type: "session_user_message",
  text: id,
  clientMessageId: id,
});
const start = (id: string, args?: Record<string, unknown>): StreamEvent => ({
  type: "tool_use_start",
  toolCall: { id, toolName: "Read", ...(args ? { args } : {}) },
});
const result = (id: string, text: string): StreamEvent => ({
  type: "tool_result",
  result: { id, result: text },
});
const end: StreamEvent = { type: "turn_complete", reason: "completed" };
const simple = () => [
  input("stable-user"),
  { type: "stream_request_start", turnNumber: 1 } as StreamEvent,
  start("tool", { path: "fixture" }),
  result("tool", "owned result"),
  end,
];
function ok(value: Awaited<ReturnType<ReturnType<typeof fixture>["view"]>>): MobileHistoryView {
  expect(value.status).toBe("ok");
  if (value.status !== "ok") throw new Error("Expected verified view");
  return value;
}
function withoutRefs(item: MobileHistoryItem): unknown {
  const copy = { ...item } as Record<string, unknown>;
  for (const key of ["detailRef", "textDetailRef", "reasoningDetailRef", "activityGroupKey"])
    delete copy[key];
  return copy;
}

test("8.5 MiB/513 tools: small first page, complete earlier reconstruction and no eager detail body", async () => {
  const events: StreamEvent[] = [
    input("old-user"),
    { type: "stream_request_start", turnNumber: 1 },
  ];
  for (let i = 0; i < 513; i++) {
    events.push(start(`t${i}`, { index: i }), result(`t${i}`, "x".repeat(17_408)));
  }
  events.push(end);
  const f = fixture(events);
  await f.select();
  const started = performance.now();
  let page = ok(await f.view());
  const firstMs = performance.now() - started;
  const firstBytes = Buffer.byteLength(JSON.stringify(f.replies.at(-1)));
  expect(firstBytes).toBeLessThan(32 * 1024);
  expect(page.items.length).toBe(80);
  expect(page.verifiedInputIds).toContain("old-user");
  expect(page.items.some((item) => item.kind === "user")).toBe(false);
  const header = { ...page, items: [], before: undefined, start: 0, end: 0 };
  let items = page.items;
  let pages = 1;
  while (page.before) {
    const previousStart = page.start;
    page = ok(await f.view(page.before));
    expect(page.end).toBe(previousStart);
    expect({ ...page, items: [], before: undefined, start: 0, end: 0 }).toEqual(header);
    items = [...page.items, ...items];
    pages++;
  }
  expect(items.length).toBe(f.chat.items.length);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  const restored: unknown[] = [];
  for (const item of items) {
    const copy = withoutRefs(item) as Record<string, unknown>;
    if (item.kind === "tool") {
      expect(item.args).toBeUndefined();
      expect(item.result).toBeUndefined();
      expect(item.activityGroupKey).toBeTruthy();
      const detail = await f.detail(item.detailRef!);
      expect(detail.status).toBe("ok");
      if (detail.status !== "ok") throw new Error("Missing detail");
      expect(detail.complete).toBe(true);
      Object.assign(copy, JSON.parse(Buffer.from(detail.data, "base64").toString("utf8")));
    }
    restored.push(copy);
  }
  expect(restored).toEqual(f.chat.items);
  console.log(
    JSON.stringify({
      historyView: {
        sourceBodyBytes: 513 * 17_408,
        firstBytes,
        firstMs,
        pages,
        items: items.length,
        restoredHash: createHash("sha256").update(JSON.stringify(restored)).digest("hex"),
      },
    }),
  );
});

test("large UTF-8 details use bounded authenticated chunks and preserve missing args", async () => {
  const text = "汉字🙂".repeat(150_000);
  const f = fixture([
    input("user"),
    { type: "stream_request_start", turnNumber: 1 },
    { type: "text_delta", text },
    start("tool"),
    result("tool", text),
    end,
  ]);
  await f.select();
  const page = ok(await f.view());
  for (const item of page.items) {
    const ref =
      item.kind === "tool"
        ? item.detailRef
        : item.kind === "assistant"
          ? item.textDetailRef
          : undefined;
    if (!ref) continue;
    const buffers: Buffer[] = [];
    let cursor: string | undefined;
    do {
      const part = await f.detail(ref, cursor);
      expect(part.status).toBe("ok");
      if (part.status !== "ok") throw new Error("Missing part");
      expect(part.index).toBe(buffers.reduce((size, bytes) => size + bytes.length, 0));
      const bytes = Buffer.from(part.data, "base64");
      expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
      expect(Buffer.byteLength(JSON.stringify(f.replies.at(-1)))).toBeLessThan(1024 * 1024);
      buffers.push(bytes);
      cursor = part.complete ? undefined : part.next;
      if (!cursor) expect(Buffer.concat(buffers).length).toBe(part.totalBytes);
    } while (cursor);
    expect(buffers.length).toBeGreaterThan(4);
    const value: MobileHistoryDetail = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers)),
    );
    expect(item.kind === "tool" ? value.result : value.text).toBe(text);
    if (item.kind === "tool") expect(Object.hasOwn(value, "args")).toBe(false);
  }
});

test("same SID reselection, forged/foreign cursor and viewer cannot reuse a retired view", async () => {
  const f = fixture(simple());
  await f.select();
  const old = ok(await f.view());
  const ref = old.items.find((item) => item.kind === "tool")!.detailRef!;
  await f.select("recovery-new");
  expect((await f.detail(ref)).status).toBe("incomplete");
  expect((await f.detail(ref, undefined, "recovery-new")).status).toBe("incomplete");
  const current = ok(await f.view(undefined, "recovery-new"));
  expect(current.viewId).not.toBe(old.viewId);
  await f.select("recovery", "other");
  expect(
    (
      await f.detail(
        current.items.find((item) => item.kind === "tool")!.detailRef!,
        undefined,
        "recovery",
        "other",
      )
    ).status,
  ).toBe("incomplete");
  expect((await f.view("forged.cursor", "recovery-new")).status).toBe("incomplete");
});

for (const mutation of [
  "ownerABA",
  "authority",
  "root",
  "auth",
  "epoch",
  "unpaired",
  "journal",
  "legacy",
] as const) {
  test(`cached details reject ${mutation} changes`, async () => {
    const f = fixture(simple());
    await f.select();
    const page = ok(await f.view());
    const ref = page.items.find((item) => item.kind === "tool")!.detailRef!;
    if (mutation === "ownerABA") f.state.revision += 2;
    if (mutation === "authority") f.state.authority = "new-authority";
    if (mutation === "root") f.state.root += "-unmounted";
    if (mutation === "auth") f.state.auth = false;
    if (mutation === "epoch") f.state.epoch = "new-snapshot-epoch";
    if (mutation === "unpaired")
      f.snapshots.append("history", { type: "text_delta", text: "unpaired" });
    if (mutation === "journal" || mutation === "legacy") {
      const path = join(
        f.root,
        "history",
        mutation === "journal" ? "output-journal.jsonl" : "transcript.jsonl",
      );
      const bytes = readFileSync(path, "utf8");
      writeFileSync(
        path,
        bytes.replace(
          mutation === "journal" ? "owned result" : "fixture",
          mutation === "journal" ? "wrong result" : "changed",
        ),
      );
    }
    expect((await f.detail(ref)).status).toBe("incomplete");
  });
}

test("unpaired coverage cannot become unsupported fallback", async () => {
  const f = fixture(simple());
  await f.select();
  f.snapshots.append("history", { type: "text_delta", text: "unpaired" });
  expect((await f.view()).status).toBe("incomplete");
});

test("active assistant, unfinished tool outside tail and orphan body require full verified fallback", () => {
  const filler = Array.from({ length: 81 }, (_, index) => ({
    kind: "system" as const,
    id: `s${index}`,
    text: "later",
  }));
  expect(() =>
    projectHistoryView(
      {
        ...initialChatState(),
        items: [
          { kind: "assistant", id: "active", text: "", reasoning: "", done: false },
          ...filler,
        ],
        liveByAgent: { main: "active" },
      },
      new Map(),
    ),
  ).toThrow(UnsupportedHistoryView);
  expect(() =>
    projectHistoryView(
      {
        ...initialChatState(),
        items: [{ kind: "tool", id: "active", name: "Read", done: false }, ...filler],
      },
      new Map(),
    ),
  ).toThrow(UnsupportedHistoryView);
  expect(() =>
    projectHistoryView(
      { ...initialChatState(), orphanResults: { missing: { result: "body" } } },
      new Map(),
    ),
  ).toThrow(UnsupportedHistoryView);
});

test("delayed authority cannot publish after selection revocation and permits bounded busy retry", async () => {
  const f = fixture(simple());
  await f.select();
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayed = false;
  f.state.beforeAuthority = async () => {
    if (!delayed) {
      delayed = true;
      entered();
      await gate;
    }
  };
  const first = f.view();
  await enteredPromise;
  await f.select("next");
  expect((await f.view(undefined, "next")).status).toBe("busy");
  release();
  expect((await first).status).toBe("incomplete");
  expect((await f.view(undefined, "next")).status).toBe("ok");
});

for (const events of [[], simple()]) {
  test(`native journal without a legacy cutover supports ${events.length ? "events" : "an empty new session"}`, async () => {
    const f = fixture(events, { noBase: true });
    await f.select();
    const page = ok(await f.view());
    expect(
      page.items
        .map(withoutRefs)
        .map((item: any) => ({ ...item, args: undefined, result: undefined })),
    ).toEqual(f.chat.items.map((item) => ({ ...item, args: undefined, result: undefined })));
  });
}
test("external producer-only journal retains explicit turn grouping", async () => {
  const f = fixture(simple(), { producer: true });
  await f.select();
  const page = ok(await f.view());
  expect(page.items.find((item) => item.kind === "tool")!.activityGroupKey).toBeTruthy();
});

test("final authorization await cannot conceal a source rewrite", async () => {
  const f = fixture(simple());
  await f.select();
  let checks = 0;
  f.state.beforeAuthority = async () => {
    if (++checks === 3) {
      const path = join(f.root, "history", "output-journal.jsonl");
      writeFileSync(path, readFileSync(path, "utf8").replace("owned result", "wrong result"));
    }
  };
  expect((await f.view()).status).toBe("incomplete");
  expect(checks).toBeGreaterThanOrEqual(3);
});

test("an owner ABA during awaited authorization cannot publish a candidate", async () => {
  const f = fixture(simple());
  await f.select();
  f.state.beforeAuthority = async () => {
    f.state.owner = 2;
    f.state.revision++;
    await Promise.resolve();
    f.state.owner = 1;
    f.state.revision++;
  };
  expect((await f.view()).status).toBe("incomplete");
});

test("frozen earlier pages retain original control proof after legitimate appended live output", async () => {
  const events: StreamEvent[] = [];
  for (let i = 0; i < 90; i++) events.push(input(`input-${i}`));
  events.push(end);
  const f = fixture(events);
  await f.select();
  const first = ok(await f.view());
  const cursor = f.writer.append(input("new-live-input"));
  f.snapshots.append("history", { ...input("new-live-input"), outputCursor: cursor });
  const older = ok(await f.view(first.before));
  expect(older.snapshot).toEqual(first.snapshot);
  expect(older.verifiedInputIds).toEqual(first.verifiedInputIds);
  expect(older.state).toEqual(first.state);
  expect(older.through).toBe(first.through);
  const fresh = ok(await f.view());
  expect(fresh.verifiedInputIds).toContain("new-live-input");
  expect(fresh.through).toBe(cursor);
});

test("eight shared read slots are bounded; revoked requests never become successful busy fallback", async () => {
  const f = fixture(simple());
  const refs: string[] = [];
  for (let i = 0; i < 8; i++) {
    await f.select("recovery", `v${i}`);
    refs.push(
      ok(await f.view(undefined, "recovery", `v${i}`)).items.find((item) => item.kind === "tool")!
        .detailRef!,
    );
  }
  await f.select("recovery", "ninth");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.beforeAuthority = async () => {
    await gate;
  };
  const pending = refs.map((ref, i) => f.detail(ref, undefined, "recovery", `v${i}`));
  await Promise.resolve();
  expect((await f.view(undefined, "recovery", "ninth")).status).toBe("busy");
  f.service.revoke("ninth");
  expect((await f.view(undefined, "recovery", "ninth")).status).toBe("incomplete");
  release();
  expect((await Promise.all(pending)).every((result) => result.status === "ok")).toBe(true);
});

test("LRU eviction retires old opaque references and a new view restores details", async () => {
  const f = fixture(simple());
  let firstRef = "";
  for (let i = 0; i < 9; i++) {
    await f.select("recovery", `v${i}`);
    const page = ok(await f.view(undefined, "recovery", `v${i}`));
    if (!i) firstRef = page.items.find((item) => item.kind === "tool")!.detailRef!;
  }
  expect((await f.detail(firstRef, undefined, "recovery", "v0")).status).toBe("incomplete");
  const current = ok(await f.view(undefined, "recovery", "v0"));
  const currentRef = current.items.find((item) => item.kind === "tool")!.detailRef!;
  expect(currentRef).not.toBe(firstRef);
  expect((await f.detail(currentRef, undefined, "recovery", "v0")).status).toBe("ok");
});

test("ambiguous item IDs and serialized views over the 32 MiB budget are unsupported", () => {
  const item = { kind: "system" as const, id: "same", text: "owned" };
  expect(() =>
    projectHistoryView({ ...initialChatState(), items: [item, item] }, new Map()),
  ).toThrow(UnsupportedHistoryView);
  expect(() =>
    projectHistoryView(
      {
        ...initialChatState(),
        items: [
          {
            kind: "tool",
            id: "big",
            name: "Read",
            done: true,
            result: "x".repeat(32 * 1024 * 1024),
          },
        ],
      },
      new Map(),
    ),
  ).toThrow(UnsupportedHistoryView);
});

test("missing visible input receipt cannot pass the full snapshot coverage join", async () => {
  const f = fixture(simple());
  await f.select();
  f.snapshots.append("history", { ...input("not-in-journal"), outputCursor: f.outputCursor });
  expect((await f.view()).status).toBe("incomplete");
});

test("actual Main dispatcher awaits read-only lazy history routes without launching work", async () => {
  const { handleClientEvent } = await import("./handle-client-event.js");
  const f = fixture(simple());
  await f.select();
  const ctx = { outputRecovery: f.service } as import("./handle-client-event.js").OrchestratorCtx;
  await handleClientEvent(ctx, {
    type: "session.historyView",
    sessionId: "history",
    recoveryId: "recovery",
    requestId: "view",
    viewerId: "viewer",
    deviceId: "device",
  });
  const reply = f.replies.at(-1)!;
  expect(reply.type).toBe("session.historyView");
  if (reply.type !== "session.historyView") throw new Error("Missing view");
  const view = ok(reply.result);
  const ref = view.items.find((item) => item.kind === "tool")!.detailRef!;
  await handleClientEvent(ctx, {
    type: "session.historyDetail",
    sessionId: "history",
    recoveryId: "recovery",
    requestId: "detail",
    ref,
    viewerId: "viewer",
    deviceId: "device",
  });
  expect(f.replies.at(-1)).toMatchObject({
    type: "session.historyDetail",
    result: { status: "ok", complete: true },
  });
});

test("aggregate 64 MiB budget evicts a view before the eight-view count limit", async () => {
  const body = "x".repeat(8 * 1024 * 1024);
  const f = fixture([
    input("user"),
    { type: "stream_request_start", turnNumber: 1 },
    start("one"),
    result("one", body),
    start("two"),
    result("two", body),
    end,
  ]);
  let firstRef = "";
  for (let i = 0; i < 4; i++) {
    await f.select("recovery", `v${i}`);
    const page = ok(await f.view(undefined, "recovery", `v${i}`));
    if (!i) firstRef = page.items.find((item) => item.kind === "tool")!.detailRef!;
  }
  expect((await f.detail(firstRef, undefined, "recovery", "v0")).status).toBe("incomplete");
});

test("legacy raw prefix remains verified for every large-detail part", async () => {
  const legacyText = "z".repeat(8 * 1024 * 1024);
  const detailText = "汉🙂".repeat(160_000);
  const f = fixture([start("tool"), result("tool", detailText), end], { legacyText });
  await f.select();
  const page = ok(await f.view());
  const ref = page.items.find((item) => item.kind === "tool")!.detailRef!;
  const started = performance.now();
  const chunks: Buffer[] = [];
  let cursor: string | undefined;
  do {
    const part = await f.detail(ref, cursor);
    expect(part.status).toBe("ok");
    if (part.status !== "ok") throw new Error("Missing legacy detail");
    chunks.push(Buffer.from(part.data, "base64"));
    cursor = part.complete ? undefined : part.next;
  } while (cursor);
  expect(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))).result,
  ).toBe(detailText);
  const elapsedMs = performance.now() - started;
  console.log(
    JSON.stringify({
      legacyDetail: {
        prefixBytes: Buffer.byteLength(legacyText),
        detailBytes: Buffer.concat(chunks).length,
        pages: chunks.length,
        elapsedMs,
      },
    }),
  );
  const file = join(f.root, "history", "transcript.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").replace("zzzz", "yyyy"));
  expect((await f.detail(ref)).status).toBe("incomplete");
});

test("active tool and assistant bodies stay inline for subsequent live deltas", () => {
  const text = "x".repeat(10_000);
  const assistant = {
    kind: "assistant" as const,
    id: "active",
    text,
    reasoning: text,
    done: false,
  };
  const tool = {
    kind: "tool" as const,
    id: "tool",
    name: "Read",
    args: { text },
    result: text,
    done: false,
  };
  const view = projectHistoryView(
    { ...initialChatState(), items: [assistant, tool], liveByAgent: { main: "active" } },
    new Map([["tool", "same-turn"]]),
  );
  expect(view.items).toEqual([assistant, tool]);
  expect(view.details.size).toBe(0);
});

test("final outer authorization fence rejects a changed scope before dispatching verified data", async () => {
  const f = fixture(simple());
  await f.select();
  let checks = 0;
  f.state.beforeAuthority = async () => {
    // Initial read, projection, source verification, then the outer reply fence.
    if (++checks === 4) f.state.authority = "unmounted-root";
  };
  expect((await f.view()).status).toBe("incomplete");
  expect(checks).toBeGreaterThanOrEqual(4);
});
