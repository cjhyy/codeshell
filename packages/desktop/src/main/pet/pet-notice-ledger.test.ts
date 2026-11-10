import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  NOTICE_DEDUPE_RETENTION_MS,
  NOTICE_QUARANTINE_SIDECARS_KEPT,
  NOTICE_QUEUED_TTL_MS,
  NOTICE_RESEND_WINDOW_MS,
  PetNoticeLedger,
  PetNoticeLedgerError,
  newNoticeRecordId,
  type NoticeDeliveryStatus,
  type NoticeRecord,
  type NoticeRecordInput,
} from "./pet-notice-ledger.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;

let dir: string;
let filePath: string;
let clock = NOW;

/** Deterministic "local" hours: UTC hours shifted by +8h, independent of the test machine. */
function plus8HourKey(ms: number): string {
  return String(Math.floor((ms + 8 * HOUR) / HOUR));
}

function ledger(
  options: {
    maxRecords?: number;
    maxBytes?: number;
    maxDedupeEntries?: number;
    localHourKey?: (ms: number) => string;
  } = {},
): PetNoticeLedger {
  return new PetNoticeLedger({
    path: filePath,
    now: () => clock,
    localHourKey: plus8HourKey,
    ...options,
  });
}

function draft(overrides: Partial<NoticeRecordInput> = {}): NoticeRecordInput {
  return {
    kind: "session.done",
    priority: "P1",
    dedupeKey: "session.done:s1:run-1",
    sessionId: "s1",
    ruleIds: ["rule-1"],
    facts: { title: "登录页", summary: "done" },
    decision: { outlet: "both", im: "wechat", reason: "named-im" },
    ...overrides,
  };
}

