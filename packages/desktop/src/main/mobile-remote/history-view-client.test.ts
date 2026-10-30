import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  SessionManager,
  type MobileClientEvent,
  type MobileServerEvent,
  type StreamEvent,
} from "@cjhyy/code-shell-core";
import { SessionOutputJournal, SessionOutputCoverageStore } from "@cjhyy/code-shell-core/internal";
import { initialChatState, reduceStream, transcriptToStreamEvents } from "@cjhyy/code-shell-web";
import { MobileOutputClient } from "../../../../web/src/hooks/mobileOutputClient.js";
import { SessionSnapshotStore } from "../SessionSnapshotStore.js";
import { MobileOutputRecovery } from "./output-recovery.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 12_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("History fixture did not settle within its bound");
    await sleep(10);
  }
}
function fixture(delayMs = 40, toolCount = 0) {
  const root = mkdtempSync(join(tmpdir(), "mobile-history-client-")),
    id = "history";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", id);
  manager.startSessionRun(session.state, "run");
  const writer = new SessionOutputJournal(
    root,
    id,
    "run",
    session.transcript.getEvents().at(-1)!.id,
  );
  const snapshots = new SessionSnapshotStore({
    coverage: new SessionOutputCoverageStore(() => root),
  });
  let expected = initialChatState(),
    cursor = "",
    active = true,
    writing = false;
  for (const event of transcriptToStreamEvents(session.transcript.getEvents()))
    expected = reduceStream(expected, event);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms = delayMs) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (active) fn();
    }, ms);
    timers.add(timer);
  };
  const append = (events: StreamEvent[], notify = true) => {
    const cursors = writer.appendBatch(events);
    events.forEach((event, index) => {
      cursor = cursors[index];
      snapshots.append(id, { ...event, outputCursor: cursor });
      expected = reduceStream(expected, event);
    });
    if (notify) {
      // The actual Main pointer is the path used for coalesced large output.
      // It reveals no raw text and requires the client to read the real journal.
      const wire = JSON.stringify({ sessionId: id, outputCursor: snapshots.get(id)!.outputCursor });
      later(() => {
        const value = JSON.parse(wire);
        client.advanceSnapshot(value.sessionId, value.outputCursor);
      });
    }
    return cursor;
  };
  const seed: StreamEvent[] = [
    { type: "session_user_message", text: "fixture", clientMessageId: "input" },
    { type: "stream_request_start", turnNumber: 1 },
  ];
  for (let i = 0; i < toolCount; i++)
    seed.push(
      {
        type: "tool_use_start",
        toolCall: { id: `tool-${i}`, toolName: "Read", args: { index: i } },
      },
      { type: "tool_result", result: { id: `tool-${i}`, result: "x".repeat(16_384) } },
    );
  seed.push(
    { type: "turn_complete", reason: "completed" },
    { type: "stream_request_start", turnNumber: 2 },
    { type: "text_delta", text: "start" },
  );
  for (let offset = 0; offset < seed.length; offset += 16)
    append(seed.slice(offset, offset + 16), false);
  const commits: Array<{ result: any; at: number; writing: boolean }> = [],
    sent: MobileClientEvent[] = [],
    responses: MobileServerEvent[] = [],
    errors: unknown[] = [];
  let failures = 0,
    transform: ((event: MobileServerEvent) => MobileServerEvent) | undefined;
  const host = new MobileOutputRecovery({
    root: () => root,
    authority: async () => {
      await sleep(5);
      return "mounted-fixture";
    },
    snapshot: (sessionId) => snapshots.get(sessionId),
    owner: () => 1,
    ownerRevision: () => 1,
    authenticated: () => true,
    journalRequired: () => true,
    reply: (_viewer, event) => {
      const response = transform?.(event) ?? event;
      responses.push(response);
      const wire = JSON.stringify(response);
      later(() => client.observe(JSON.parse(wire)));
    },
  });
  const client = new MobileOutputClient({
    current: () => ({ sessionId: id, revision: 1 }),
    send: (event) => {
      sent.push(event);
      const wire = JSON.stringify(event);
      later(() => {
        void host
          .handle({ ...JSON.parse(wire), viewerId: "viewer", deviceId: "device" })
          .catch((error) => errors.push(error));
      });
      return true;
    },
    commit: (_sessionId, result) => commits.push({ result, at: performance.now(), writing }),
    failed: () => failures++,
    legacy: () => errors.push(new Error("Unexpected fallback")),
  });
  cleanup.push(() => {
    active = false;
    client.cancel(false);
    host.revoke("viewer");
    for (const timer of timers) clearTimeout(timer);
  });
  client.observe({
    type: "auth.ok",
    device: { id: "device", name: "fixture" },
    capabilities: { outputJournal: 1, outputJournalPageFrames: 2048, historyView: 1 },
  });
  return {
    root,
    id,
    client,
    append,
    commits,
    sent,
    responses,
    errors,
    failures: () => failures,
    expected: () => expected,
    cursor: () => cursor,
    writing: (value: boolean) => {
      writing = value;
    },
    transform: (value: typeof transform) => {
      transform = value;
    },
  };
}
const text = (chat: ReturnType<typeof initialChatState>) =>
  chat.items
    .filter((item) => item.kind === "assistant")
    .map((item) => item.text)
    .join("");

