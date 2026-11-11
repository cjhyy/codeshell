import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slottedFlushAt } from "./pet-notice-digest.js";
import { PetNoticeLedger } from "./pet-notice-ledger.js";
import {
  PetNoticeRouter,
  type NoticeRouterSettings,
  type NoticeSubmission,
} from "./pet-notice-router.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 2026-11-09 local midnight at UTC+8. */
const DAY0 = Date.UTC(2026, 10, 8, 16, 0);
const at = (hours: number, minutes = 0) => DAY0 + hours * HOUR + minutes * MINUTE;

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
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-notice-digest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(now: number, settings: NoticeRouterSettings) {
  const clock = new FakeClock();
  clock.now = now;
  const ledger = new PetNoticeLedger({
    path: join(dir, "notices.json"),
    now: () => clock.now,
    localHourKey: (ms) => String(Math.floor((ms + 8 * HOUR) / HOUR)),
  });
  const im: Array<{ kind: string; body: string }> = [];
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
    ledger,
    presence: { isPresent: () => false },
    settings: () => settings,
    imChannels: () => ({ lark: "ready" }),
    lastInboundChannel: () => "lark",
    supportsIdempotentSend: () => true,
    timezoneOffsetMin: () => 480,
    outlets: {
      desktop: () => undefined,
      im: async (_channel, _target, body, _key, payload) => {
        im.push({ kind: payload.kind, body });
        return { accepted: true };
      },
    },
    log: () => undefined,
  });
  return { clock, ledger, router, im };
}

let seq = 0;
function notice(overrides: Partial<NoticeSubmission> = {}): NoticeSubmission {
  seq += 1;
  return {
    kind: "session.done",
    priority: "P1",
    dedupeKey: `done:${seq}`,
    sessionId: `s${seq}`,
    ruleIds: [],
    facts: { title: `Task ${seq}` },
    attention: "always",
    channel: "auto",
    target: { kind: "owner" },
    ...overrides,
  };
}

describe("slottedFlushAt", () => {
  const window = { quietHours: { start: "23:00", end: "08:00" }, timezoneOffsetMin: 480 };
  const slots = ["12:00", "18:00"];

  test("no slots: as soon as allowed", () => {
    expect(slottedFlushAt(at(12, 30), at(12, 30), [], window)).toBe(at(12, 30));
  });

  test("waits for the next slot; at the slot (or once slept past it) goes now", () => {
    expect(slottedFlushAt(at(12, 30), at(12, 31), slots, window)).toBe(at(18));
    expect(slottedFlushAt(at(12, 30), at(18), slots, window)).toBe(at(18));
    expect(slottedFlushAt(at(12, 30), at(18, 0) + 900, slots, window)).toBe(at(18) + 900);
    // Asleep from 17:00 to 19:30: the 18:00 slot passed while it was ready.
    expect(slottedFlushAt(at(12, 30), at(19, 30), slots, window)).toBe(at(19, 30));
    // Not ready until after quiet hours: the first slot after that.
    expect(slottedFlushAt(at(8), at(2), slots, window)).toBe(at(12));
  });

  test("a slot inside quiet hours is skipped", () => {
    expect(slottedFlushAt(at(18, 30), at(18, 30), ["23:30", "12:00"], window)).toBe(at(24 + 12));
  });
});

describe("digest slots through the router", () => {
  test("held notices wait for the slot; decisions still go at once", async () => {
    const h = setup(at(10), { quietHours: null, maxPerHour: 1, digestSlots: ["12:00", "18:00"] });
    await h.router.submit(notice());
    const held = await h.router.submit(notice({ facts: { title: "Second" } }));
    expect(held).toMatchObject({ outlet: "digest", reason: "hourly-cap" });
    // The cap clears at 11:00, but the digest waits for 12:00.
    expect(h.clock.pendingAt()).toEqual([at(12)]);
    h.clock.now = at(11);
    await h.router.flushDigest();
    expect(h.im.map((call) => call.kind)).toEqual(["session.done"]);
    const p0 = await h.router.submit(
      notice({ kind: "session.blocked", priority: "P0", requestId: "r", facts: { title: "Gate" } }),
    );
    expect(p0).toMatchObject({ outlet: "im" });
    h.clock.now = at(12);
    await h.router.flushDigest();
    expect(h.im.map((call) => call.kind)).toEqual(["session.done", "session.blocked", "digest"]);
    expect(h.im[2]!.body).toBe("你不在时：\n- 「Second」做完了");
    // A digest is no open item: the owner's next messages are not read against it.
    expect(h.ledger.actionRecords().filter((record) => record.kind === "digest")).toEqual([]);
  });
});

describe("standalone notices held by the digest", () => {
  test("a brief held by quiet hours goes out whole when they end, once", async () => {
    const h = setup(at(7), { quietHours: { start: "23:00", end: "08:00" } });
    const text = "早上好，今天的情况：\n- 登录修好了";
    const decision = await h.router.submit(
      notice({
        kind: "brief.morning",
        dedupeKey: "brief:morning:1",
        sessionId: undefined,
        body: text,
      }),
    );
    expect(decision).toMatchObject({ outlet: "digest", reason: "quiet-hours" });
    expect(h.clock.pendingAt()).toEqual([at(8)]);
    h.clock.now = at(8);
    await h.router.flushDigest();
    expect(h.im).toEqual([{ kind: "brief.morning", body: text }]);
    const original = h.ledger.byDedupeKey("brief:morning:1");
    expect(original?.delivery).toMatchObject({ status: "revoked", error: "resent" });
    await h.router.flushDigest();
    expect(h.im).toHaveLength(1);
  });

  test("a deferred copy is skipped until its time, then sent once as itself", async () => {
    const h = setup(at(20), {
      quietHours: { start: "23:00", end: "08:00" },
      digestSlots: ["12:00"],
    });
    await h.ledger.load();
    await h.ledger.record({
      kind: "digest",
      priority: "P2",
      dedupeKey: "defer:x",
      ruleIds: [],
      facts: { title: "你不在时", target: { kind: "owner" } },
      body: "你不在时：\n- 「A」做完了",
      decision: { outlet: "digest", reason: "deferred" },
      deferredUntil: at(24 + 9),
      deferCount: 1,
    });
    await h.router.flushDigest();
    expect(h.im).toEqual([]);
    expect(h.clock.pendingAt()).toEqual([at(24 + 9)]);
    // Not a digest slot: a deferred notice keeps its own time.
    h.clock.now = at(24 + 9);
    await h.router.flushDigest();
    expect(h.im).toEqual([{ kind: "digest", body: "你不在时：\n- 「A」做完了" }]);
    const resent = h.ledger.byDedupeKey(`again:${h.ledger.byDedupeKey("defer:x")!.id}`);
    expect(resent).toMatchObject({ deferCount: 1, delivery: { status: "accepted" } });
    await h.router.flushDigest();
    expect(h.im).toHaveLength(1);
  });
});