function hex24(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function readDisk(): Promise<{
  version: number;
  records: NoticeRecord[];
  dedupe: Array<[string, number]>;
  quarantine: unknown[];
}> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

beforeEach(async () => {
  clock = NOW;
  dir = await mkdtemp(join(tmpdir(), "pet-notice-ledger-"));
  filePath = join(dir, "pet", "notices.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("flush", () => {
  test("waits for queued writes", async () => {
    const a = ledger();
    await a.load();
    void a.record(draft());
    void a.record(draft({ dedupeKey: "session.done:s1:run-2" }));
    await a.flush();
    expect((await readDisk()).records).toHaveLength(2);
  });
});

describe("record", () => {
  test("persists before resolving, so a second instance reads it", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    expect(saved.id).toMatch(/^notice-[0-9a-f-]{36}$/u);
    expect(saved.createdAt).toBe(NOW);

    const b = ledger();
    await b.load();
    expect(b.get(saved.id)).toEqual(saved);
    expect(b.seenDedupeKeys().has("session.done:s1:run-1")).toBe(true);
    expect(b.seenDedupeKeys().has("session.done:s1:run-2")).toBe(false);
  });

  test("writes compact JSON: rewritten on every notice, so no indentation", async () => {
    const a = ledger();
    await a.record(draft());
    const text = await readFile(filePath, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.slice(0, -1)).not.toContain("\n");
  });

  test("the dedupe index stores hashes, not raw keys", async () => {
    const a = ledger();
    await a.load();
    await a.record(draft({ dedupeKey: "secret-ish:key" }));
    const disk = await readDisk();
    expect(disk.dedupe).toEqual([[hex24("secret-ish:key"), NOW]]);
    expect(JSON.stringify(disk.dedupe)).not.toContain("secret-ish");
  });

  test("returns copies; callers cannot mutate ledger state", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    saved.ruleIds.push("evil");
    a.get(saved.id)!.ruleIds.push("evil");
    expect(a.get(saved.id)!.ruleIds).toEqual(["rule-1"]);
  });

  test("rejects an invalid record without writing", async () => {
    const a = ledger();
    await a.load();
    await expect(a.record(draft({ priority: "P9" as "P0" }))).rejects.toMatchObject({
      code: "invalid_notice",
    });
    await expect(
      a.record(draft({ delivery: { status: "accepted" as "held" } })),
    ).rejects.toMatchObject({ code: "invalid_notice" });
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  test("a caller-chosen record id is used once, and only in the ledger's own format", async () => {
    const a = ledger();
    const id = newNoticeRecordId();
    expect((await a.record(draft(), { id })).id).toBe(id);
    expect(a.get(id)?.delivery).toBeUndefined();
    await expect(a.record(draft({ dedupeKey: "again" }), { id })).rejects.toMatchObject({
      code: "invalid_notice",
    });
    await expect(a.record(draft({ dedupeKey: "bad" }), { id: "../x" })).rejects.toMatchObject({
      code: "invalid_notice",
    });
  });

  test("a digest decision starts held; a queued decision starts queued with a 24 h expiry", async () => {
    const a = ledger();
    await a.load();
    const held = await a.record(
      draft({ dedupeKey: "h", decision: { outlet: "digest", reason: "quiet-hours" } }),
    );
    expect(held.delivery).toEqual({ key: hex24(held.id), status: "held", attempts: 0, at: NOW });
    const queued = await a.record(
      draft({
        dedupeKey: "q",
        decision: { outlet: "desktop", im: "lark", queued: true, reason: "im-unavailable-queued" },
      }),
    );
    expect(queued.delivery).toMatchObject({ status: "queued", channel: "lark", attempts: 0 });
    expect(queued.expiresAt).toBe(NOW + NOTICE_QUEUED_TTL_MS);
    // Distinct createdAt so queued() order (oldest first) is deterministic.
    clock = NOW + 1;
    const explicit = await a.record(
      draft({ dedupeKey: "e", expiresAt: NOW + 5, delivery: { status: "queued", channel: "x" } }),
    );
    expect(explicit.expiresAt).toBe(NOW + 5);
    expect(a.queued().map((r) => r.id)).toEqual([queued.id, explicit.id]);
  });

  test("held() lists digest-held records oldest first", async () => {
    const a = ledger();
    await a.load();
    const first = await a.record(
      draft({ dedupeKey: "h1", decision: { outlet: "digest", reason: "quiet-hours" } }),
    );
    clock = NOW + 1;
    const second = await a.record(draft({ dedupeKey: "h2", delivery: { status: "held" } }));
    await a.record(draft({ dedupeKey: "plain" }));
    expect(a.held().map((r) => r.id)).toEqual([first.id, second.id]);
    await a.settle(first.id, "revoked", "digested");
    expect(a.held().map((r) => r.id)).toEqual([second.id]);
  });

  test("a drop decision does not touch the dedupe index", async () => {
    const a = ledger();
    await a.load();
    await a.record(
      draft({ dedupeKey: "dropped", decision: { outlet: "drop", reason: "duplicate" } }),
    );
    expect(a.seenDedupeKeys().has("dropped")).toBe(false);
  });

  test("a repeated key does not extend its dedupe entry", async () => {
    const a = ledger();
    await a.load();
    await a.record(draft({ dedupeKey: "k" }));
    clock = NOW + 6 * 24 * HOUR;
    await a.record(draft({ dedupeKey: "k" }));
    clock = NOW + NOTICE_DEDUPE_RETENTION_MS;
    expect(a.seenDedupeKeys().has("k")).toBe(false);
    // Once expired, the next record starts a fresh window.
    await a.record(draft({ dedupeKey: "k" }));
    expect(a.seenDedupeKeys().has("k")).toBe(true);
  });
});

describe("claim and settle", () => {
  test("claim freezes the body, derives the key from the record id and persists", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    const twin = await a.record(draft());
    const { key } = await a.claim(saved.id, "wechat", "第一版正文");
    expect(key).toBe(hex24(saved.id));
    expect((await a.claim(twin.id, "wechat", "x")).key).not.toBe(key);

    const b = ledger();
    await b.load();
    expect(b.get(saved.id)).toMatchObject({
      body: "第一版正文",
      delivery: { key, channel: "wechat", status: "claimed", attempts: 1, at: NOW, claimedAt: NOW },
    });

    // A resend re-claims: same key, attempts grow, the frozen body never changes.
    await b.settle(saved.id, "failed", "timeout");
    clock = NOW + 1_000;
    const again = await b.claim(saved.id, "wechat", "第二版正文");
    expect(again.key).toBe(key);
    expect(b.get(saved.id)).toMatchObject({
      body: "第一版正文",
      delivery: { status: "claimed", attempts: 2, at: NOW + 1_000, claimedAt: NOW + 1_000 },
    });
    expect(b.get(saved.id)!.delivery!.error).toBeUndefined();
  });

  test("settle records the outcome and error, persisted, and keeps the claim time", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    await a.claim(saved.id, "wechat", "正文");
    clock = NOW + 500;
    await a.settle(saved.id, "unknown", "socket closed");

    const b = ledger();
    await b.load();
    expect(b.get(saved.id)!.delivery).toMatchObject({
      status: "unknown",
      attempts: 1,
      at: NOW + 500,
      claimedAt: NOW,
      error: "socket closed",
    });
  });

  test("settling queued without an expiry sets a 24 h default", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    await a.claim(saved.id, "wechat", "x");
    clock = NOW + 1_000;
    await a.settle(saved.id, "queued", "gateway down");
    expect(a.get(saved.id)).toMatchObject({
      expiresAt: NOW + 1_000 + NOTICE_QUEUED_TTL_MS,
      delivery: { status: "queued", channel: "wechat", attempts: 1 },
    });
  });

  test("unknown ids are rejected", async () => {
    const a = ledger();
    await a.load();
    await expect(a.claim("notice-missing", "wechat", "x")).rejects.toBeInstanceOf(
      PetNoticeLedgerError,
    );
    await expect(a.settle("notice-missing", "accepted")).rejects.toMatchObject({
      code: "notice_not_found",
    });
  });

  describe("transition table", () => {
    type From = NoticeDeliveryStatus | "none";
    type To = NoticeDeliveryStatus;
    const ops: To[] = ["claimed", "accepted", "failed", "unknown", "queued", "held", "revoked"];
    const ok = "ok";
    const bad = "invalid_transition";
    const fin = "notice_already_settled";
    // Independent copy of the table documented in pet-notice-ledger.ts.
    const table: Record<From, string[]> = {
      none: [ok, bad, bad, bad, ok, ok, ok],
      // held → accepted: an outbox send that expired into the digest, delivered after all.
      held: [ok, ok, bad, bad, ok, ok, ok],
      queued: [ok, bad, bad, bad, ok, ok, ok],
      failed: [ok, bad, bad, bad, ok, ok, ok],
      claimed: [ok, ok, ok, ok, ok, bad, ok],
      // Plain claim() never retries an unknown; see the manualRetry test.
      unknown: [bad, bad, bad, bad, bad, bad, ok],
      accepted: [fin, fin, fin, fin, fin, fin, fin],
      revoked: [fin, fin, fin, fin, fin, fin, fin],
    };

    async function reach(a: PetNoticeLedger, from: From): Promise<string> {
      const { id } = await a.record(draft({ dedupeKey: `${from}-${Math.random()}` }));
      if (from === "none") return id;
      if (from === "held" || from === "queued" || from === "revoked") {
        await a.settle(id, from);
        return id;
      }
      await a.claim(id, "wechat", "x");
      if (from !== "claimed") await a.settle(id, from);
      return id;
    }

    for (const [from, row] of Object.entries(table) as Array<[From, string[]]>) {
      for (const [index, to] of ops.entries()) {
        const expected = row[index]!;
        test(`${from} → ${to}: ${expected}`, async () => {
          const a = ledger();
          await a.load();
          const id = await reach(a, from);
          const before = a.get(id);
          const attempt =
            to === "claimed" ? a.claim(id, "wechat", "x").then(() => undefined) : a.settle(id, to);
          if (expected === ok) {
            await attempt;
            expect(a.get(id)!.delivery!.status).toBe(to);
          } else {
            await expect(attempt).rejects.toMatchObject({ code: expected });
            expect(a.get(id)).toEqual(before!);
          }
        });
      }
    }
  });
});

