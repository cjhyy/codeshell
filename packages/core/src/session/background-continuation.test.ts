import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "../types.js";
import { NotificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { BackgroundContinuationController } from "./background-continuation.js";

function fixture() {
  const mailbox = new NotificationQueue();
  const original = mailbox.enqueue(
    {
      agentId: "work",
      description: "background work",
      finalText: "saved result",
      status: "completed",
      enqueuedAt: 1,
    },
    "session",
  )!;
  const state = { current: true, stopped: false, eligible: true };
  const continuation = new BackgroundContinuationController(mailbox, "session", {
    isCurrent: () => state.current,
    isStopped: () => state.stopped,
    isEligible: () => state.eligible,
  });
  return { mailbox, original, state, continuation };
}

describe("shared background continuation contract", () => {
  test.each(["stopped", "ineligible", "replaced"])(
    "%s admission retains results without a delivery",
    (reason) => {
      const f = fixture();
      f.state.stopped = reason === "stopped";
      f.state.eligible = reason !== "ineligible";
      f.state.current = reason !== "replaced";
      expect(f.continuation.claim()).toBeUndefined();
      expect(f.mailbox.getSnapshot("session")).toEqual([f.original]);
    },
  );

  test("Stop from a synchronous mailbox observer wins before provider dispatch", () => {
    const f = fixture();
    f.mailbox.subscribe(() => {
      f.state.stopped = true;
    });
    expect(f.continuation.claim()).toBeUndefined();
    expect(f.mailbox.getSnapshot("session")).toEqual([f.original]);
  });

  test("a reset during reservation cannot return a delivery from the closed mailbox", () => {
    const f = fixture();
    const unsubscribe = f.mailbox.subscribe(() => {
      unsubscribe();
      f.mailbox.reset("session");
    });
    expect(f.continuation.claim()).toBeUndefined();
    expect(f.mailbox.getSnapshot("session")).toEqual([]);
  });

  test("host acceptance, dispatch, cumulative usage and error are not provider acceptance", () => {
    const f = fixture();
    const delivery = f.continuation.claim()!;
    for (const event of [
      { type: "session_started", sessionId: "session", promptTokens: 0 },
      { type: "stream_request_start", turnNumber: 1 },
      { type: "usage_update", promptTokens: 0, promptTokensSource: "session_cumulative" },
      { type: "error", error: "launch failed" },
      { type: "turn_complete", reason: "model_error" },
      { type: "turn_complete", reason: "aborted_streaming" },
    ] as StreamEvent[])
      delivery.observe(event);
    expect(delivery.finish()).toBe(1);
    expect(delivery.finish()).toBe(0);
    expect(f.mailbox.getSnapshot("session")).toEqual([f.original]);
  });

  test("late callbacks from a failed attempt cannot settle a later claim", () => {
    const f = fixture();
    const old = f.continuation.claim()!;
    expect(old.finish()).toBe(1);
    const next = f.continuation.claim()!;
    old.observe({ type: "text_delta", text: "late output" });
    old.accept();
    expect(next.finish()).toBe(1);
    expect(f.mailbox.getSnapshot("session")).toEqual([f.original]);
  });

  test.each([
    { type: "text_delta", text: "partial output" },
    { type: "usage_update", promptTokens: 12, promptTokensSource: "provider_usage" },
    { type: "turn_complete", reason: "completed" },
  ] as StreamEvent[])("provider %s commits results despite a later failure", (event) => {
    const f = fixture();
    const delivery = f.continuation.claim()!;
    delivery.observe(event);
    delivery.observe({ type: "error", error: "later failure" });
    expect(delivery.wasAccepted).toBe(true);
    expect(delivery.finish()).toBe(0);
    expect(f.mailbox.getSnapshot("session")).toEqual([]);
  });
});
