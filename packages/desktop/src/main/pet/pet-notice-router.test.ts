import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetNoticeLedger, type NoticeRecord } from "./pet-notice-ledger";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
} from "./pet-state-aggregator";
import {
  PetAttentionPolicy,
  PetNoticeRouter,
  type NoticeImSendResult,
  type NoticeConversation,
  type NoticeRouterSettings,
  type NoticeSubmission,
  type NoticeTarget,
} from "./pet-notice-router";

class FakeClock {
  now = 0;
  private next = 0;
  private timers = new Map<number, { at: number; run: () => void }>();
  setTimeout = (run: () => void, delay: number) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delay, run });
    return id;
  };
  clearTimeout = (id: number) => this.timers.delete(id);
  pendingAt(): number[] {
    return [...this.timers.values()].map((timer) => timer.at).sort((a, b) => a - b);
  }
  advance(ms: number) {
    this.now += ms;
    let ready = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.now);
    while (ready.length > 0) {
      for (const [id, timer] of ready) {
        this.timers.delete(id);
        timer.run();
      }
      ready = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.now);
    }
  }
}

function snapshot(count = 1): DesktopPetProjectionSnapshot {
  return {
    version: 4,
    generation: 2,
    workerState: "active",
    observedAt: 1,
    sessions: [],
    pending: Array.from({ length: count }, (_, index) => ({
      agentSessionId: `work-${index}`,
      requestId: `req-${index}`,
      workerGeneration: 2,
      kind: "ask_user" as const,
      title: `Question ${index}`,
      createdAt: 0,
      status: "pending" as const,
    })),
  };
}

