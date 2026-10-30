import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type MobileServerEvent } from "@cjhyy/code-shell-core";
import { SessionSnapshotStore } from "../SessionSnapshotStore.js";
import { MobileOutputRecovery } from "./output-recovery.js";
import { MobileOutputClient } from "../../../../web/src/hooks/mobileOutputClient.js";
import { initialChatState, reduceStream } from "../../../../web/src/lib/streamReducer.js";
import {
  isUntouchedLegacySnapshot,
  LegacyHistoryUnavailable,
  readLegacyExternalHistory,
} from "./legacy-transcript-history.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "legacy-external-"));
  roots.push(root);
  const manager = new SessionManager(root);
  const session = manager.create(root, "claude-code/fixture", "claude-code", "legacy");
  session.transcript.appendMessage("user", "owned prompt");
  session.transcript.appendMessage("assistant", "owned saved answer");
  const directory = join(root, "legacy"),
    statePath = join(directory, "state.json"),
    transcript = join(directory, "transcript.jsonl");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const patch = (change: Record<string, unknown>) =>
    writeFileSync(statePath, JSON.stringify({ ...state, status: "completed", ...change }));
  patch({});
  const snapshots = new SessionSnapshotStore();
  let authority = "selected-physical-project",
    ownerRevision = 1;
  let resolveAuthority = async () => authority;
  const replies: MobileServerEvent[] = [];
  let onReply: ((event: MobileServerEvent) => void) | undefined;
  const host = new MobileOutputRecovery({
    root: () => root,
    authority: () => resolveAuthority(),
    journalRequired: () => true,
    owner: () => 1,
    ownerRevision: () => ownerRevision,
    authenticated: () => true,
    snapshot: (sid) => snapshots.get(sid),
    reply: (_viewer, event) => {
      replies.push(event);
      onReply?.(event);
    },
  });
  const event = { sessionId: "legacy", viewerId: "viewer", deviceId: "device" };
  return {
    root,
    directory,
    statePath,
    transcript,
    patch,
    snapshots,
    replies,
    host,
    onReply: (fn: typeof onReply) => {
      onReply = fn;
    },
    authority: (value: string) => {
      authority = value;
    },
    ownerChanged: () => {
      ownerRevision++;
    },
    resolveAuthority: (value: typeof resolveAuthority) => {
      resolveAuthority = value;
    },
    select: () => host.handle({ ...event, type: "session.select", recoveryId: "recovery" }),
    read: () => host.handle({ ...event, type: "session.history" }),
  };
}

test("pre-journal legacy display is complete, bounded, immutable and never persisted as a new journal", async () => {
  const f = fixture(),
    source = readFileSync(f.transcript),
    state = readFileSync(f.statePath);
  expect(
    readLegacyExternalHistory(f.root, "legacy")?.events.some(
      (event) => event.text === "owned saved answer",
    ),
  ).toBe(true);
  expect(await f.select()).toBe(true);
  expect(f.replies.at(-1)).toMatchObject({ type: "session.recovery.ready", ok: true });
  expect(f.replies.at(-1)).not.toHaveProperty("journalRequired");
  expect(await f.read()).toBe(false);
  expect(f.replies.at(-1)).toMatchObject({ type: "session.history.ok", sessionId: "legacy" });
  expect(readFileSync(f.transcript).equals(source)).toBe(true);
  expect(readFileSync(f.statePath).equals(state)).toBe(true);
});

