import { describe, it, expect } from "bun:test";
import { ChatSession } from "./chat-session.js";
import type { Engine, EngineResult } from "../engine/engine.js";

// Bug: the onboarding flow does cancel() + immediately re-run the same task.
// The cancelled in-flight run's abort error was reject()ed out of enqueueTurn,
// which the RPC layer surfaced as "Error: Request cancelled" red text in the
// UI — on what was a user-initiated Stop. Fix: a user-cancelled turn resolves
// as a clean aborted result instead of rejecting.

/** Fake engine whose run() rejects with an AbortError when its signal fires. */
function abortableEngine(): { engine: Engine; runStarted: Promise<void> } {
  let signalStarted!: () => void;
  const runStarted = new Promise<void>((r) => (signalStarted = r));
  const engine = {
    switchModel: () => ({}) as never,
    async run(_task: string, opts: { signal?: AbortSignal }): Promise<EngineResult> {
      signalStarted();
      return new Promise((resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const e = new Error("Request was aborted.");
          e.name = "AbortError";
          reject(e);
        });
        // Never resolves on its own — only via abort.
      });
    },
  } as unknown as Engine;
  return { engine, runStarted };
}

describe("ChatSession.cancel resolves the in-flight turn cleanly", () => {
  it("cancel() makes the active turn RESOLVE as aborted, not reject", async () => {
    const { engine, runStarted } = abortableEngine();
    const session = new ChatSession({ id: "s", engine });

    const turn = session.enqueueTurn("你好", { cwd: "/tmp" });
    await runStarted; // ensure the run is in-flight
    session.cancel();

    // Must resolve (not throw) with an aborted reason.
    const result = await turn;
    expect(result.reason).toBe("aborted_streaming");
    expect(result.sessionId).toBe("s");
  });

  it("a genuine (non-cancel) error still rejects", async () => {
    const engine = {
      switchModel: () => ({}) as never,
      async run(): Promise<EngineResult> {
        throw new Error("real failure: model exploded");
      },
    } as unknown as Engine;
    const session = new ChatSession({ id: "s", engine });
    await expect(session.enqueueTurn("hi", { cwd: "/tmp" })).rejects.toThrow(
      /real failure/,
    );
  });

  it("queued turns are still rejected on cancel", async () => {
    const { engine, runStarted } = abortableEngine();
    const session = new ChatSession({ id: "s", engine });
    const first = session.enqueueTurn("first", { cwd: "/tmp" });
    const second = session.enqueueTurn("second", { cwd: "/tmp" }); // queued behind first
    // Attach the rejection handler BEFORE cancel() so the synchronous reject of
    // the queued turn inside cancel() isn't seen as an unhandled rejection.
    const secondSettled = second.then(
      () => "resolved",
      (e) => `rejected:${(e as Error).message}`,
    );
    await runStarted;
    session.cancel();
    // first (active) resolves aborted; second (queued) rejects.
    await expect(first).resolves.toMatchObject({ reason: "aborted_streaming" });
    expect(await secondSettled).toContain("rejected:cancelled");
  });
});