test("a frozen view ending at a tool boundary joins later text as a fresh segment and retains tombstone ownership", async () => {
  const f = fixture(5),
    body = "Owned paragraph.\n\n" + "long retained text ".repeat(400);
  f.append(
    [
      { type: "turn_complete", reason: "completed" },
      { type: "stream_request_start", turnNumber: 3, messageId: "owned-request" },
      { type: "text_delta", text: body },
      { type: "tool_use_start", toolCall: { id: "boundary-tool", toolName: "Bash", args: {} } },
    ],
    false,
  );
  f.client.begin(f.id);
  await until(() => f.commits.length === 1 || f.failures() > 0);
  expect(f.failures()).toBe(0);
  const prefix = f.commits[0].result.chat;
  const before = prefix.items.find(
    (item: any) => item.kind === "assistant" && item.messageId === "owned-request",
  );
  expect(before.done).toBe(true);
  expect(before.textDetailRef).toBeString();
  expect(prefix.liveByAgent[""]).toBe(before.id);
  expect((await f.client.loadDetail(before.textDetailRef)).text).toBe(body);
  f.append([
    { type: "tool_result", result: { id: "boundary-tool", result: "done" } },
    { type: "text_delta", text: "Final first.\n\nFinal second." },
  ]);
  await until(() => f.commits.at(-1)?.result.outputCursor === f.cursor() || f.failures() > 0);
  expect(f.failures()).toBe(0);
  const joined = f.commits.at(-1)!.result.chat;
  expect(joined.items.at(-1)).toMatchObject({
    kind: "assistant",
    messageId: "owned-request",
    text: "Final first.\n\nFinal second.",
    done: false,
  });
  expect(joined.items.at(-2)).toMatchObject({ kind: "tool", id: "boundary-tool", done: true });
  expect(joined.items.find((item: any) => item.id === before.id)).toEqual(before);
  expect(joined.seq).toBe(prefix.seq + 1);
  expect(joined.run).toBe("running");
  expect(f.sent.filter((event) => event.type === "session.historyView")).toHaveLength(1);
  f.append([{ type: "tombstone", messageId: "owned-request" }]);
  await until(() => f.commits.at(-1)?.result.outputCursor === f.cursor() || f.failures() > 0);
  expect(f.failures()).toBe(0);
  expect(
    f.commits.at(-1)!.result.chat.items.some((item: any) => item.messageId === "owned-request"),
  ).toBe(false);
  expect(f.commits.at(-1)!.result.chat.items.some((item: any) => item.id === "boundary-tool")).toBe(
    true,
  );
  expect(
    f.sent.some((event) => event.type === "chat.send" || event.type === "approval.respond"),
  ).toBe(false);
  expect(f.errors).toEqual([]);
});