test.each([false, true])(
  "real Host JSON client reads a 4 MiB legacy transcript atomically in bounded pages (source changes=%s)",
  async (changes) => {
    const f = fixture();
    const body = "中🙂".repeat(1500);
    appendFileSync(
      f.transcript,
      Array.from({ length: 400 }, (_, index) =>
        JSON.stringify({
          id: `large-${index}`,
          type: "message",
          data: { role: "assistant", content: body },
        }),
      ).join("\n") + "\n",
    );
    expect(readFileSync(f.transcript).length).toBeGreaterThan(4 * 1024 * 1024);
    let received: Record<string, unknown>[] | undefined,
      failures = 0,
      pages = 0;
    const client = new MobileOutputClient({
      current: () => ({ sessionId: "legacy", revision: 1 }),
      send: (event) => {
        queueMicrotask(() => {
          void f.host.handle({
            ...JSON.parse(JSON.stringify(event)),
            viewerId: "viewer",
            deviceId: "device",
          });
        });
        return true;
      },
      commit: () => {
        throw new Error("Legacy display must not invent a journal commit");
      },
      legacy: (_id, events) => {
        received = events;
      },
      failed: () => {
        failures++;
      },
    });
    f.onReply((event) => {
      const wire = JSON.stringify(event);
      expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(1024 * 1024);
      if (event.type === "session.legacyBase" && event.ok) {
        pages++;
        expect(received).toBeUndefined();
        if (changes && pages === 1)
          appendFileSync(
            f.transcript,
            JSON.stringify({
              id: "new-tail",
              type: "message",
              data: { role: "assistant", content: "changed" },
            }) + "\n",
          );
      }
      queueMicrotask(() => client.observe(JSON.parse(wire)));
    });
    try {
      client.observe({
        type: "auth.ok",
        capabilities: { outputJournal: 1, legacyBasePages: 1, historyView: 1 },
      } as MobileServerEvent);
      client.begin("legacy");
      const deadline = Date.now() + 10000;
      while (!received && !failures) {
        if (Date.now() > deadline) throw new Error("Bounded legacy pages did not settle");
        await new Promise((done) => setTimeout(done, 5));
      }
      expect(failures).toBe(changes ? 1 : 0);
      if (changes) expect(received).toBeUndefined();
      else {
        expect(pages).toBeGreaterThan(4);
        const chat = received!.reduce(
          (value, event) => reduceStream(value, event),
          initialChatState(),
        );
        expect(
          chat.items
            .filter((item) => item.kind === "assistant")
            .map((item) => item.text)
            .join(""),
        ).toBe("owned saved answer" + body.repeat(400));
      }
    } finally {
      client.cancel(false);
      f.host.revoke("viewer");
    }
  },
);

test.each([
  "outputCoverage",
  "outputJournalBinding",
  "outputJournalIdentity",
  "outputHistoryRecovery",
])("a missing modern journal never becomes a legacy success (%s)", async (key) => {
  const f = fixture();
  f.patch({ [key]: {} });
  expect(readLegacyExternalHistory(f.root, "legacy")).toBeUndefined();
  await f.select();
  expect(f.replies.at(-1)).toMatchObject({
    type: "session.recovery.ready",
    ok: true,
    journalRequired: true,
  });
  expect(await f.read()).toBe(true);
  expect(f.replies.some((event) => event.type === "session.history.ok")).toBe(false);
});

test.each(["truncated", "malformed", "oversized", "unknown", "payload"])(
  "unusable old transcripts fail immediately instead of awaiting an impossible journal (%s)",
  async (kind) => {
    const f = fixture();
    if (kind === "truncated")
      writeFileSync(f.transcript, readFileSync(f.transcript).subarray(0, -1));
    if (kind === "malformed") appendFileSync(f.transcript, "not-json\n");
    if (kind === "oversized") appendFileSync(f.transcript, "x".repeat(32 * 1024 * 1024));
    if (kind === "payload")
      appendFileSync(
        f.transcript,
        JSON.stringify({ id: "bad", type: "message", data: { role: "assistant", content: 42 } }) +
          "\n",
      );
    if (kind === "unknown")
      appendFileSync(
        f.transcript,
        JSON.stringify({ id: "unknown", type: "approval", data: {} }) + "\n",
      );
    expect(() => readLegacyExternalHistory(f.root, "legacy")).toThrow(LegacyHistoryUnavailable);
    expect(await f.select()).toBe(false);
    expect(f.replies.at(-1)).toMatchObject({ type: "session.recovery.ready", ok: false });
  },
);

