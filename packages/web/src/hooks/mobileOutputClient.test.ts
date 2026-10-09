import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../core/src/session/session-manager.js";
import {
  SessionOutputJournal,
  readOutputJournal,
} from "../../../core/src/session/output-journal.js";
import { transcriptToStreamEvents } from "../lib/transcriptReplay.js";
import { MobileOutputClient } from "./mobileOutputClient.js";
import type { MobileClientEvent, MobileServerEvent } from "@cjhyy/code-shell-core";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture(id = "external", pendingJournal = false) {
  const root = mkdtempSync(join(tmpdir(), "mobile-pointer-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const manager = new SessionManager(root);
  const session = manager.create(root, "fixture", "fixture", id);
  manager.startSessionRun(session.state, "run");
  const baseId = session.transcript.getEvents().at(-1)!.id;
  const legacyEvents = transcriptToStreamEvents(session.transcript.getEvents());
  let writer: SessionOutputJournal;
  let cursor: string;
  const openJournal = () => {
    writer = new SessionOutputJournal(root, id, "run", baseId);
    cursor = writer.append({ type: "stream_request_start", turnNumber: 1 });
    cursor = writer.append({ type: "text_delta", text: "first" });
  };
  if (!pendingJournal) openJournal();
  const sent: MobileClientEvent[] = [],
    commits: string[] = [];
  let failures = 0,
    pageCount = 0;
  let beforePageReply: ((count: number) => void) | undefined;
  const client = new MobileOutputClient({
    current: () => ({ sessionId: id, revision: 1 }),
    send: (event) => {
      sent.push(event);
      queueMicrotask(() => {
        if (event.type === "session.select" && event.recoveryId)
          client.observe({
            type: "session.recovery.ready",
            sessionId: id,
            recoveryId: event.recoveryId,
            ok: true,
            ...(pendingJournal ? { journalRequired: true } : {}),
          });
        if (event.type === "session.outputJournal") {
          const page = readOutputJournal(root, id, { after: event.after, through: event.through });
          beforePageReply?.(++pageCount);
          client.observe({
            type: "session.outputJournal",
            sessionId: id,
            recoveryId: event.recoveryId,
            requestId: event.requestId,
            page,
            legacyBaseComplete: true,
            legacyBase: { throughEventId: baseId, events: legacyEvents },
            snapshot: { epoch: "main", nextSeq: 10, outputCursor: cursor, unpaired: false },
          });
        }
      });
      return true;
    },
    commit: (_id, result) =>
      commits.push(
        result.chat.items
          .filter((item) => item.kind === "assistant")
          .map((item) => item.text)
          .join(""),
      ),
    failed: () => {
      failures++;
    },
    legacy: () => {
      throw new Error("negotiated recovery cannot become legacy success");
    },
  });
  cleanup.push(() => client.cancel(false));
  client.observe({
    type: "auth.ok",
    capabilities: { outputJournal: 1 },
    device: { id: "phone", name: "fixture" },
  } as MobileServerEvent);
  return {
    client,
    openJournal,
    removeJournal: () => unlinkSync(join(root, id, "output-journal.jsonl")),
    commits,
    sent,
    failures: () => failures,
    cursor: () => cursor,
    beforePageReply: (fn: (count: number) => void) => {
      beforePageReply = fn;
    },
    terminal: () => {
      cursor = writer.append({ type: "turn_complete", reason: "completed" });
      return cursor;
    },
    append: (text: string) => {
      cursor = writer.append({ type: "text_delta", text });
      return cursor;
    },
  };
}
async function settled(check: () => boolean) {
  for (let index = 0; index < 100; index++) {
    await Promise.resolve();
    if (check()) return;
  }
  throw new Error("bounded client fixture did not settle");
}

test("true snapshot head recovers a coalesced live gap without inventing output or another producer request", async () => {
  const f = fixture();
  f.client.begin("external");
  await settled(() => f.commits.length === 1);
  const old = f.cursor(),
    initialSelects = f.sent.filter((event) => event.type === "session.select").length;
  f.client.advanceSnapshot("external", f.append("missing-prefix"));
  f.client.advanceSnapshot("external", f.append("suffix"));
  await settled(() => f.commits.at(-1) === "firstmissing-prefixsuffix");
  expect(f.failures()).toBe(0);
  const recoveredSelects = f.sent.filter((event) => event.type === "session.select").length;
  expect(recoveredSelects).toBe(initialSelects + 1);
  f.client.advanceSnapshot("external", old);
  f.client.advanceSnapshot("external", f.cursor());
  expect(f.sent.filter((event) => event.type === "session.select").length).toBe(recoveredSelects);
  expect(f.sent.some((event) => event.type === "chat.send")).toBe(false);
});

test("wrong cursor domain leaves previous display and sticky barrier rather than accepting a fabricated snapshot", async () => {
  const f = fixture(),
    other = fixture("other");
  f.client.begin("external");
  await settled(() => f.commits.length === 1);
  f.client.advanceSnapshot("external", other.cursor());
  expect(f.failures()).toBe(1);
  f.client.advanceSnapshot("external", f.append("after-failure"));
  expect(f.commits).toEqual(["first"]);
  expect(
    f.client.hold("external", {
      type: "text_delta",
      text: "after-failure",
      outputCursor: f.cursor(),
    }),
  ).toBe("pending");
});

test("a different or cancelled conversation cannot be resumed by a late snapshot pointer", async () => {
  const f = fixture();
  f.client.begin("external");
  await settled(() => f.commits.length === 1);
  const sent = f.sent.length;
  f.client.advanceSnapshot("other", f.append("unselected"));
  expect(f.sent.length).toBe(sent);
  f.client.cancel(false);
  f.client.advanceSnapshot("external", f.cursor());
  expect(f.sent.length).toBe(sent);
});

test("terminal observed during the last bounded catch-up round gets one delayed reconciliation without another event", async () => {
  const f = fixture();
  f.beforePageReply((count) => {
    if (count > 8) return;
    const outputCursor = count === 8 ? f.terminal() : f.append(String(count));
    expect(
      f.client.hold(
        "external",
        count === 8
          ? { type: "turn_complete", reason: "completed", outputCursor }
          : { type: "text_delta", text: String(count), outputCursor },
      ),
    ).toBe("pending");
  });
  f.client.begin("external");
  // No future event is sent after the terminal on round eight.
  for (let index = 0; index < 100 && !f.commits.length; index++)
    await new Promise((done) => setTimeout(done, 2));
  expect(f.commits).toEqual(["first1234567"]);
  // Eight moving heads, then the already-read last frozen suffix is reconciled.
  expect(f.sent.filter((event) => event.type === "session.outputJournal").length).toBe(9);
  expect(f.sent.filter((event) => event.type === "session.select").length).toBe(1);
  expect(f.sent.some((event) => event.type === "chat.send")).toBe(false);
  expect(f.failures()).toBe(1); // Temporary truthful barrier, then proven commit.
});

test("a live authority revocation invalidates an already joined selection and preserves its display", async () => {
  const f = fixture();
  f.client.begin("external");
  await settled(() => f.commits.length === 1);
  const selected = f.sent.find((event) => event.type === "session.select") as Extract<
    MobileClientEvent,
    { type: "session.select" }
  >;
  f.client.observe({
    type: "session.recovery.ready",
    sessionId: "external",
    recoveryId: selected.recoveryId!,
    ok: false,
  });
  expect(f.failures()).toBe(1);
  f.client.advanceSnapshot("external", f.append("revoked-output"));
  expect(f.commits).toEqual(["first"]);
});

test("successive moving-head budgets retain their private prefix and reconcile only on cursor advancement", async () => {
  const f = fixture();
  f.beforePageReply((count) => {
    if (count <= 18)
      f.client.hold("external", {
        type: count === 18 ? "turn_complete" : "text_delta",
        outputCursor: count === 18 ? f.terminal() : f.append("x"),
      });
  });
  f.client.begin("external");
  for (let index = 0; index < 200 && !f.commits.length; index++)
    await new Promise((done) => setTimeout(done, 2));
  expect(f.commits).toEqual(["first" + "x".repeat(17)]);
  expect(f.sent.filter((event) => event.type === "session.outputJournal").length).toBe(19);
  expect(f.sent.filter((event) => event.type === "session.select").length).toBe(1);
  expect(f.failures()).toBe(2);
});

test("revocation during the capacity backoff remains sticky and cancels its pending continuation", async () => {
  const f = fixture();
  f.beforePageReply((count) => {
    if (count <= 8)
      f.client.hold("external", { type: "text_delta", text: "x", outputCursor: f.append("x") });
  });
  f.client.begin("external");
  await settled(() => f.failures() === 1);
  const selected = f.sent.find((event) => event.type === "session.select") as Extract<
    MobileClientEvent,
    { type: "session.select" }
  >;
  f.client.observe({
    type: "session.recovery.ready",
    sessionId: "external",
    recoveryId: selected.recoveryId!,
    ok: false,
  });
  const pages = f.sent.length;
  await new Promise((done) => setTimeout(done, 40));
  expect(f.sent.length).toBe(pages);
  expect(f.commits).toEqual([]);
  expect(f.failures()).toBe(2);
});

test("an explicitly journal-owned producer waits for its first real cursor instead of revoking the initial command selection", async () => {
  const f = fixture("external", true);
  f.client.begin("external");
  await settled(() => f.sent.some((event) => event.type === "session.outputJournal"));
  await settled(() => f.client.owns("external"));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(f.commits).toEqual([]);
  expect(f.failures()).toBe(0);
  expect(f.sent.some((event) => event.type === "session.recovery.cancel")).toBe(false);
  f.openJournal();
  f.client.hold("external", {
    type: "text_delta",
    text: "suffix",
    outputCursor: f.append("suffix"),
  });
  await settled(() => f.commits.length === 1);
  expect(f.commits).toEqual(["firstsuffix"]);
  expect(f.sent.filter((event) => event.type === "session.select")).toHaveLength(1);
  expect(f.sent.some((event) => event.type === "chat.send")).toBe(false);
});

test("first commit racing an unavailable read rechecks actual pages rather than losing the selected producer", async () => {
  const f = fixture("external", true);
  f.beforePageReply((count) => {
    if (count === 1) {
      f.openJournal();
      f.client.hold("external", {
        type: "text_delta",
        text: "suffix",
        outputCursor: f.append("suffix"),
      });
    }
  });
  f.client.begin("external");
  await settled(() => f.commits.length === 1);
  expect(f.commits).toEqual(["firstsuffix"]);
  expect(f.failures()).toBe(0);
  expect(f.sent.filter((event) => event.type === "session.outputJournal")).toHaveLength(2);
});

test("published journal loss never uses the initial passive wait exception", async () => {
  const f = fixture("external", true);
  f.openJournal();
  f.removeJournal();
  f.client.begin("external");
  await settled(() => f.failures() === 1);
  expect(f.commits).toEqual([]);
  f.client.advanceSnapshot("external", f.cursor());
  expect(f.failures()).toBe(1);
});