describe("manual retry of an unknown delivery", () => {
  test("only claim(..., { manualRetry: true }) resends an unknown notice", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    const { key } = await a.claim(saved.id, "wechat", "正文");
    await a.settle(saved.id, "unknown", "socket closed");

    await expect(a.claim(saved.id, "wechat", "正文")).rejects.toMatchObject({
      code: "invalid_transition",
    });
    await expect(a.claim(saved.id, "wechat", "正文", { manualRetry: false })).rejects.toMatchObject(
      { code: "invalid_transition" },
    );
    expect(a.get(saved.id)!.delivery).toMatchObject({ status: "unknown", attempts: 1 });

    clock = NOW + 1_000;
    const retry = await a.claim(saved.id, "lark", "改过的正文", { manualRetry: true });
    expect(retry.key).toBe(key);
    expect(a.get(saved.id)).toMatchObject({
      body: "正文",
      delivery: { status: "claimed", channel: "lark", attempts: 2, claimedAt: NOW + 1_000 },
    });
  });

  test("manualRetry does not unlock final states", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    await a.claim(saved.id, "wechat", "x");
    await a.settle(saved.id, "accepted");
    await expect(a.claim(saved.id, "wechat", "x", { manualRetry: true })).rejects.toMatchObject({
      code: "notice_already_settled",
    });
  });
});