test.each(["authority", "owner", "transcript", "journal", "live"])(
  "legacy selection is revoked when its read proof changes (%s)",
  async (change) => {
    const f = fixture();
    await f.select();
    if (change === "authority") f.authority("different-project");
    if (change === "owner") f.ownerChanged();
    if (change === "transcript")
      appendFileSync(
        f.transcript,
        JSON.stringify({
          id: "late",
          type: "message",
          data: { role: "assistant", content: "late output" },
        }) + "\n",
      );
    if (change === "journal") writeFileSync(join(f.directory, "output-journal.jsonl"), "broken");
    if (change === "live") f.snapshots.append("legacy", { type: "text_delta", text: "live" });
    await f.read();
    expect(f.replies.at(-1)).toMatchObject({ type: "session.recovery.ready", ok: false });
    expect(f.replies.some((event) => event.type === "session.history.ok")).toBe(false);
  },
);

test("a selection revoked across the asynchronous authority check cannot leak its legacy display", async () => {
  const f = fixture();
  await f.select();
  let release!: (value: string) => void;
  f.resolveAuthority(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.read();
  f.host.revoke("viewer");
  release("selected-physical-project");
  await pending;
  expect(f.replies.some((event) => event.type === "session.history.ok")).toBe(false);
});

test("legacy read rejects symlinks and never accepts a nonempty live snapshot", () => {
  const f = fixture();
  renameSync(f.transcript, f.transcript + ".original");
  symlinkSync(f.transcript + ".original", f.transcript);
  expect(() => readLegacyExternalHistory(f.root, "legacy")).toThrow();
  const empty = f.snapshots.get("legacy");
  expect(isUntouchedLegacySnapshot(empty)).toBe(true);
  for (const patch of [
    { outputUnpaired: true },
    { outputInputIds: ["pending"] },
    { outputJournalIdentity: "journal" },
    { topLevelRunning: true },
    { nextSeq: 2 },
  ])
    expect(isUntouchedLegacySnapshot({ ...empty, ...patch })).toBe(false);
});

test("older same-Session metadata updates, empty tool receipts and child descriptions preserve their display", () => {
  const f = fixture();
  appendFileSync(
    f.transcript,
    [
      { id: "meta-resume", type: "session_meta", data: { sessionId: "legacy" } },
      {
        id: "tool",
        type: "tool_use",
        data: { toolCallId: "empty-tool", toolName: "Read", args: {} },
      },
      { id: "receipt", type: "tool_result", data: { toolCallId: "empty-tool", toolName: "Read" } },
      {
        id: "child",
        type: "subagent",
        data: { agentId: "owned-child", description: "saved child description" },
      },
      {
        id: "answer",
        type: "message",
        data: { role: "assistant", content: "answer after resume" },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const events = readLegacyExternalHistory(f.root, "legacy")!.events;
  expect(events.filter((event) => event.type === "session_started")).toHaveLength(1);
  expect(events.filter((event) => event.type === "text_delta").map((event) => event.text)).toEqual([
    "owned saved answer",
    "answer after resume",
  ]);
  expect(events.find((event) => event.type === "tool_result")).toMatchObject({
    result: { id: "empty-tool", result: "" },
  });
  expect(events.find((event) => event.type === "agent_start")).toMatchObject({
    agentId: "owned-child",
    description: "saved child description",
  });
  appendFileSync(
    f.transcript,
    JSON.stringify({ id: "wrong-meta", type: "session_meta", data: { sessionId: "other" } }) + "\n",
  );
  expect(() => readLegacyExternalHistory(f.root, "legacy")).toThrow(LegacyHistoryUnavailable);
});

test("model-error history remains a read-only historical projection and active legacy metadata is terminally refused", async () => {
  const f = fixture();
  f.patch({ status: "model_error" });
  expect(
    readLegacyExternalHistory(f.root, "legacy")!.events.some(
      (event) => event.text === "owned saved answer",
    ),
  ).toBe(true);
  expect(JSON.parse(readFileSync(f.statePath, "utf8")).status).toBe("model_error");
  f.patch({ status: "active" });
  expect(await f.select()).toBe(false);
  expect(f.replies.at(-1)).toMatchObject({ type: "session.recovery.ready", ok: false });
});
