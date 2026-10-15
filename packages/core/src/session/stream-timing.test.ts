import { expect, test } from "bun:test";
import { createRunTiming, stampStreamEvent } from "./stream-timing.js";

test("source timestamps remain stable and invalid timestamps are replaced", () => {
  const original = { type: "text_delta" as const, text: "source", timestamp: 123 };
  expect(stampStreamEvent(original, 999)).toBe(original);
  for (const timestamp of [undefined, NaN, Infinity, -1]) {
    expect(stampStreamEvent({ ...original, timestamp }, 999)).toMatchObject({ timestamp: 999 });
  }
});

test("logical timing includes preparation and uses a monotonic duration across wall-clock changes", () => {
  let wall = 10_000;
  let monotonic = 100;
  const timing = createRunTiming({ now: () => wall, monotonicNow: () => monotonic });
  wall = 11_000;
  monotonic = 1_100;
  const start = timing.prepareEvent({
    type: "session_started",
    sessionId: "session",
    promptTokens: 0,
  });
  expect(start).toMatchObject({ timestamp: 11_000, startedAt: 10_000 });

  const child = timing.prepareEvent({
    type: "turn_complete",
    reason: "completed",
    agentId: "child",
    startedAt: 500,
    completedAt: 800,
    durationMs: 300,
    timestamp: 800,
  });
  expect(child).toMatchObject({
    startedAt: 500,
    completedAt: 800,
    durationMs: 300,
    timestamp: 800,
  });
  const childStart = {
    type: "session_started" as const,
    sessionId: "child-session",
    promptTokens: 0,
    agentId: "child",
    startedAt: 500,
    timestamp: 700,
  };
  expect(timing.prepareEvent(childStart)).toBe(childStart);

  wall = 9_000;
  monotonic = 3_100;
  expect(timing.prepareEvent({ type: "turn_complete", reason: "aborted_streaming" })).toMatchObject(
    {
      timestamp: 9_000,
      startedAt: 10_000,
      completedAt: 9_000,
      durationMs: 3_000,
    },
  );
  wall = 20_000;
  monotonic = 5_100;
  expect(timing.prepareEvent({ type: "turn_complete", reason: "aborted_streaming" })).toMatchObject(
    {
      timestamp: 20_000,
      startedAt: 10_000,
      completedAt: 9_000,
      durationMs: 3_000,
    },
  );
});