describe("PetAttentionPolicy", () => {
  test("waits the full 15s grace and cancels resolved work", () => {
    const clock = new FakeClock();
    let current = snapshot();
    let sourceListener: ((event: DesktopPetProjectionEvent) => void) | undefined;
    const events: unknown[] = [];
    const policy = new PetAttentionPolicy({
      source: {
        getSnapshot: () => current,
        subscribe: (listener) => {
          sourceListener = listener;
          return () => {};
        },
      },
      receipts: { has: () => false, mark: () => {} },
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    policy.subscribe((event) => events.push(event));
    policy.start();

    clock.advance(14_999);
    expect(policy.getSnapshot().surfaceablePendingCount).toBe(0);
    clock.advance(1);
    expect(policy.getSnapshot().surfaceablePendingCount).toBe(1);

    current = { ...current, pending: [] };
    sourceListener?.({ kind: "reset", version: 5, generation: 2, observedAt: 2 });
    expect(policy.getSnapshot().surfaceablePendingCount).toBe(0);
  });

  test("dedupes receipts, suppresses the active target and aggregates a burst", () => {
    const clock = new FakeClock();
    let current = snapshot(1);
    const marked: string[] = [];
    const peeks: unknown[] = [];
    const policy = new PetAttentionPolicy({
      source: { getSnapshot: () => current, subscribe: () => () => {} },
      receipts: { has: (key) => marked.includes(key), mark: (key) => marked.push(key) },
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    policy.subscribe((event) => {
      if (event.kind === "peek") peeks.push(event.peek);
    });
    policy.setActiveSession("work-0");
    policy.start();
    clock.advance(15_000);
    clock.advance(2_000);

    expect(policy.getSnapshot().surfaceablePendingCount).toBe(1);
    expect(peeks).toHaveLength(0);
    expect(marked).toHaveLength(1);

    current = snapshot(3);
    policy.setActiveSession(null);
    policy.reconcile();
    clock.advance(2_000);
    expect(policy.getSnapshot().surfaceablePendingCount).toBe(3);
    expect(peeks).toHaveLength(1);
    expect(peeks[0]).toMatchObject({ action: { type: "open_pet_pending", count: 2 } });
    expect(marked).toHaveLength(3);
  });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 12:00 local at UTC+8. */
const NOON = Date.UTC(2026, 10, 9, 4, 0, 0);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-notice-router-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function plus8HourKey(ms: number): string {
  return String(Math.floor((ms + 8 * HOUR) / HOUR));
}

interface ImCall {
  channel: string;
  target: NoticeTarget;
  body: string;
  key: string | undefined;
}

interface Harness {
  clock: FakeClock;
  ledger: PetNoticeLedger;
  router: PetNoticeRouter;
  desktop: Array<{ kind: string; body: string }>;
  im: ImCall[];
  logs: Array<{ event: string; data: Record<string, unknown> }>;
  state: {
    present: boolean;
    channels: Record<string, "ready" | "unknown" | "unavailable">;
    lastInbound?: string;
    settings: NoticeRouterSettings;
    imResult: (call: ImCall) => NoticeImSendResult | Promise<NoticeImSendResult>;
    idempotent: Set<string>;
    pending: Set<string>;
  };
}

function harness(
  options: {
    now?: number;
    ledger?: PetNoticeLedger;
    clock?: FakeClock;
    failLedger?: "record" | "claim";
  } = {},
): Harness {
  const clock = options.clock ?? new FakeClock();
  if (!options.clock) clock.now = options.now ?? NOON;
  const ledger =
    options.ledger ??
    new PetNoticeLedger({
      path: join(dir, "notices.json"),
      now: () => clock.now,
      localHourKey: plus8HourKey,
    });
  const desktop: Harness["desktop"] = [];
  const im: ImCall[] = [];
  const logs: Harness["logs"] = [];
  const state: Harness["state"] = {
    present: false,
    channels: { lark: "ready", telegram: "ready" },
    lastInbound: "lark",
    settings: { quietHours: null },
    imResult: () => ({ accepted: true }),
    idempotent: new Set(["lark", "telegram"]),
    pending: new Set(),
  };
  const ledgerPort = options.failLedger
    ? Object.assign(Object.create(ledger) as PetNoticeLedger, {
        [options.failLedger]: () => Promise.reject(new Error("disk full")),
      })
    : ledger;
  const router = new PetNoticeRouter({
    source: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        workerState: "active",
        observedAt: 0,
        sessions: [],
        pending: [],
      }),
      subscribe: () => () => {},
    },
    receipts: { has: () => false, mark: () => {} },
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ledger: ledgerPort,
    presence: { isPresent: () => state.present },
    settings: () => state.settings,
    imChannels: () => state.channels,
    lastInboundChannel: () => state.lastInbound,
    supportsIdempotentSend: (channel) => state.idempotent.has(channel),
    isDecisionStillPending: (sessionId, requestId) =>
      state.pending.has(`${sessionId}/${requestId}`),
    timezoneOffsetMin: () => 480,
    outlets: {
      desktop: (notice, body) => desktop.push({ kind: notice.kind, body }),
      im: async (channel, target, body, key) => {
        const call = { channel, target, body, key };
        im.push(call);
        return state.imResult(call);
      },
    },
    log: (event, data) => logs.push({ event, data }),
  });
  return { clock, ledger, router, desktop, im, logs, state };
}

let seq = 0;
function notice(overrides: Partial<NoticeSubmission> = {}): NoticeSubmission {
  seq += 1;
  return {
    kind: "session.done",
    priority: "P1",
    dedupeKey: `session.done:s${seq}:run-${seq}`,
    sessionId: `s${seq}`,
    ruleIds: ["rule-1"],
    facts: { title: `Task ${seq}`, summary: "all green" },
    attention: "always",
    channel: "auto",
    target: { kind: "owner" },
    ...overrides,
  };
}

function key(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

/** Let real ledger I/O progress until `ready()` holds. */
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const DM: NoticeConversation = { target: "dm-owner", isDirectMessage: true };

function only<T>(values: T[]): T {
  expect(values).toHaveLength(1);
  return values[0]!;
}

describe("PetNoticeRouter.submit", () => {
  test("present + auto shows only the desktop", async () => {
    const h = harness();
    h.state.present = true;
    const decision = await h.router.submit(notice({ facts: { title: "Build", summary: "ok" } }));
    expect(decision).toMatchObject({ outlet: "desktop", reason: "present-desktop" });
    expect(h.im).toHaveLength(0);
    expect(only(h.desktop).body).toBe("「Build」做完了：ok");
  });

  test("a named IM channel gets IM plus desktop regardless of presence", async () => {
    const h = harness();
    h.state.present = true;
    const decision = await h.router.submit(notice({ channel: "telegram" }));
    expect(decision).toMatchObject({ outlet: "both", im: "telegram" });
    expect(only(h.im).channel).toBe("telegram");
    expect(h.desktop).toHaveLength(1);
  });

  test("away + auto goes to the last inbound channel with the idempotency key", async () => {
    const h = harness();
    h.state.lastInbound = "telegram";
    const decision = await h.router.submit(notice());
    expect(decision).toMatchObject({ outlet: "im", im: "telegram", reason: "away-last-inbound" });
    const call = only(h.im);
    expect(call.channel).toBe("telegram");
    expect(call.target).toEqual({ kind: "owner" });
    expect(h.desktop).toHaveLength(0);
    const file = JSON.parse(await readFile(join(dir, "notices.json"), "utf8")) as {
      records: NoticeRecord[];
    };
    const record = only(file.records);
    expect(record.delivery).toMatchObject({ status: "accepted", channel: "telegram" });
    expect(call.key).toBe(key(record.id));
  });

  test("a non-idempotent channel is sent without a key", async () => {
    const h = harness();
    h.state.idempotent.clear();
    await h.router.submit(notice());
    expect(only(h.im).key).toBeUndefined();
  });

  test("a duplicate dedupe key is dropped", async () => {
    const h = harness();
    await h.router.submit(notice({ dedupeKey: "same" }));
    const second = await h.router.submit(notice({ dedupeKey: "same" }));
    expect(second).toMatchObject({ outlet: "drop", reason: "duplicate" });
    expect(h.im).toHaveLength(1);
  });

  test("an IM failure shows the desktop and queues; replay revokes resolved decisions", async () => {
    const h = harness();
    h.state.imResult = () => ({ accepted: false, error: "gateway down" });
    h.state.pending.add("s-open/req-open");
    await h.router.submit(
      notice({
        kind: "session.blocked",
        priority: "P0",
        sessionId: "s-done",
        requestId: "req-done",
        facts: { title: "Old", question: "Ship it?" },
      }),
    );
    await h.router.submit(
      notice({
        kind: "session.blocked",
        priority: "P0",
        sessionId: "s-open",
        requestId: "req-open",
        facts: {
          title: "Deploy",
          question: "Which region?",
          options: [{ label: "us" }, { label: "eu", recommended: true }],
          code: "K7",
        },
      }),
    );
    expect(h.im).toHaveLength(2);
    expect(h.desktop).toHaveLength(2);
    expect(h.ledger.queued().map((record) => record.delivery?.status)).toEqual([
      "queued",
      "queued",
    ]);

    const replay = await h.router.replayPending("lark", DM);
    const kept = only(replay);
    expect(Object.keys(kept).sort()).toEqual(["body", "id", "kind", "sessionId", "title"]);
    expect(kept).toMatchObject({ kind: "session.blocked", sessionId: "s-open", title: "Deploy" });
    expect(kept.body).toBe(
      "「Deploy」需要你决定：Which region?\n1. us\n2. eu（推荐）\n回复：回答 K7 序号 / 跳过 K7 / 等待 K7",
    );
    // The resolved one is revoked; the kept one stays queued until markReplayed.
    expect(only(h.ledger.queued()).id).toBe(kept.id);
    expect(await h.router.replayPending("telegram", DM)).toEqual([]);
    // A second inbound message meanwhile does not get the same notice again.
    expect(await h.router.replayPending("lark", DM)).toEqual([]);
    await h.router.markReplayed([kept.id]);
    expect(h.ledger.queued()).toEqual([]);
  });

  test("replay revokes done notices already viewed on the desktop", async () => {
    const h = harness();
    h.state.channels.lark = "unavailable";
    h.state.lastInbound = "lark";
    // Route target pins to lark, which is unavailable → desktop + queued.
    const decision = await h.router.submit(
      notice({
        target: { kind: "route", route: { kind: "im-gateway", channel: "lark", target: "c1" } },
      }),
    );
    expect(decision).toMatchObject({ outlet: "desktop", im: "lark", queued: true });
    expect(h.desktop).toHaveLength(1);
    const viewed = new PetNoticeRouter({
      source: { getSnapshot: () => ({}) as never, subscribe: () => () => {} },
      receipts: { has: () => false, mark: () => {} },
      ledger: h.ledger,
      now: () => h.clock.now,
      wasSessionViewedSince: () => true,
      log: () => {},
    });
    expect(await viewed.replayPending("lark", { target: "c1" })).toEqual([]);
    expect(h.ledger.queued()).toEqual([]);
  });

  test("quiet hours hold P1s, send P0s, and flush one digest at the end", async () => {
    // 23:00 local (UTC+8); quiet 22:00–07:00 ends at 07:00 local the next day.
    const h = harness({ now: Date.UTC(2026, 10, 9, 15, 0, 0) });
    h.state.settings = { quietHours: { start: "22:00", end: "07:00" } };
    const end = Date.UTC(2026, 10, 9, 23, 0, 0);
    const a = await h.router.submit(notice({ facts: { title: "Alpha" } }));
    const b = await h.router.submit(notice({ kind: "session.failed", facts: { title: "Beta" } }));
    expect(a).toMatchObject({ outlet: "digest", reason: "quiet-hours" });
    expect(b).toMatchObject({ outlet: "digest", reason: "quiet-hours" });
    expect(h.ledger.held()).toHaveLength(2);
    expect(h.clock.pendingAt()).toEqual([end]);

    const p0 = await h.router.submit(
      notice({ kind: "session.blocked", priority: "P0", requestId: "r", facts: { title: "Gate" } }),
    );
    expect(p0).toMatchObject({ outlet: "im", im: "lark" });
    expect(h.im).toHaveLength(1);

    // An early manual flush is still inside quiet hours: nothing is sent.
    await h.router.flushDigest();
    expect(h.im).toHaveLength(1);

    h.clock.advance(end - h.clock.now);
    await h.router.flushDigest();
    expect(h.im).toHaveLength(2);
    const digest = h.im[1]!;
    expect(digest.body).toBe("你不在时：\n- 「Alpha」做完了\n- 「Beta」没做完");
    expect(h.ledger.held()).toEqual([]);
    expect(h.clock.pendingAt()).toEqual([]);
    // Flushing again sends nothing more.
    await h.router.flushDigest();
    expect(h.im).toHaveLength(2);
  });

  test("the 13th P0 in one hour goes to the digest", async () => {
    const h = harness();
    for (let index = 0; index < 12; index += 1) {
      const decision = await h.router.submit(notice({ kind: "session.blocked", priority: "P0" }));
      expect(decision.outlet).toBe("im");
    }
    const thirteenth = await h.router.submit(notice({ kind: "session.blocked", priority: "P0" }));
    expect(thirteenth).toMatchObject({ outlet: "digest", reason: "p0-cap" });
    expect(h.im).toHaveLength(12);
    expect(h.ledger.held()).toHaveLength(1);
    // A held decision request is still put in front of the owner right away.
    expect(h.desktop).toHaveLength(1);
  });

  test("a second P1 for the same Session within the merge window is held", async () => {
    const h = harness();
    const first = await h.router.submit(notice({ sessionId: "s-merge" }));
    expect(first.outlet).toBe("im");
    h.clock.advance(5 * MINUTE);
    const second = await h.router.submit(notice({ sessionId: "s-merge" }));
    expect(second).toMatchObject({ outlet: "digest", reason: "merge-window" });
    expect(h.im).toHaveLength(1);
    // Flushed once the merge window has passed since it was held.
    expect(h.clock.pendingAt()).toEqual([h.clock.now + 10 * MINUTE]);
    h.clock.advance(10 * MINUTE);
    await h.router.flushDigest();
    expect(h.im).toHaveLength(2);
    expect(h.im[1]!.body.startsWith("你不在时：")).toBe(true);
    // Outside the window a P1 for that Session goes out again.
    h.clock.advance(11 * MINUTE);
    expect((await h.router.submit(notice({ sessionId: "s-merge" }))).outlet).toBe("im");
  });

  test("a ledger write failure still puts a P0 on the desktop", async () => {
    const h = harness({ failLedger: "record" });
    const decision = await h.router.submit(
      notice({
        kind: "session.blocked",
        priority: "P0",
        facts: { title: "Gate", question: "Go?" },
      }),
    );
    expect(decision.outlet).toBe("im");
    expect(h.im).toHaveLength(0);
    expect(only(h.desktop).body).toBe("「Gate」需要你决定：Go?");
  });

  test("a route target sends on the route's channel and address", async () => {
    const h = harness();
    h.state.lastInbound = "lark";
    const route = { kind: "im-gateway" as const, channel: "telegram", target: "chat-9" };
    const decision = await h.router.submit(notice({ target: { kind: "route", route } }));
    expect(decision).toMatchObject({ outlet: "im", im: "telegram" });
    expect(only(h.im)).toMatchObject({ channel: "telegram", target: { kind: "route", route } });

    // A named channel on a route target still goes back to the route's channel.
    const named = await h.router.submit(
      notice({ channel: "lark", target: { kind: "route", route } }),
    );
    expect(named).toMatchObject({ outlet: "both", im: "telegram" });
  });
  test("a claim failure after a successful record falls back to the desktop", async () => {
    const h = harness({ failLedger: "claim" });
    const p0 = await h.router.submit(
      notice({ kind: "session.blocked", priority: "P0", facts: { title: "Gate" } }),
    );
    expect(p0.outlet).toBe("im");
    const p1 = await h.router.submit(notice({ facts: { title: "Done" } }));
    expect(p1.outlet).toBe("im");
    expect(h.im).toHaveLength(0);
    expect(h.desktop.map((entry) => entry.body)).toEqual(["「Gate」需要你决定", "「Done」做完了"]);
    expect(h.logs.filter((log) => log.event === "pet.notice.claim_failed")).toHaveLength(2);
  });

  test("a P1 lost to a ledger failure is logged", async () => {
    const h = harness({ failLedger: "record" });
    h.state.settings = { quietHours: { start: "00:00", end: "23:59" } };
    const decision = await h.router.submit(notice());
    expect(decision.outlet).toBe("digest");
    expect(h.desktop).toHaveLength(0);
    expect(h.logs.some((log) => log.event === "pet.notice.lost")).toBe(true);
  });

  test("a hanging send on an idempotent channel times out, shows the desktop and queues", async () => {
    const h = harness();
    h.state.imResult = () => new Promise<NoticeImSendResult>(() => {});
    const pending = h.router.submit(notice({ facts: { title: "Slow" } }));
    await until(() => h.im.length === 1);
    expect(h.desktop).toHaveLength(0);
    h.clock.advance(30_000);
    expect(await pending).toMatchObject({ outlet: "im", im: "lark" });
    expect(only(h.desktop).body).toBe("「Slow」做完了");
    expect(only(h.ledger.queued()).delivery).toMatchObject({ status: "queued", error: "timeout" });
  });

  test("a hanging send on a non-idempotent channel becomes unknown with a note", async () => {
    const h = harness();
    h.state.idempotent.clear();
    h.state.imResult = () => new Promise<NoticeImSendResult>(() => {});
    const pending = h.router.submit(notice({ facts: { title: "Slow" } }));
    await until(() => h.im.length === 1);
    h.clock.advance(30_000);
    expect((await pending).outlet).toBe("im");
    expect(only(h.desktop).body).toBe("可能已发送：「Slow」做完了");
    expect(h.ledger.queued()).toEqual([]);
    const file = JSON.parse(await readFile(join(dir, "notices.json"), "utf8")) as {
      records: NoticeRecord[];
    };
    expect(only(file.records).delivery).toMatchObject({ status: "unknown", error: "timeout" });
  });

  test("replayed notices are released automatically after the hold", async () => {
    const h = harness();
    h.state.channels.lark = "unavailable";
    await h.router.submit(notice({ facts: { title: "Owner" }, channel: "lark" }));
    expect((await h.router.replayPending("lark", DM)).map((entry) => entry.title)).toEqual([
      "Owner",
    ]);
    h.clock.advance(10 * MINUTE - 1);
    expect(await h.router.replayPending("lark", DM)).toEqual([]);
    h.clock.advance(1);
    expect((await h.router.replayPending("lark", DM)).map((entry) => entry.title)).toEqual([
      "Owner",
    ]);
  });

  test("merging a named-channel notice spares only the IM", async () => {
    const h = harness();
    h.state.present = true;
    await h.router.submit(notice({ sessionId: "s-named", channel: "telegram" }));
    h.clock.advance(MINUTE);
    const merged = await h.router.submit(notice({ sessionId: "s-named", channel: "telegram" }));
    expect(merged).toMatchObject({ outlet: "digest", reason: "merge-window" });
    expect(h.im).toHaveLength(1);
    expect(h.desktop).toHaveLength(2);
  });

  test("replay matches the stored route and holds handed-out notices until released", async () => {
    const h = harness();
    h.state.channels.lark = "unavailable";
    const routeA = {
      kind: "im-gateway" as const,
      channel: "lark",
      target: "chat-A",
      senderId: "u1",
    };
    const routeB = { kind: "im-gateway" as const, channel: "lark", target: "chat-B" };
    await h.router.submit(
      notice({ facts: { title: "A" }, target: { kind: "route", route: routeA } }),
    );
    await h.router.submit(notice({ facts: { title: "Owner" }, channel: "lark" }));
    await h.router.submit(
      notice({ facts: { title: "B" }, target: { kind: "route", route: routeB } }),
    );
    expect(h.ledger.queued()).toHaveLength(3);

    const titles = async (conversation: NoticeConversation) =>
      (await h.router.replayPending("lark", conversation)).map((entry) => entry.title);
    expect(await titles({ target: "chat-A", senderId: "u2" })).toEqual([]);
    expect(await titles({ target: "chat-A", senderId: "u1" })).toEqual(["A"]);
    const owner = await h.router.replayPending("lark", DM);
    expect(owner.map((entry) => entry.title)).toEqual(["Owner"]);
    expect(await titles(DM)).toEqual([]);
    h.router.releaseReplay(owner.map((entry) => entry.id));
    expect(await titles(DM)).toEqual(["Owner"]);
    expect(await titles({ target: "chat-B", senderId: "anyone" })).toEqual(["B"]);
  });

  test("route-target held notices get their own digest on that route, in arrival order", async () => {
    const h = harness({ now: Date.UTC(2026, 10, 9, 15, 0, 0) });
    h.state.settings = { quietHours: { start: "22:00", end: "07:00" } };
    const route = { kind: "im-gateway" as const, channel: "telegram", target: "chat-9" };
    const routed = { kind: "route" as const, route };
    await h.router.submit(notice({ facts: { title: "R1" }, target: routed }));
    await h.router.submit(notice({ facts: { title: "Owner" } }));
    await h.router.submit(notice({ facts: { title: "R2" }, target: routed }));
    await h.router.submit(
      notice({ kind: "session.failed", facts: { title: "R3" }, target: routed }),
    );
    h.clock.advance(Date.UTC(2026, 10, 9, 23, 0, 0) - h.clock.now);
    await h.router.flushDigest();
    expect(h.im).toHaveLength(2);
    const [toRoute, toOwner] = [
      h.im.find((call) => call.channel === "telegram")!,
      h.im.find((call) => call.channel === "lark")!,
    ];
    expect(toRoute.target).toEqual(routed);
    expect(toRoute.body).toBe("你不在时：\n- 「R1」做完了\n- 「R2」做完了\n- 「R3」没做完");
    expect(toOwner).toMatchObject({
      target: { kind: "owner" },
      body: "你不在时：\n- 「Owner」做完了",
    });
    expect(h.ledger.held()).toEqual([]);
  });

  test("after dispose submissions drop and in-flight sends settle without the desktop", async () => {
    const h = harness();
    const send = deferred<NoticeImSendResult>();
    h.state.imResult = () => send.promise;
    const pending = h.router.submit(notice());
    await until(() => h.im.length === 1);
    h.router.dispose();
    send.resolve({ accepted: false, error: "gateway down" });
    expect((await pending).outlet).toBe("im");
    expect(h.desktop).toHaveLength(0);
    expect(only(h.ledger.queued()).delivery?.status).toBe("queued");
    expect(await h.router.submit(notice())).toEqual({ outlet: "drop", reason: "disposed" });
    expect(h.im).toHaveLength(1);
  });
});

describe("PetNoticeRouter.recover", () => {
  async function crashedClaim(
    channel: string,
  ): Promise<{ clock: FakeClock; record: NoticeRecord }> {
    const clock = new FakeClock();
    clock.now = NOON;
    const first = new PetNoticeLedger({
      path: join(dir, "notices.json"),
      now: () => clock.now,
      localHourKey: plus8HourKey,
    });
    const record = await first.record({
      kind: "session.done",
      priority: "P1",
      dedupeKey: "done:crash",
      sessionId: "s-crash",
      ruleIds: [],
      facts: { title: "Crash", target: { kind: "owner" } },
      body: "「Crash」做完了",
      decision: { outlet: "im", im: channel, reason: "away-last-inbound" },
    });
    await first.claim(record.id, channel, "「Crash」做完了");
    return { clock, record };
  }

  function reopened(clock: FakeClock): PetNoticeLedger {
    return new PetNoticeLedger({
      path: join(dir, "notices.json"),
      now: () => clock.now,
      localHourKey: plus8HourKey,
    });
  }

  test("a young claim on an idempotent channel is resent once with the same key", async () => {
    const { clock, record } = await crashedClaim("lark");
    clock.advance(5 * MINUTE);
    const ledger = reopened(clock);
    const claim = ledger.claim.bind(ledger);
    const claims: Array<{ manualRetry?: boolean } | undefined> = [];
    ledger.claim = (id, channel, body, options) => {
      claims.push(options);
      return claim(id, channel, body, options);
    };
    const h = harness({ clock, ledger });
    await h.router.recover();
    const call = only(h.im);
    expect(call).toMatchObject({ channel: "lark", body: "「Crash」做完了", key: key(record.id) });
    expect(claims).toEqual([undefined]);
    expect(h.desktop).toHaveLength(0);
    expect(ledger.get(record.id)?.delivery).toMatchObject({ status: "accepted", attempts: 2 });
  });

  test("a young claim on a non-idempotent channel becomes unknown with a desktop note", async () => {
    const { clock, record } = await crashedClaim("wechat");
    clock.advance(5 * MINUTE);
    const ledger = reopened(clock);
    const h = harness({ clock, ledger });
    await h.router.recover();
    expect(h.im).toHaveLength(0);
    expect(only(h.desktop).body).toBe("可能已发送：「Crash」做完了");
    expect(ledger.get(record.id)?.delivery?.status).toBe("unknown");
  });

  test("recovery re-arms the digest for notices held before the restart", async () => {
    const h = harness({ now: Date.UTC(2026, 10, 9, 15, 0, 0) });
    h.state.settings = { quietHours: { start: "22:00", end: "07:00" } };
    await h.router.submit(notice());
    h.router.dispose();
    expect(h.clock.pendingAt()).toEqual([]);
    const next = harness({ clock: h.clock, ledger: reopened(h.clock) });
    next.state.settings = h.state.settings;
    await next.router.recover();
    expect(next.clock.pendingAt()).toEqual([Date.UTC(2026, 10, 9, 23, 0, 0)]);
    next.router.dispose();
  });

  test("recovery concurrent with an in-flight submit never sends twice", async () => {
    const { clock, record } = await crashedClaim("lark");
    clock.advance(5 * MINUTE);
    const ledger = reopened(clock);
    const h = harness({ clock, ledger });
    const send = deferred<NoticeImSendResult>();
    h.state.imResult = (call) =>
      call.body === "「Crash」做完了" ? { accepted: true } : send.promise;
    const pending = h.router.submit(notice({ facts: { title: "Live" } }));
    await until(() => h.im.length === 1);
    const recovering = h.router.recover();
    expect(h.router.recover()).toBe(recovering);
    await until(() => h.im.length === 2);
    send.resolve({ accepted: true });
    await Promise.all([pending, recovering]);
    await h.router.recover();
    expect(h.im.map((call) => call.body)).toEqual(["「Live」做完了", "「Crash」做完了"]);
    expect(ledger.get(record.id)?.delivery?.status).toBe("accepted");
    expect(h.logs.filter((log) => log.event === "pet.notice.settle_failed")).toEqual([]);
    expect(ledger.queued()).toEqual([]);
  });

  test("recovery skips a claim that settled while earlier records were recovered", async () => {
    const { clock, record } = await crashedClaim("lark");
    clock.advance(5 * MINUTE);
    const ledger = reopened(clock);
    const h = harness({ clock, ledger });
    const live = deferred<NoticeImSendResult>();
    const crash = deferred<NoticeImSendResult>();
    h.state.imResult = (call) => (call.body === "「Crash」做完了" ? crash.promise : live.promise);
    const pending = h.router.submit(notice({ facts: { title: "Live" } }));
    await until(() => h.im.length === 1);
    // Recovery snapshots both claims; the crashed one (older) is resent first and hangs.
    const recovering = h.router.recover();
    await until(() => h.im.length === 2);
    // Meanwhile the live send settles and leaves the in-flight set.
    live.resolve({ accepted: true });
    await pending;
    crash.resolve({ accepted: true });
    await recovering;
    expect(h.im.map((call) => call.body)).toEqual(["「Live」做完了", "「Crash」做完了"]);
    expect(h.desktop).toEqual([]);
    expect(ledger.get(record.id)?.delivery?.status).toBe("accepted");
    expect(
      h.logs.filter((log) =>
        ["pet.notice.resend_failed", "pet.notice.settle_failed"].includes(log.event),
      ),
    ).toEqual([]);
  });
});