describe("countsThisHour", () => {
  test("counts claimed + accepted IM sends in the same local clock hour, P0 separately", async () => {
    const hourStart = Math.floor((NOW + 8 * HOUR) / HOUR) * HOUR - 8 * HOUR;
    const a = ledger();
    await a.load();

    async function sent(
      key: string,
      at: number,
      priority: "P0" | "P1" | "P2",
      status: "claimed" | "accepted" | "failed" | "unknown",
      channel = "wechat",
    ): Promise<void> {
      clock = at;
      const r = await a.record(draft({ dedupeKey: key, priority }));
      await a.claim(r.id, channel, "x");
      if (status !== "claimed") await a.settle(r.id, status);
    }

    await sent("a", hourStart + 1_000, "P1", "accepted");
    await sent("b", hourStart + 2_000, "P2", "claimed");
    await sent("c", hourStart + 3_000, "P0", "accepted");
    await sent("d", hourStart + 4_000, "P1", "failed");
    await sent("e", hourStart + 5_000, "P1", "unknown");
    await sent("f", hourStart + 6_000, "P1", "accepted", "desktop");
    await sent("g", hourStart - 1_000, "P1", "accepted"); // previous local hour
    await sent("h", hourStart + HOUR, "P0", "accepted"); // next local hour

    expect(a.countsThisHour(hourStart + 30 * 60_000)).toEqual({ sent: 2, p0Sent: 1 });
    expect(a.countsThisHour(hourStart - 1)).toEqual({ sent: 1, p0Sent: 0 });
    expect(a.countsThisHour(hourStart + HOUR)).toEqual({ sent: 0, p0Sent: 1 });
  });

  test("buckets by claim time, not settle time", async () => {
    const hourStart = Math.floor((NOW + 8 * HOUR) / HOUR) * HOUR - 8 * HOUR;
    const a = ledger();
    await a.load();
    clock = hourStart + HOUR - 1_000;
    const r = await a.record(draft());
    await a.claim(r.id, "wechat", "x");
    clock = hourStart + HOUR + 1_000;
    await a.settle(r.id, "accepted");
    expect(a.countsThisHour(hourStart + 30 * 60_000)).toEqual({ sent: 1, p0Sent: 0 });
    expect(a.countsThisHour(hourStart + HOUR + 30 * 60_000)).toEqual({ sent: 0, p0Sent: 0 });
  });

  describe("default local hour key across DST", () => {
    const hostZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    beforeEach(() => {
      process.env.TZ = "America/New_York";
    });
    afterEach(() => {
      // Bun stops tracking TZ once it is deleted, so restore by reassigning.
      process.env.TZ = hostZone;
    });

    async function claimAt(a: PetNoticeLedger, at: number, key: string): Promise<void> {
      clock = at;
      const r = await a.record(draft({ dedupeKey: key }));
      await a.claim(r.id, "wechat", "x");
    }

    test("spring-forward: 01:30 EST and 03:30 EDT are different hours", async () => {
      const a = new PetNoticeLedger({ path: filePath, now: () => clock });
      await a.load();
      await claimAt(a, Date.UTC(2026, 2, 8, 6, 30), "before");
      expect(a.countsThisHour(Date.UTC(2026, 2, 8, 6, 59))).toEqual({ sent: 1, p0Sent: 0 });
      expect(a.countsThisHour(Date.UTC(2026, 2, 8, 7, 30))).toEqual({ sent: 0, p0Sent: 0 });
    });

    test("fall-back: the repeated 01:00 wall-clock hour shares one budget", async () => {
      const a = new PetNoticeLedger({ path: filePath, now: () => clock });
      await a.load();
      await claimAt(a, Date.UTC(2026, 10, 1, 5, 30), "edt"); // 01:30 EDT
      await claimAt(a, Date.UTC(2026, 10, 1, 6, 10), "est"); // 01:10 EST
      expect(a.countsThisHour(Date.UTC(2026, 10, 1, 6, 45))).toEqual({ sent: 2, p0Sent: 0 });
      expect(a.countsThisHour(Date.UTC(2026, 10, 1, 7, 15))).toEqual({ sent: 0, p0Sent: 0 });
    });
  });
});

