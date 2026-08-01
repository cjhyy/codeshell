/**
 * One loopback MCP bridge serves every concurrent Codex thread, so the store
 * that maps `threadId -> SessionToolHost` is the thing standing between two
 * sessions and cross-talk. §11.3 spells out the rules; these tests pin them.
 *
 * Every miss is fail-closed. There is deliberately no "use the foreground
 * session", no "most recent thread", and no reading identity out of tool
 * arguments — §22.4/§22.5 reject all three, because a model can influence
 * arguments but not `_meta`.
 */
import { describe, expect, test } from "bun:test";
import { SessionContextStore } from "./session-context-store.js";

/** Minimal stand-in; the store only ever holds and returns these. */
function fakeHost(id: string) {
  return { businessSessionId: id } as never;
}

describe("SessionContextStore", () => {
  test("resolves a registered thread to its own host", () => {
    const store = new SessionContextStore();
    const a = fakeHost("sess-a");
    const b = fakeHost("sess-b");
    store.register("thread-a", a);
    store.register("thread-b", b);

    expect(store.resolve({ threadId: "thread-a", generation: 1 })).toEqual({ ok: true, host: a });
    expect(store.resolve({ threadId: "thread-b", generation: 1 })).toEqual({ ok: true, host: b });
  });

  test("fails closed on a missing thread id", () => {
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-a"));
    const result = store.resolve({ threadId: undefined, generation: 1 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("missing_thread_id");
  });

  test("fails closed on an unregistered thread, even when exactly one is registered", () => {
    // The single-session case is the tempting one to "helpfully" guess at.
    // §11.3 forbids it: guessing is what turns a background run into a
    // cross-session write.
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-a"));
    const result = store.resolve({ threadId: "thread-zzz", generation: 1 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unknown_thread");
  });

  test("fails closed after the thread is unregistered", () => {
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-a"));
    store.unregister("thread-a");
    const result = store.resolve({ threadId: "thread-a", generation: 1 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unknown_thread");
  });

  test("generation fencing rejects a late request from a previous app-server", () => {
    // An app-server restart re-registers threads under a new generation. A
    // request still in flight from the old process must not land on the new
    // host — §13.6 calls for exactly this fence.
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-old"));
    store.bumpGeneration();
    store.register("thread-a", fakeHost("sess-new"));

    const stale = store.resolve({ threadId: "thread-a", generation: 1 });
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.reason).toBe("stale_generation");

    const fresh = store.resolve({ threadId: "thread-a", generation: 2 });
    expect(fresh.ok).toBe(true);
  });

  test("registering one thread never changes another thread's reachability", () => {
    // An earlier revision took `generation` as a register() parameter and raised
    // the store counter to match. That made a single registration reorder
    // reachability for everyone: registering at a LOWER generation stranded the
    // new thread immediately, and registering at a HIGHER one silently evicted
    // every healthy thread. Both were invisible to the suite, because the only
    // fencing test walked the happy sequence.
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-a"));
    expect(store.resolve({ threadId: "thread-a", generation: store.generation }).ok).toBe(true);

    // Adding more threads must leave the first one alone…
    store.register("thread-b", fakeHost("sess-b"));
    store.register("thread-c", fakeHost("sess-c"));
    expect(store.resolve({ threadId: "thread-a", generation: store.generation }).ok).toBe(true);
    expect(store.resolve({ threadId: "thread-b", generation: store.generation }).ok).toBe(true);
    // …and the generation must not drift as a side effect of registering.
    expect(store.generation).toBe(1);
  });

  test("a caller cannot resurrect a stale entry by passing the old generation", () => {
    // `resolve` must check BOTH sides against the store's own generation. If it
    // only compared entry-vs-request, handing the stale number back in would
    // return the stale host — the caller's word is not evidence about which
    // app-server generation is live.
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-old"));
    const staleGeneration = store.generation;
    store.bumpGeneration();

    const resurrected = store.resolve({ threadId: "thread-a", generation: staleGeneration });
    expect(resurrected.ok).toBe(false);
  });

  test("bumpGeneration drops entries it just made unreachable", () => {
    // Unreachable entries pin live SessionToolHost objects (each holding an
    // executor and an approval route) against GC for the process lifetime,
    // growing with every app-server restart.
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-a"));
    store.register("thread-b", fakeHost("sess-b"));
    expect(store.size).toBe(2);

    store.bumpGeneration();
    expect(store.size).toBe(0);
    expect(store.threadIds()).toEqual([]);
  });

  test("a batch spanning two threads is rejected wholesale", () => {
    // §11.3: one batch, one thread. Resolving per-item would let a mixed batch
    // touch two sessions on the strength of one authorization.
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-a"));
    store.register("thread-b", fakeHost("sess-b"));

    const single = store.resolveBatch(["thread-a", "thread-a"], store.generation);
    expect(single.ok).toBe(true);

    const mixed = store.resolveBatch(["thread-a", "thread-b"], store.generation);
    expect(mixed.ok).toBe(false);
    expect(mixed.ok === false && mixed.reason).toBe("ambiguous_thread");
  });

  test("a batch with any missing thread id is rejected", () => {
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-a"));
    const result = store.resolveBatch(["thread-a", undefined], store.generation);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("missing_thread_id");
  });

  test("an empty batch is rejected rather than treated as trivially fine", () => {
    // Note: the explicit length check in resolveBatch is defence in depth, not
    // load-bearing — an empty batch also falls through to `resolve(undefined)`,
    // which already refuses. Removing the check alone therefore does NOT make
    // this test fail, and it would be dishonest to claim otherwise. The
    // assertion still pins the OUTCOME, which is what callers depend on.
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-a"));
    const result = store.resolveBatch([], store.generation);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("missing_thread_id");
  });

  test("re-registering a thread replaces the host instead of accumulating", () => {
    const store = new SessionContextStore();
    const first = fakeHost("sess-1");
    const second = fakeHost("sess-2");
    store.register("thread-a", first);
    store.register("thread-a", second);
    expect(store.resolve({ threadId: "thread-a", generation: 1 })).toEqual({
      ok: true,
      host: second,
    });
    expect(store.size).toBe(1);
  });

  test("clear() drops every mapping", () => {
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-a"));
    store.register("thread-b", fakeHost("sess-b"));
    store.clear();
    expect(store.size).toBe(0);
    expect(store.resolve({ threadId: "thread-a", generation: 1 }).ok).toBe(false);
  });

  test("never serializes a host — the store is memory-only", () => {
    // §13.6: bridge context is rebuilt in memory on restart, never persisted.
    const store = new SessionContextStore();
    store.register("thread-a", fakeHost("sess-a"));
    expect(() => JSON.stringify(store)).not.toThrow();
    // The JSON form must not leak the host objects.
    expect(JSON.stringify(store)).not.toContain("sess-a");
  });
});
