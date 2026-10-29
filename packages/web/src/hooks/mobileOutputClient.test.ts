import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../core/src/session/session-manager.js";
import {
  SessionOutputJournal,
  readOutputJournal,
} from "../../../core/src/session/output-journal.js";
import { transcriptToStreamEvents } from "../lib/transcriptReplay.js";
import { SessionOutputCoverageStore } from "../../../core/src/session/output-coverage-state.js";
import { MobileOutputClient } from "./mobileOutputClient.js";
import type { MobileClientEvent, MobileServerEvent } from "@cjhyy/code-shell-core";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture(
  id = "external",
  pendingJournal = false,
  baseOptions?: {
    capability?: boolean;
    reply?: (request: any, reply: any, count: number) => any;
  },
  journalReply?: (reply: any, count: number) => any,
) {
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
    pageCount = 0,
    baseCount = 0;
  const baseEvents = [
    ...legacyEvents,
    { type: "stream_request_start" },
    { type: "text_delta", text: "legacy" },
  ];
  const baseReply = (event: any) => ({
    type: "session.legacyBase",
    sessionId: id,
    recoveryId: event.recoveryId,
    requestId: event.requestId,
    ok: true,
    throughEventId: baseId,
    index: event.cursor ? 1 : 0,
    events: event.cursor ? baseEvents.slice(1) : baseEvents.slice(0, 1),
    complete: !!event.cursor,
    ...(!event.cursor ? { next: "next" } : {}),
  });
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
          pageCount++;
          beforePageReply?.(pageCount);
          const reply = {
            type: "session.outputJournal",
            sessionId: id,
            recoveryId: event.recoveryId,
            requestId: event.requestId,
            page,
            legacyBaseComplete: !baseOptions,
            legacyBase: { throughEventId: baseId, events: baseOptions ? [] : legacyEvents },
            snapshot: {
              ...new SessionOutputCoverageStore(() => root).read(id),
              epoch: "main",
              nextSeq: 10,
              outputCursor: cursor,
              unpaired: false,
            },
          };
          client.observe(
            journalReply ? journalReply(reply, pageCount) : (reply as MobileServerEvent),
          );
        }
        if ((event as any).type === "session.legacyBase") {
          const reply = baseOptions?.reply
            ? baseOptions.reply(event, baseReply(event), ++baseCount)
            : baseReply(event);
          if (reply) client.observe(reply as any);
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
    capabilities: {
      outputJournal: 1,
      ...(baseOptions && baseOptions.capability !== false ? { legacyBasePages: 1 } : {}),
    },
    device: { id: "phone", name: "fixture" },
  } as MobileServerEvent);
  return {
    client,
    baseReply,
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

test("negotiated base pages use the single transport waiter and join the existing journal", async () => {
  const f = fixture("external", false, {});
  f.client.begin("external");
  await settled(() => f.commits.length > 0 || f.failures() > 0);
  expect(f.commits).toEqual(["legacyfirst"]);
  expect(f.sent.filter((event: any) => event.type === "session.legacyBase")).toHaveLength(2);
});
test("old host without the base capability fails at the old barrier with no base requests", async () => {
  const f = fixture("external", false, { capability: false });
  f.client.begin("external");
  await settled(() => f.failures() > 0);
  expect(f.commits).toEqual([]);
  expect(f.sent.some((event: any) => event.type === "session.legacyBase")).toBe(false);
});
test("base replies require both matching requestId and event type, ignoring late foreign replies", async () => {
  const f = fixture("external", false, {
    reply: (request, reply) => {
      f.client.observe({ ...reply, requestId: "wrong" });
      f.client.observe({
        ...reply,
        type: "session.outputJournal",
        page: { status: "incomplete" },
      } as any);
      return reply;
    },
  });
  f.client.begin("external");
  await settled(() => f.commits.length > 0 || f.failures() > 0);
  expect(f.commits).toEqual(["legacyfirst"]);
  expect(f.failures()).toBe(0);
});
test("cancel during a base request stops subsequent reads and isolates a late reply from reselection", async () => {
  const f = fixture("external", false, { reply: () => undefined });
  f.client.begin("external");
  await settled(
    () => f.sent.some((event: any) => event.type === "session.legacyBase") || f.failures() > 0,
  );
  const request = f.sent.find((event: any) => event.type === "session.legacyBase");
  expect(request).toBeDefined();
  f.client.cancel();
  f.client.begin("external");
  await settled(
    () => f.sent.filter((event: any) => event.type === "session.legacyBase").length === 2,
  );
  f.client.observe(f.baseReply(request) as any);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(f.commits).toEqual([]);
  expect(f.failures()).toBe(0);
  expect(f.sent.filter((event: any) => event.type === "session.legacyBase")).toHaveLength(2);
});
for (const forever of [false, true])
  test(`busy base requests back off 25ms at most eight retries (${forever ? "exhaust" : "recover"})`, async () => {
    const f = fixture("external", false, {
      reply: (_request, reply, count) =>
        forever || count <= 8
          ? {
              type: reply.type,
              sessionId: reply.sessionId,
              recoveryId: reply.recoveryId,
              requestId: reply.requestId,
              ok: false,
              reason: "busy",
            }
          : reply,
    });
    f.client.begin("external");
    await new Promise((resolve) => setTimeout(resolve, 280));
    expect(f.sent.filter((event: any) => event.type === "session.legacyBase")).toHaveLength(
      forever ? 9 : 10,
    );
    expect(f.commits).toEqual(forever ? [] : ["legacyfirst"]);
    expect(f.failures()).toBe(forever ? 1 : 0);
  });
test("cancel clears a busy retry timer and does not issue a later base request", async () => {
  const f = fixture("external", false, {
    reply: (_request, reply) => ({
      type: reply.type,
      sessionId: reply.sessionId,
      recoveryId: reply.recoveryId,
      requestId: reply.requestId,
      ok: false,
      reason: "busy",
    }),
  });
  f.client.begin("external");
  await settled(
    () => f.sent.some((event: any) => event.type === "session.legacyBase") || f.failures() > 0,
  );
  expect(f.sent.some((event: any) => event.type === "session.legacyBase")).toBe(true);
  f.client.cancel();
  const count = f.sent.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(f.sent.length).toBe(count);
  expect(f.commits).toEqual([]);
});

for (const malformed of ["oversize", "mixed"] as const)
  test(`invalid ${malformed} busy reply fails before backoff`, async () => {
    const f = fixture("external", false, {
      reply: (request, reply) =>
        malformed === "mixed"
          ? { ...reply, ok: false, reason: "busy" }
          : {
              type: "session.legacyBase",
              sessionId: "external",
              recoveryId: request.recoveryId,
              requestId: request.requestId,
              ok: false,
              reason: "busy",
              padding: "汉".repeat(400_000),
            },
    });
    f.client.begin("external");
    await settled(() => f.sent.some((event: any) => event.type === "session.legacyBase"));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(f.failures()).toBe(1);
    expect(f.sent.filter((event: any) => event.type === "session.legacyBase")).toHaveLength(1);
  });

test("a base request keeps the ten-second timeout and releases its waiter after timeout", async () => {
  const f = fixture("external", false, { reply: () => undefined });
  const real = globalThis.setTimeout;
  const delays: number[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: any[]) => void,
    delay: number,
    ...args: any[]
  ) => {
    delays.push(delay);
    return real(callback, delay === 10_000 ? 1 : delay, ...args);
  }) as typeof setTimeout);
  try {
    f.client.begin("external");
    await new Promise((resolve) => real(resolve, 20));
    expect(delays.filter((delay) => delay === 10_000)).toHaveLength(3); // ready, journal, base
    expect(f.failures()).toBe(1);
    expect(f.commits).toEqual([]);
    expect((f.client as any).selection.waiter).toBeUndefined();
  } finally {
    timer.mockRestore();
    f.client.cancel(false);
  }
});