describe("recoverOnStartup and expiry", () => {
  test("recent claims come back for resend; stale claims become unknown", async () => {
    const a = ledger();
    await a.load();
    const recent = await a.record(draft({ dedupeKey: "recent" }));
    await a.claim(recent.id, "wechat", "recent body");
    clock = NOW - NOTICE_RESEND_WINDOW_MS - 1;
    const stale = await a.record(draft({ dedupeKey: "stale" }));
    await a.claim(stale.id, "wechat", "stale body");
    clock = NOW;
    const done = await a.record(draft({ dedupeKey: "done" }));
    await a.claim(done.id, "wechat", "done body");
    await a.settle(done.id, "accepted");

    const b = ledger();
    await b.load();
    const resend = await b.recoverOnStartup(NOW + 60_000);
    expect(resend.map((r) => r.id)).toEqual([recent.id]);
    expect(resend[0]).toEqual(a.get(recent.id)!);
    expect(b.get(recent.id)!.delivery!.status).toBe("claimed");
    expect(b.get(stale.id)!.delivery!.status).toBe("unknown");
    expect(b.get(done.id)!.delivery!.status).toBe("accepted");

    const c = ledger();
    await c.load();
    expect(c.get(stale.id)!.delivery!.status).toBe("unknown");
  });

  test("recovery is serialised with a concurrent settle", async () => {
    const a = ledger();
    await a.load();
    const recent = await a.record(draft({ dedupeKey: "recent" }));
    await a.claim(recent.id, "wechat", "x");
    clock = NOW - NOTICE_RESEND_WINDOW_MS - 1;
    const stale = await a.record(draft({ dedupeKey: "stale" }));
    await a.claim(stale.id, "wechat", "x");
    clock = NOW;

    // Both settles are queued before recovery runs; recovery must see them.
    const settles = [a.settle(recent.id, "accepted"), a.settle(stale.id, "accepted")];
    const resend = await a.recoverOnStartup(NOW + 1_000);
    await Promise.all(settles);
    expect(resend).toEqual([]);
    expect(a.get(recent.id)!.delivery!.status).toBe("accepted");
    expect(a.get(stale.id)!.delivery!.status).toBe("accepted");
  });

  test("expireQueued revokes expired queued notices only, and recovery runs it", async () => {
    const a = ledger();
    await a.load();
    const expiring = await a.record(
      draft({ dedupeKey: "q1", delivery: { status: "queued", channel: "lark" } }),
    );
    const later = await a.record(
      draft({
        dedupeKey: "q2",
        expiresAt: NOW + 2 * NOTICE_QUEUED_TTL_MS,
        delivery: { status: "queued" },
      }),
    );
    const held = await a.record(
      draft({ dedupeKey: "h", expiresAt: NOW + 1, delivery: { status: "held" } }),
    );

    expect(await a.expireQueued(NOW + NOTICE_QUEUED_TTL_MS - 1)).toEqual([]);
    const revoked = await a.expireQueued(NOW + NOTICE_QUEUED_TTL_MS);
    expect(revoked.map((r) => r.id)).toEqual([expiring.id]);
    expect(a.get(expiring.id)!.delivery).toMatchObject({ status: "revoked", error: "expired" });
    expect(a.get(held.id)!.delivery!.status).toBe("held");

    const b = ledger();
    await b.load();
    await b.recoverOnStartup(NOW + 2 * NOTICE_QUEUED_TTL_MS);
    expect(b.get(later.id)!.delivery!.status).toBe("revoked");
    expect(b.get(held.id)!.delivery!.status).toBe("held");
  });

  test("recovery with nothing to change does not write", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const future = JSON.stringify({ version: 99, records: [], dedupe: [], quarantine: [] });
    await writeFile(filePath, future);
    const a = ledger();
    await a.load();
    expect(await a.recoverOnStartup(NOW)).toEqual([]);
    expect(await readFile(filePath, "utf8")).toBe(future);
  });
});