test("real Host + JSON + client: 8.5 MiB history becomes visible while a writer continues across delayed round trips", async () => {
  const f = fixture(250, 513),
    started = performance.now();
  f.writing(true);
  let ticks = 0;
  const interval = setInterval(() => f.append([{ type: "text_delta", text: `|${++ticks}` }]), 50);
  cleanup.push(() => clearInterval(interval));
  f.client.begin(f.id);
  await until(() => f.commits.length >= 4 || f.failures() > 0);
  expect(f.failures()).toBe(0);
  expect(f.errors).toEqual([]);
  expect(
    f.commits.slice(0, 4).every((commit) => commit.writing && commit.result.chat.run === "running"),
  ).toBe(true);
  expect(f.sent.filter((event) => event.type === "session.historyView")).toHaveLength(1);
  expect(f.sent.filter((event) => event.type === "session.select")).toHaveLength(1);
  expect(ticks).toBeGreaterThan(20);
  clearInterval(interval);
  f.writing(false);
  f.append([{ type: "turn_complete", reason: "completed" }]);
  await until(() => f.commits.at(-1)?.result.outputCursor === f.cursor() || f.failures() > 0);
  expect(f.failures()).toBe(0);
  expect(text(f.commits.at(-1)!.result.chat)).toBe(text(f.expected()));
  expect(f.commits.at(-1)!.result.chat.run).toBe("completed");
  expect(
    f.sent.some((event) => event.type === "chat.send" || event.type === "approval.respond"),
  ).toBe(false);
  const view = f.responses.find((event) => event.type === "session.historyView")!;
  const firstBytes = Buffer.byteLength(JSON.stringify(view));
  expect(firstBytes).toBeLessThan(32 * 1024);
  console.log(
    JSON.stringify({
      continuousHistory: {
        journalBytes: statSync(join(f.root, f.id, "output-journal.jsonl")).size,
        firstBytes,
        firstVisibleMs: f.commits[0].at - started,
        syntheticRoundTripMs: 500,
        writerIntervalMs: 50,
        ticks,
        commits: f.commits.length,
        finalTextHash: createHash("sha256").update(text(f.expected())).digest("hex"),
      },
    }),
  );
});

test("coalesced updates to an old deferred tool retire its refs and rebuild a verified view", async () => {
  const f = fixture(5, 1);
  f.client.begin(f.id);
  await until(() => f.commits.length === 1);
  const old = f.commits[0].result.chat.items.find((item: any) => item.kind === "tool").detailRef;
  f.append([{ type: "tool_result", result: { id: "tool-0", result: "updated" } }]);
  await until(() => f.commits.length === 2 || f.failures() > 0);
  expect(f.failures()).toBe(0);
  expect(f.sent.filter((event) => event.type === "session.historyView")).toHaveLength(2);
  await expect(f.client.loadDetail(old)).rejects.toThrow();
  const next = f.commits[1].result.chat.items.find((item: any) => item.kind === "tool").detailRef;
  expect((await f.client.loadDetail(next)).result).toBe("updated");
});

test("an unpaired suffix preserves the last verified display and fails without a partial commit", async () => {
  const f = fixture(5);
  f.client.begin(f.id);
  await until(() => f.commits.length === 1);
  f.transform((event) =>
    event.type === "session.outputJournal" && event.snapshot
      ? { ...event, snapshot: { ...event.snapshot, unpaired: true } }
      : event,
  );
  f.append([{ type: "text_delta", text: "must stay private" }]);
  await until(() => f.failures() === 1);
  expect(f.commits).toHaveLength(1);
  expect(text(f.commits[0].result.chat)).toBe("start");
});

test("a multi-page fragmented suffix joins its first actual snapshot while later output advances", async () => {
  const f = fixture(5);
  f.client.begin(f.id);
  await until(() => f.commits.length === 1);
  let advanced = false;
  f.transform((event) => {
    if (event.type === "session.outputJournal" && !event.page.complete && !advanced) {
      advanced = true;
      f.append([{ type: "text_delta", text: "|later-head" }]);
    }
    return event;
  });
  f.append([{ type: "text_delta", text: "汉🙂".repeat(180_000) }]);
  await until(() => f.commits.at(-1)?.result.outputCursor === f.cursor() || f.failures() > 0);
  expect(f.failures()).toBe(0);
  expect(advanced).toBe(true);
  expect(f.commits.length).toBeGreaterThanOrEqual(3);
  expect(text(f.commits.at(-1)!.result.chat)).toBe(text(f.expected()));
  expect(f.sent.filter((event) => event.type === "session.historyView")).toHaveLength(1);
  expect(
    f.sent
      .filter((event) => event.type === "session.outputJournal")
      .every((event) => event.frozenSnapshot === true),
  ).toBe(true);
});