function busyJournal(reply: any) {
  return {
    type: reply.type,
    sessionId: reply.sessionId,
    recoveryId: reply.recoveryId,
    requestId: reply.requestId,
    busy: true,
    page: { version: 1, status: "incomplete", frames: [], complete: false },
  };
}

for (const forever of [false, true])
  test(`busy journal reads use bounded backoff (${forever ? "exhaust" : "recover"})`, async () => {
    const real = globalThis.setTimeout;
    const delays: number[] = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback,
      delay,
      ...args
    ) => {
      if (delay >= 50 && delay <= 1000) delays.push(delay);
      return real(callback, delay >= 50 && delay <= 1000 ? 1 : delay, ...args);
    }) as typeof setTimeout);
    try {
      const f = fixture("external", false, undefined, (reply, count) =>
        forever || count <= 8 ? busyJournal(reply) : reply,
      );
      f.client.begin("external");
      for (let attempt = 0; attempt < 100 && !f.commits.length && !f.failures(); attempt++)
        await new Promise((resolve) => real(resolve, 5));
      expect(delays).toEqual([50, 100, 200, 400, 800, 1000, 1000, 1000]);
      expect(f.sent.filter((event) => event.type === "session.outputJournal")).toHaveLength(9);
      expect(f.commits).toEqual(forever ? [] : ["first"]);
      expect(f.failures()).toBe(forever ? 1 : 0);
    } finally {
      timer.mockRestore();
    }
  });