describe("dedupe retention and eviction", () => {
  test("evicted records keep their dedupe key for 7 days", async () => {
    const a = ledger({ maxRecords: 2 });
    await a.load();
    const first = await a.record(draft({ dedupeKey: "k1" }));
    clock += 1;
    await a.record(draft({ dedupeKey: "k2" }));
    clock += 1;
    await a.record(draft({ dedupeKey: "k3" }));
    expect(a.get(first.id)).toBeUndefined();

    const b = ledger({ maxRecords: 2 });
    await b.load();
    for (const key of ["k1", "k2", "k3"]) expect(b.seenDedupeKeys().has(key)).toBe(true);

    // k1 was recorded at NOW, k2 at NOW + 1: exactly k1 has aged out.
    clock = NOW + NOTICE_DEDUPE_RETENTION_MS;
    expect(b.seenDedupeKeys().has("k1")).toBe(false);
    expect(b.seenDedupeKeys().has("k3")).toBe(true);
    // A write prunes expired index entries from disk.
    await b.record(draft({ dedupeKey: "k4" }));
    expect((await readDisk()).dedupe.map(([hash]) => hash).sort()).toEqual(
      ["k2", "k3", "k4"].map(hex24).sort(),
    );
  });

  test("eviction never removes claimed, queued or held records", async () => {
    const a = ledger({ maxRecords: 2 });
    await a.load();
    const claimed = await a.record(draft({ dedupeKey: "claimed" }));
    await a.claim(claimed.id, "wechat", "x");
    clock += 1;
    const queued = await a.record(draft({ dedupeKey: "queued" }));
    await a.settle(queued.id, "queued");
    clock += 1;
    const held = await a.record(
      draft({ dedupeKey: "held", decision: { outlet: "digest", reason: "hourly-cap" } }),
    );
    clock += 1;
    const plain = await a.record(draft({ dedupeKey: "plain" }));
    clock += 1;
    const latest = await a.record(draft({ dedupeKey: "latest" }));

    expect(a.get(claimed.id)).toBeDefined();
    expect(a.get(queued.id)).toBeDefined();
    expect(a.get(held.id)).toBeDefined();
    expect(a.get(plain.id)).toBeUndefined();
    // Nothing else is evictable: the count cap is soft rather than lose a notice.
    expect(a.get(latest.id)).toBeDefined();
    const b = ledger({ maxRecords: 2 });
    await b.load();
    expect(b.get(latest.id)).toBeDefined();
  });

  test("the byte cap evicts oldest terminal records", async () => {
    const a = ledger({ maxBytes: 4_000 });
    await a.load();
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      clock = NOW + i;
      ids.push((await a.record(draft({ dedupeKey: `k${i}`, body: "x".repeat(200) }))).id);
    }
    expect(a.get(ids[0]!)).toBeUndefined();
    expect(a.get(ids[11]!)).toBeDefined();
    const bytes = Buffer.byteLength(await readFile(filePath, "utf8"));
    expect(bytes).toBeLessThanOrEqual(4_000);
    expect(a.seenDedupeKeys().has("k0")).toBe(true);
  });

  test("a full dedupe index is compacted before the ledger reports full", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const dedupe = Array.from({ length: 80 }, (_, i) => [hex24(`old-${i}`), NOW - 1_000 + i]);
    await writeFile(filePath, JSON.stringify({ version: 1, records: [], dedupe, quarantine: [] }));
    const a = ledger({ maxBytes: 4_000 });
    await a.load();
    const saved = await a.record(draft({ dedupeKey: "new", body: "x".repeat(1_500) }));
    expect(a.get(saved.id)).toBeDefined();
    expect(a.seenDedupeKeys().has("new")).toBe(true);
    // The oldest entries went first; the newest survived.
    expect(a.seenDedupeKeys().has("old-0")).toBe(false);
    expect(a.seenDedupeKeys().has("old-79")).toBe(true);
    expect(Buffer.byteLength(await readFile(filePath, "utf8"))).toBeLessThanOrEqual(4_000);
  });

  test("the dedupe count cap never drops hashes of records still in the ledger", async () => {
    const a = ledger({ maxDedupeEntries: 3 });
    await a.load();
    // Oldest first: kept-1 and kept-2 stay as records, so their hashes must survive.
    const kept1 = await a.record(draft({ dedupeKey: "kept-1" }));
    clock += 1;
    const kept2 = await a.record(draft({ dedupeKey: "kept-2" }));
    // Index-only entries (no record) are written straight to disk.
    const disk = await readDisk();
    disk.dedupe.push([hex24("orphan-old"), NOW + 2], [hex24("orphan-new"), NOW + 3]);
    await writeFile(filePath, JSON.stringify(disk));

    clock = NOW + 10;
    const b = ledger({ maxDedupeEntries: 3 });
    await b.load();
    await b.record(draft({ dedupeKey: "fresh" }));
    for (const key of ["kept-1", "kept-2", "fresh"]) expect(b.seenDedupeKeys().has(key)).toBe(true);
    expect(b.seenDedupeKeys().has("orphan-old")).toBe(false);
    expect(b.seenDedupeKeys().has("orphan-new")).toBe(false);
    expect(b.get(kept1.id)).toBeDefined();
    expect(b.get(kept2.id)).toBeDefined();
    expect((await readDisk()).dedupe).toHaveLength(3);
  });

  test("the dedupe count cap may be exceeded by kept records rather than forget them", async () => {
    const a = ledger({ maxDedupeEntries: 1 });
    await a.load();
    await a.record(draft({ dedupeKey: "k1" }));
    clock += 1;
    await a.record(draft({ dedupeKey: "k2" }));
    expect(a.seenDedupeKeys().has("k1")).toBe(true);
    expect(a.seenDedupeKeys().has("k2")).toBe(true);
  });

  test("only the newest quarantine sidecars are kept", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const folder = dirname(filePath);
    const uuid = "00000000-0000-4000-8000-000000000000";
    const old = Array.from({ length: 6 }, (_, i) => `notices.quarantine.${1_000 + i}.${uuid}.json`);
    for (const name of old) await writeFile(join(folder, name), "{}");
    // Unrelated neighbours must never be touched.
    const unrelated = ["notices.json.1.corrupt", `other.quarantine.1.${uuid}.json`];
    for (const name of unrelated) await writeFile(join(folder, name), "{}");
    const quarantine = [{ id: "future", blob: "z".repeat(900) }];
    await writeFile(filePath, JSON.stringify({ version: 1, records: [], dedupe: [], quarantine }));

    const a = ledger({ maxBytes: 2_000 });
    await a.load();
    await a.record(draft({ body: "x".repeat(1_000) }));

    const names = await readdir(folder);
    const sidecars = names.filter((name) => name.startsWith("notices.quarantine.")).sort();
    expect(sidecars).toHaveLength(NOTICE_QUARANTINE_SIDECARS_KEPT);
    // The newly written sidecar survives, plus the four newest old ones.
    expect(sidecars.filter((name) => old.includes(name))).toEqual(old.slice(2));
    const fresh = sidecars.find((name) => !old.includes(name))!;
    expect(JSON.parse(await readFile(join(folder, fresh), "utf8")).rows).toEqual(quarantine);
    for (const name of unrelated) expect(names).toContain(name);
  });

  test("an oversized quarantine moves to a sidecar before the ledger reports full", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const quarantine = [0, 1, 2].map((i) => ({ id: `future-${i}`, blob: "z".repeat(900) }));
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, records: [], dedupe: [], quarantine }, null, 2),
    );
    const a = ledger({ maxBytes: 4_000 });
    await a.load();
    const saved = await a.record(draft({ body: "x".repeat(1_500) }));
    expect(a.get(saved.id)).toBeDefined();

    const disk = await readDisk();
    const sidecars = (await readdir(dirname(filePath))).filter((name) =>
      name.startsWith("notices.quarantine."),
    );
    expect(sidecars).toHaveLength(1);
    const moved = JSON.parse(await readFile(join(dirname(filePath), sidecars[0]!), "utf8"));
    // Nothing is lost: the oldest rows moved out, the rest stayed, in order.
    expect([...moved.rows, ...disk.quarantine]).toEqual(quarantine);
    expect(moved.rows.length).toBeGreaterThan(0);
  });

  test("the byte cap is hard once only live deliveries remain", async () => {
    const a = ledger({ maxBytes: 2_000 });
    await a.load();
    const claimed = await a.record(draft({ dedupeKey: "claimed" }));
    await a.claim(claimed.id, "wechat", "x".repeat(800));
    await expect(
      a.record(draft({ dedupeKey: "next", body: "y".repeat(1_200) })),
    ).rejects.toMatchObject({ code: "notice_ledger_full" });
    expect(a.get(claimed.id)).toBeDefined();
    expect(a.seenDedupeKeys().has("next")).toBe(false);
  });
});

