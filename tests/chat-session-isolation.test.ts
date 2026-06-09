/**
 * Gate 1 multi-session isolation tests.
 *
 * The Engine plumbing (per-session ChatSession, per-session AbortController,
 * per-session pendingApprovals map) is in place since the multi-session
 * protocol landed; what was missing was tests that *prove* the isolation.
 * These cover the four Gate 1 bullets that B2.1 closed by audit rather
 * than refactor:
 *
 *   - same-session turns are FIFO     (covered in chat-session-queue.test.ts)
 *   - different sessions can run concurrently
 *   - cancel targets only one session
 *   - pending approvals are session-scoped
 *
 * The fake engine here mirrors the slow/abortable shape used in
 * chat-session-queue.test.ts but exposes a hook for "in-flight" so a test
 * can race two sessions explicitly.
 */
import { describe, it, expect } from "bun:test";
import { ChatSession } from "../packages/core/src/protocol/chat-session.ts";

type EngineStub = {
  run: (task: string, opts: { signal: AbortSignal }) => Promise<{
    text: string;
    reason: string;
    sessionId: string;
    turnCount: number;
    usage: Record<string, never>;
  }>;
  permissionMode: "default";
  planMode: false;
};

const PER_RUN_MS = 50;

function makeSlowEngine(id: string, startedSignal?: () => void): EngineStub {
  return {
    run: (task, opts) =>
      new Promise((resolve, reject) => {
        startedSignal?.();
        const t = setTimeout(() => {
          resolve({
            text: `done:${id}:${task}`,
            reason: "completed",
            sessionId: id,
            turnCount: 1,
            usage: {},
          });
        }, PER_RUN_MS);
        opts.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      }),
    permissionMode: "default",
    planMode: false,
  };
}

describe("ChatSession isolation (Gate 1)", () => {
  it("two sessions run concurrently — neither blocks the other", async () => {
    // Use start-order counters instead of wall-clock timing. The claim
    // we care about is "B can start while A is still running" — that is
    // the precise opposite of serialized. If a hidden lock serialized
    // them, B's `startedSignal` would fire only after A's
    // setTimeout resolves; the snapshot taken inside A's run would
    // therefore show bStartedAtAFire === 0.
    let aStarted = 0;
    let bStarted = 0;
    let bStartedAtAFire = -1;

    const a = new ChatSession({
      id: "A",
      engine: makeSlowEngine("A", () => {
        aStarted += 1;
        // Capture B's start counter at the moment A starts running. If
        // they're truly concurrent, the start order may interleave but
        // both should be observed as 1 by the time the engine resolves.
      }) as any,
    });
    const b = new ChatSession({
      id: "B",
      engine: makeSlowEngine("B", () => {
        bStarted += 1;
        // Take a snapshot of A's started count when B's run() begins.
        // Concurrent: aStarted === 1 here (A already started, still
        // running). Serialized: aStarted === 1 too — but only because
        // A would have already finished and B is taking its slot.
        // The discriminator is whether `aStarted === 1 && bStarted === 1`
        // is observed at the *same* time, which we check below by
        // sampling immediately after kicking off both enqueueTurn calls.
        bStartedAtAFire = aStarted;
      }) as any,
    });

    const pa = a.enqueueTurn("x", {});
    const pb = b.enqueueTurn("y", {});

    // One microtask flush is enough for both `pump()` calls to advance
    // into engine.run(); both should be sitting in setTimeout already.
    await new Promise<void>((r) => setImmediate(r));

    // Both runs in flight at the same time → both sessions are busy.
    // A serialized implementation could only show one busy.
    expect(a.isBusy()).toBe(true);
    expect(b.isBusy()).toBe(true);
    expect(aStarted).toBe(1);
    expect(bStarted).toBe(1);
    // B observed A as already-started when its own run() began →
    // they overlapped, which is the multi-session concurrency claim.
    expect(bStartedAtAFire).toBe(1);

    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.text).toBe("done:A:x");
    expect(rb.text).toBe("done:B:y");
  });

  it("cancel(A) does not abort B's in-flight turn", async () => {
    const a = new ChatSession({ id: "A", engine: makeSlowEngine("A") as any });
    const b = new ChatSession({ id: "B", engine: makeSlowEngine("B") as any });

    const pa = a.enqueueTurn("x", {});
    const pb = b.enqueueTurn("y", {});

    // Cancel A after both start
    setTimeout(() => a.cancel(), 5);

    // A's in-flight turn resolves as a clean aborted result (not a rejection);
    // B's turn is untouched and completes normally — the isolation claim.
    const ra = await pa;
    expect(ra.reason).toBe("aborted_streaming");
    const rb = await pb;
    expect(rb.text).toBe("done:B:y");
  });

  it("queued turns on cancelled session reject; sibling sessions unaffected", async () => {
    const a = new ChatSession({ id: "A", engine: makeSlowEngine("A") as any });
    const b = new ChatSession({ id: "B", engine: makeSlowEngine("B") as any });

    // Wrap to outcome objects upfront so the inner rejection isn't observed
    // as "unhandled" before await — `cancel()` synchronously rejects queued
    // turns, and bun's promise warning fires if no handler is attached by
    // the time the microtask flushes.
    const settle = <T>(p: Promise<T>) =>
      p.then(
        (value) => ({ ok: true as const, value }),
        (error: Error) => ({ ok: false as const, error: error.message }),
      );

    const a1 = settle(a.enqueueTurn("first", {}));
    const a2 = settle(a.enqueueTurn("queued", {}));
    const bResult = settle(b.enqueueTurn("solo", {}));

    setTimeout(() => a.cancel(), 5);

    const r1 = await a1;
    const r2 = await a2;
    const rb = await bResult;

    // The in-flight turn resolves cleanly (aborted_streaming), not rejects.
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.reason).toBe("aborted_streaming");
    // The QUEUED turn on the cancelled session still rejects with /cancelled/.
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/cancelled/);
    // Sibling session is unaffected.
    expect(rb.ok).toBe(true);
    if (rb.ok) expect(rb.value.text).toBe("done:B:solo");
  });

  it("pendingApprovals are session-scoped maps (different identities)", () => {
    const a = new ChatSession({ id: "A", engine: makeSlowEngine("A") as any });
    const b = new ChatSession({ id: "B", engine: makeSlowEngine("B") as any });
    expect(a.pendingApprovals).not.toBe(b.pendingApprovals);
  });

  it("an approval registered on A is not visible from B's map", () => {
    const a = new ChatSession({ id: "A", engine: makeSlowEngine("A") as any });
    const b = new ChatSession({ id: "B", engine: makeSlowEngine("B") as any });
    const noop = () => {};
    a.pendingApprovals.set("req-1", noop);
    expect(a.pendingApprovals.has("req-1")).toBe(true);
    expect(b.pendingApprovals.has("req-1")).toBe(false);
    expect(b.pendingApprovals.size).toBe(0);
  });
});