test("switching selection clears a busy journal retry and ignores its late reply", async () => {
  const f = fixture("external", false, undefined, (reply, count) =>
    count === 1 ? busyJournal(reply) : reply,
  );
  f.client.begin("external");
  await settled(() => Boolean((f.client as any).selection.retry));
  f.client.begin("external");
  await settled(() => f.commits.length === 1);
  const count = f.sent.length;
  await new Promise((resolve) => setTimeout(resolve, 70));
  expect(f.sent.length).toBe(count);
  expect(f.sent.filter((event) => event.type === "session.outputJournal")).toHaveLength(2);
  expect(f.commits).toEqual(["first"]);
  expect(f.failures()).toBe(0);
});

for (const malformed of ["unmarked", "mixed"] as const)
  test(`${malformed} incomplete journal replies are not retried as busy`, async () => {
    const f = fixture("external", false, undefined, (reply) => {
      const busy = busyJournal(reply);
      return malformed === "mixed"
        ? { ...busy, snapshot: reply.snapshot }
        : { ...busy, busy: undefined };
    });
    f.client.begin("external");
    await settled(() => f.failures() > 0);
    expect(f.sent.filter((event) => event.type === "session.outputJournal")).toHaveLength(1);
    expect(f.commits).toEqual([]);
  });

test("foreground bursts join an existing recovery and later foreground events still refresh", async () => {
  const f = fixture();
  const now = spyOn(Date, "now").mockReturnValue(1000);
  try {
    f.client.begin("external");
    expect(f.client.resync("external")).toBe("unchanged");
    now.mockReturnValue(2000);
    expect(f.client.resync("external")).toBe("unchanged"); // Still in flight, beyond debounce.
    await settled(() => f.commits.length === 1);
    expect(f.client.resync("external")).toBe("started");
    await settled(() => f.commits.length === 2);
    expect(f.client.resync("external")).toBe("unchanged");
    expect(f.sent.filter((event) => event.type === "session.select")).toHaveLength(2);
    now.mockReturnValue(2600);
    expect(f.client.resync("external")).toBe("started");
    await settled(() => f.commits.length === 3);
    expect(f.failures()).toBe(0);
  } finally {
    now.mockRestore();
  }
});

test("foreground refresh discovers the first journal when its live notification was missed", async () => {
  const f = fixture("external", true);
  const now = spyOn(Date, "now").mockReturnValue(1000);
  try {
    f.client.begin("external");
    await settled(() => !f.client.pending("external"));
    expect(f.commits).toEqual([]);
    expect(f.client.owns("external")).toBe(true);
    f.openJournal();
    now.mockReturnValue(2000);
    expect(f.client.resync("external")).toBe("started");
    await settled(() => f.commits.length === 1);
    expect(f.commits).toEqual(["first"]);
    expect(f.failures()).toBe(0);
  } finally {
    now.mockRestore();
  }
});