describe("load", () => {
  test("unknown rows are quarantined and written back unchanged", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    const disk = await readDisk();
    const unknownRow = { id: "notice-future", kind: "session.done", hologram: true };
    await writeFile(filePath, JSON.stringify({ ...disk, records: [...disk.records, unknownRow] }));

    const b = ledger();
    await b.load();
    expect(b.get(saved.id)).toBeDefined();
    expect(b.get("notice-future")).toBeUndefined();
    await b.record(draft({ dedupeKey: "k2" }));
    const after = await readDisk();
    expect(after.quarantine).toEqual([unknownRow]);
    expect(after.records.map((r) => r.id)).not.toContain("notice-future");
  });

  test("a duplicate id keeps the first row and quarantines the other", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    const disk = await readDisk();
    const copy = { ...disk.records[0]!, body: "copy" };
    await writeFile(filePath, JSON.stringify({ ...disk, records: [disk.records[0], copy] }));
    const b = ledger();
    await b.load();
    expect(b.get(saved.id)!.body).toBeUndefined();
    await b.record(draft({ dedupeKey: "k2" }));
    expect((await readDisk()).quarantine).toEqual([copy]);
  });

  test("a corrupt file is moved aside and the ledger starts empty", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "{ not json");
    const a = ledger();
    await a.load();
    expect(a.queued()).toEqual([]);
    const siblings = await readdir(dirname(filePath));
    const corrupt = siblings.filter((name) => name.endsWith(".corrupt"));
    expect(corrupt).toHaveLength(1);
    expect(await readFile(join(dirname(filePath), corrupt[0]!), "utf8")).toBe("{ not json");
  });

  test("a newer schema is left untouched and writes are refused", async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const future = JSON.stringify({ version: 99, records: [], dedupe: [], quarantine: [] });
    await writeFile(filePath, future);
    const a = ledger();
    await a.load();
    await expect(a.record(draft())).rejects.toMatchObject({ code: "notice_ledger_unwritable" });
    expect(await readFile(filePath, "utf8")).toBe(future);
  });

  test("writes are serialised in-process", async () => {
    const a = ledger();
    await a.load();
    const saved = await Promise.all(
      Array.from({ length: 20 }, (_, i) => a.record(draft({ dedupeKey: `k${i}` }))),
    );
    const b = ledger();
    await b.load();
    for (const r of saved) expect(b.get(r.id)).toBeDefined();
  });
});