test("a damaged later suffix page never publishes a partial large event", async () => {
  const f = fixture(5);
  f.client.begin(f.id);
  await until(() => f.commits.length === 1);
  let pages = 0;
  f.transform((event) =>
    event.type === "session.outputJournal" && ++pages === 2
      ? { ...event, page: { ...event.page, status: "incomplete", complete: false } }
      : event,
  );
  f.append([{ type: "text_delta", text: "汉🙂".repeat(180_000) }]);
  await until(() => f.failures() === 1);
  expect(pages).toBe(2);
  expect(f.commits).toHaveLength(1);
  expect(text(f.commits[0].result.chat)).toBe("start");
});

test("multipart details yield between chunks so live output advances before the detail finishes", async () => {
  const f = fixture(5, 1),
    body = "汉🙂".repeat(180_000);
  f.append([{ type: "tool_result", result: { id: "tool-0", result: body } }], false);
  f.client.begin(f.id);
  await until(() => f.commits.length === 1);
  const ref = f.commits[0].result.chat.items.find((item: any) => item.kind === "tool").detailRef;
  let parts = 0,
    commitsBeforeLastPart = 0;
  f.transform((event) => {
    if (event.type === "session.historyDetail" && event.result.status === "ok") {
      parts++;
      if (!event.result.complete) f.append([{ type: "text_delta", text: `|detail-part-${parts}` }]);
      else commitsBeforeLastPart = f.commits.length;
    }
    return event;
  });
  const detail = await f.client.loadDetail(ref);
  expect(parts).toBeGreaterThan(4);
  const detailPositions = f.sent.flatMap((event, index) =>
    event.type === "session.historyDetail" ? [index] : [],
  );
  expect(
    f.sent
      .slice(detailPositions[0] + 1, detailPositions[1])
      .some((event) => event.type === "session.outputJournal"),
  ).toBe(true);
  expect(commitsBeforeLastPart).toBeGreaterThan(1);
  expect(createHash("sha256").update(detail.result!).digest("hex")).toBe(
    createHash("sha256").update(body).digest("hex"),
  );
  expect(f.failures()).toBe(0);
  expect(text(f.commits.at(-1)!.result.chat)).toBe(text(f.expected()));
  expect(f.sent.filter((event) => event.type === "session.historyView")).toHaveLength(1);
});

test("a coalesced tool change between detail chunks cancels the old body before a new view is shown", async () => {
  const f = fixture(5, 1);
  f.append(
    [{ type: "tool_result", result: { id: "tool-0", result: "x".repeat(1_200_000) } }],
    false,
  );
  f.client.begin(f.id);
  await until(() => f.commits.length === 1);
  const ref = f.commits[0].result.chat.items.find((item: any) => item.kind === "tool").detailRef;
  let changed = false;
  f.transform((event) => {
    if (event.type === "session.historyDetail" && event.result.status === "ok" && !changed) {
      changed = true;
      f.append([{ type: "tool_result", result: { id: "tool-0", result: "new result" } }]);
    }
    return event;
  });
  await expect(f.client.loadDetail(ref)).rejects.toThrow();
  await until(() => f.commits.length === 2 || f.failures() > 0);
  expect(f.failures()).toBe(0);
  expect(
    f.sent.filter((event) => event.type === "session.historyDetail" && event.ref === ref),
  ).toHaveLength(1);
  const next = f.commits[1].result.chat.items.find((item: any) => item.kind === "tool").detailRef;
  expect(next).not.toBe(ref);
  expect((await f.client.loadDetail(next)).result).toBe("new result");
});
