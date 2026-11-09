import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  NOTICE_DEDUPE_RETENTION_MS,
  NOTICE_RESEND_WINDOW_MS,
  PetNoticeLedger,
  PetNoticeLedgerError,
  type NoticeRecord,
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

function ledger(options: { maxRecords?: number; maxBytes?: number } = {}): PetNoticeLedger {
  return new PetNoticeLedger({
    path: filePath,
    now: () => clock,
    localHourKey: plus8HourKey,
    ...options,
  });
}

function draft(
  overrides: Partial<Omit<NoticeRecord, "id" | "createdAt">> = {},
): Omit<NoticeRecord, "id" | "createdAt"> {
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
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });
});

describe("claim and settle", () => {
  test("claim freezes the body, derives a deterministic key and persists", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    const { key } = await a.claim(saved.id, "wechat", "第一版正文");
    expect(key).toBe(
      createHash("sha256").update("session.done:s1:run-1").digest("hex").slice(0, 24),
    );
    expect(key).toHaveLength(24);

    const b = ledger();
    await b.load();
    expect(b.get(saved.id)).toMatchObject({
      body: "第一版正文",
      delivery: { key, channel: "wechat", status: "claimed", attempts: 1, at: NOW },
    });

    // A resend re-claims: same key, attempts grow, the frozen body never changes.
    await b.settle(saved.id, "failed", "timeout");
    clock = NOW + 1_000;
    const again = await b.claim(saved.id, "wechat", "第二版正文");
    expect(again.key).toBe(key);
    expect(b.get(saved.id)).toMatchObject({
      body: "第一版正文",
      delivery: { status: "claimed", attempts: 2, at: NOW + 1_000 },
    });
    expect(b.get(saved.id)!.delivery!.error).toBeUndefined();
  });

  test("settle records the outcome and error, persisted", async () => {
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
      error: "socket closed",
    });
    await b.settle(saved.id, "accepted");
    expect(b.get(saved.id)!.delivery).toMatchObject({ status: "accepted" });
    expect(b.get(saved.id)!.delivery!.error).toBeUndefined();
  });

  test("an accepted or revoked notice cannot be claimed again", async () => {
    const a = ledger();
    await a.load();
    const one = await a.record(draft({ dedupeKey: "k1" }));
    await a.claim(one.id, "wechat", "x");
    await a.settle(one.id, "accepted");
    await expect(a.claim(one.id, "wechat", "x")).rejects.toMatchObject({
      code: "notice_already_settled",
    });
    const two = await a.record(draft({ dedupeKey: "k2" }));
    await a.settle(two.id, "revoked");
    await expect(a.claim(two.id, "wechat", "x")).rejects.toMatchObject({
      code: "notice_already_settled",
    });
  });

  test("queued can be set without a claim and shows in queued()", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(
      draft({
        decision: { outlet: "desktop", im: "lark", queued: true, reason: "im-unavailable-queued" },
      }),
    );
    await a.settle(saved.id, "queued");
    expect(a.get(saved.id)!.delivery).toMatchObject({
      status: "queued",
      channel: "lark",
      attempts: 0,
    });
    expect(a.queued().map((r) => r.id)).toEqual([saved.id]);
    await a.claim(saved.id, "lark", "正文");
    expect(a.queued()).toEqual([]);
  });

  test("accepted / failed / unknown require a prior claim", async () => {
    const a = ledger();
    await a.load();
    const saved = await a.record(draft());
    await expect(a.settle(saved.id, "accepted")).rejects.toMatchObject({ code: "invalid_notice" });
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
});

describe("countsThisHour", () => {
  test("counts claimed + accepted IM sends in the same local clock hour, P0 separately", async () => {
    // NOW + 8h falls at 06:13 "local"; local hour boundaries are at :00 of the shifted clock.
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
});

describe("recoverOnStartup", () => {
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
    expect([...b.seenDedupeKeys()].sort()).toEqual(["k1", "k2", "k3"]);

    // k1 was recorded at NOW, k2 at NOW + 1: exactly k1 has aged out.
    clock = NOW + NOTICE_DEDUPE_RETENTION_MS;
    expect(b.seenDedupeKeys().has("k1")).toBe(false);
    expect(b.seenDedupeKeys().has("k3")).toBe(true);
    // A write prunes expired index entries from disk.
    await b.record(draft({ dedupeKey: "k4" }));
    expect((await readDisk()).dedupe.map(([key]) => key).sort()).toEqual(["k2", "k3", "k4"]);
  });

  test("eviction never removes claimed or queued records", async () => {
    const a = ledger({ maxRecords: 2 });
    await a.load();
    const claimed = await a.record(draft({ dedupeKey: "claimed" }));
    await a.claim(claimed.id, "wechat", "x");
    clock += 1;
    const queued = await a.record(draft({ dedupeKey: "queued" }));
    await a.settle(queued.id, "queued");
    clock += 1;
    const plain = await a.record(draft({ dedupeKey: "plain" }));
    clock += 1;
    const latest = await a.record(draft({ dedupeKey: "latest" }));

    expect(a.get(claimed.id)).toBeDefined();
    expect(a.get(queued.id)).toBeDefined();
    expect(a.get(plain.id)).toBeUndefined();
    // Nothing else is evictable: the count cap is soft rather than lose a notice.
    expect(a.get(latest.id)).toBeDefined();
    const b = ledger({ maxRecords: 2 });
    await b.load();
    expect(b.get(latest.id)).toBeDefined();
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