describe("decision prompts", () => {
  const prompted = (overrides: Partial<NoticeRecordInput> = {}) =>
    draft({
      kind: "session.blocked",
      priority: "P0",
      dedupeKey: "s1:req-1",
      requestId: "req-1",
      decision: { outlet: "desktop", reason: "present-desktop" },
      prompt: {
        code: "0123456789AB",
        deadline: NOW + 600_000,
        replies: ["拒绝", "允许本次", "拒绝"],
      },
      ...overrides,
    });

  test("a prompt starts on the desktop and moves forward only, persisted", async () => {
    const first = ledger();
    const record = await first.record(prompted());
    expect(record.prompt).toEqual({
      code: "0123456789AB",
      phase: "desktop",
      deadline: NOW + 600_000,
      replies: ["拒绝", "允许本次"],
    });
    await first.updatePrompt(record.id, { phase: "escalated", escalatedAt: NOW + 1 });
    await first.updatePrompt(record.id, { phase: "im", channel: "wechat", imAt: NOW + 2 });
    await expect(first.updatePrompt(record.id, { phase: "desktop" })).rejects.toMatchObject({
      code: "invalid_transition",
    });
    await first.updatePrompt(record.id, {
      phase: "expired",
      endedAt: NOW + 3,
      expiryNotice: { channel: "wechat", sent: false },
    });
    // An ended prompt keeps its phase; its owed notice can still be settled.
    await first.updatePrompt(record.id, { expiryNotice: { channel: "wechat", sent: true } });
    await expect(first.updatePrompt(record.id, { phase: "answered" })).rejects.toMatchObject({
      code: "invalid_transition",
    });
    const reread = ledger();
    await reread.load();
    expect(reread.byPromptCode("0123456789AB")?.prompt).toMatchObject({
      phase: "expired",
      channel: "wechat",
      escalatedAt: NOW + 1,
      expiryNotice: { channel: "wechat", sent: true },
    });
    expect(reread.forRequest("s1", "req-1").map((row) => row.id)).toEqual([record.id]);
  });

  test("only prompt records can be updated, and the code never changes", async () => {
    const store = ledger();
    const plain = await store.record(draft());
    await expect(store.updatePrompt(plain.id, { phase: "im" })).rejects.toMatchObject({
      code: "notice_not_found",
    });
    const record = await store.record(prompted());
    await expect(
      store.updatePrompt(record.id, { code: "BA9876543210" } as never),
    ).rejects.toMatchObject({ code: "invalid_notice" });
  });

  test("an unreadable prompt loads as a plain notice; an older record loads unchanged", async () => {
    const store = ledger();
    const record = await store.record(prompted());
    const older = await store.record(draft({ dedupeKey: "older" }));
    const disk = await readDisk();
    disk.records[0] = {
      ...disk.records[0]!,
      prompt: { code: "x", phase: "from-the-future" } as never,
    };
    await writeFile(filePath, JSON.stringify(disk));
    const reread = ledger();
    await reread.load();
    expect(reread.get(record.id)).toMatchObject({ kind: "session.blocked", requestId: "req-1" });
    expect(reread.get(record.id)?.prompt).toBeUndefined();
    expect(reread.get(older.id)).toEqual(older);
    expect(reread.prompts()).toEqual([]);
  });

  test("an open prompt is never evicted; an ended one may be", async () => {
    const store = ledger({ maxRecords: 1 });
    const open = await store.record(prompted());
    clock += 1;
    await store.record(draft({ dedupeKey: "a", decision: { outlet: "desktop", reason: "x" } }));
    expect(store.get(open.id)).toBeDefined();
    await store.updatePrompt(open.id, { phase: "answered", endedAt: clock });
    clock += 1;
    await store.record(draft({ dedupeKey: "b", decision: { outlet: "desktop", reason: "x" } }));
    expect(store.get(open.id)).toBeUndefined();
  });
});
