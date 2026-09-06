import { describe, expect, test } from "bun:test";
import { SharedTabControlStore, type TabControlBackend } from "./tab-control-shared";
import type { TabControlClaim, TabControlRecord } from "./tab-control";

function claim(over: Partial<TabControlClaim> = {}): TabControlClaim {
  return {
    tabId: "tab-1",
    holderSessionId: "s-aaa",
    mode: "control",
    turnId: "turn-1",
    browserId: "browser-1",
    expectedOrigin: "https://shop.example",
    expectedTitleHash: "hash-checkout",
    ...over,
  };
}

/**
 * A backend standing in for shared storage. `putIfAbsent` is the compare-and-set
 * every real backend must provide (Redis SETNX, a unique index, a conditional
 * write); everything else is ordinary reads and writes.
 */
function backend(now: () => number = () => 1_000): TabControlBackend & {
  rows: Map<string, TabControlRecord>;
  putIfAbsentCalls: number;
} {
  const rows = new Map<string, TabControlRecord>();
  return {
    rows,
    putIfAbsentCalls: 0,
    async get(tabId) {
      return rows.get(tabId);
    },
    async putIfAbsent(record) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).putIfAbsentCalls += 1;
      const existing = rows.get(record.tabId);
      if (existing && existing.expiresAt > now()) return false;
      rows.set(record.tabId, record);
      return true;
    },
    async replace(record) {
      rows.set(record.tabId, record);
    },
    async remove(tabId) {
      rows.delete(tabId);
    },
  };
}

describe("cross-instance exclusivity", () => {
  test("only one of two racing instances wins the tab", async () => {
    // The whole reason this store exists: with in-memory state, two server
    // instances would each grant control of the same tab and the single-writer
    // guarantee would silently break.
    const shared = backend();
    const a = new SharedTabControlStore(shared, () => 1_000);
    const b = new SharedTabControlStore(shared, () => 1_000);

    const [first, second] = await Promise.all([
      a.acquire(claim({ holderSessionId: "s-a" }), 1_000),
      b.acquire(claim({ holderSessionId: "s-b" }), 1_000),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
  });

  test("acquisition goes through compare-and-set, not read-then-write", async () => {
    // A read followed by a write has a race window between them; the backend
    // must decide atomically.
    const shared = backend();
    const store = new SharedTabControlStore(shared, () => 1_000);
    await store.acquire(claim(), 1_000);
    expect(shared.putIfAbsentCalls).toBeGreaterThan(0);
  });

  test("a lease taken on one instance is visible from another", async () => {
    const shared = backend();
    const a = new SharedTabControlStore(shared, () => 1_000);
    const b = new SharedTabControlStore(shared, () => 1_000);
    await a.acquire(claim(), 1_000);
    const denied = await b.acquire(claim({ holderSessionId: "s-other" }), 1_000);
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.reason).toBe("held");
  });

  test("the holder can renew from a different instance", async () => {
    // Sessions are not pinned to one instance, so renewal must not depend on
    // which one served the first turn.
    const shared = backend();
    const a = new SharedTabControlStore(shared, () => 1_000);
    const b = new SharedTabControlStore(shared, () => 1_000);
    await a.acquire(claim(), 1_000);
    expect((await b.acquire(claim({ turnId: "turn-2" }), 1_000)).ok).toBe(true);
  });
});

describe("expiry and validation across instances", () => {
  test("an expired lease is claimable by anyone", async () => {
    let now = 1_000;
    const shared = backend(() => now);
    const a = new SharedTabControlStore(shared, () => now);
    const b = new SharedTabControlStore(shared, () => now);
    await a.acquire(claim(), 50);
    now = 1_100;
    expect((await b.acquire(claim({ holderSessionId: "s-b" }), 50)).ok).toBe(true);
  });

  test("validation enforces the same four fields as the in-memory store", async () => {
    const shared = backend();
    const store = new SharedTabControlStore(shared, () => 1_000);
    await store.acquire(claim(), 1_000);
    const base = {
      tabId: "tab-1",
      holderSessionId: "s-aaa",
      browserId: "browser-1",
      currentOrigin: "https://shop.example",
      currentTitleHash: "hash-checkout",
    };
    expect((await store.validate(base)).ok).toBe(true);

    const moved = await store.validate({ ...base, currentOrigin: "https://evil.example" });
    expect(moved.ok === false && moved.reason).toBe("navigated");

    const restarted = await store.validate({ ...base, browserId: "browser-2" });
    expect(restarted.ok === false && restarted.reason).toBe("browser_changed");

    const stranger = await store.validate({ ...base, holderSessionId: "s-zzz" });
    expect(stranger.ok === false && stranger.reason).toBe("not_holder");
  });

  test("an unknown tab is refused rather than allowed", async () => {
    const store = new SharedTabControlStore(backend(), () => 1_000);
    const v = await store.validate({
      tabId: "never",
      holderSessionId: "s-aaa",
      browserId: "browser-1",
      currentOrigin: "https://shop.example",
      currentTitleHash: "hash-checkout",
    });
    expect(v.ok === false && v.reason).toBe("no_lease");
  });
});

describe("release and handoff across instances", () => {
  test("only the holder may release, and the row is then gone", async () => {
    const shared = backend();
    const a = new SharedTabControlStore(shared, () => 1_000);
    const b = new SharedTabControlStore(shared, () => 1_000);
    await a.acquire(claim(), 1_000);
    await b.release("tab-1", "s-impostor");
    expect(shared.rows.has("tab-1")).toBe(true);
    await b.release("tab-1", "s-aaa");
    expect(shared.rows.has("tab-1")).toBe(false);
  });

  test("handoff moves control and is refused for a non-holder", async () => {
    const shared = backend();
    const a = new SharedTabControlStore(shared, () => 1_000);
    const b = new SharedTabControlStore(shared, () => 1_000);
    await a.acquire(claim(), 1_000);

    const stolen = await b.handoff("tab-1", "s-thief", "s-thief", 1_000);
    expect(stolen.ok === false && stolen.reason).toBe("not_holder");

    const given = await b.handoff("tab-1", "s-aaa", "s-bbb", 1_000);
    expect(given.ok).toBe(true);
    expect(shared.rows.get("tab-1")?.holderSessionId).toBe("s-bbb");
  });
});
