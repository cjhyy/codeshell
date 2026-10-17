import { expect, test } from "bun:test";
import {
  createRunTiming,
  stampStreamEvent,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/session/stream-timing.ts";

test("valid epoch and fractional source times retain the original event object", () => {
  for (const timestamp of [0, 1.25, 1_700_000_000_000]) {
    const event = { type: "text_delta" as const, text: "ordinary", timestamp };
    expect(stampStreamEvent(event, 999)).toBe(event);
    expect(event.timestamp).toBe(timestamp);
  }
});

test("a missing source time stamps a copy without changing payload or caller object", () => {
  const event = { type: "text_delta" as const, text: "ordinary", runId: "run-a" };
  const stamped = stampStreamEvent(event, 1000);
  expect(stamped).not.toBe(event);
  expect(stamped).toEqual({ ...event, timestamp: 1000 });
  expect("timestamp" in event).toBe(false);
});

test("root session start reports logical submission start while retaining its source time", () => {
  let wall = 1000;
  const timing = createRunTiming({ now: () => wall, monotonicNow: () => 10 });
  wall = 2000;
  const source = {
    type: "session_started" as const,
    sessionId: "ordinary-session",
    promptTokens: 12,
    startedAt: 1500,
    timestamp: 1900,
  };
  const prepared = timing.prepareEvent(source);
  expect(timing.startedAt).toBe(1000);
  expect(prepared).toEqual({ ...source, startedAt: 1000 });
  expect(source.startedAt).toBe(1500);
  expect(source.timestamp).toBe(1900);
});

test("ordinary nonterminal events retain valid source identities through preparation", () => {
  const timing = createRunTiming({ now: () => 2000, monotonicNow: () => 30 });
  const delta = { type: "text_delta" as const, text: "answer", timestamp: 1800 };
  const request = { type: "stream_request_start" as const, turnNumber: 2, timestamp: 1750 };
  expect(timing.prepareEvent(delta)).toBe(delta);
  expect(timing.prepareEvent(request)).toBe(request);
});

test("root completion combines source completion time with monotonic elapsed duration", () => {
  let wall = 3000;
  let monotonic = 100;
  const timing = createRunTiming({ now: () => wall, monotonicNow: () => monotonic });
  wall = 9000;
  monotonic = 250.4;
  const source = {
    type: "turn_complete" as const,
    reason: "completed" as const,
    text: "answer",
    timestamp: 3500,
  };
  const prepared = timing.prepareEvent(source);
  expect(prepared).toMatchObject({
    ...source,
    startedAt: 3000,
    completedAt: 3500,
    durationMs: 150,
  });
  expect(prepared).not.toBe(source);
  expect("startedAt" in source).toBe(false);
  expect("durationMs" in source).toBe(false);
});

test("a later root terminal preserves first timing and keeps its own non-timing payload", () => {
  let wall = 1000;
  let monotonic = 10;
  const timing = createRunTiming({ now: () => wall, monotonicNow: () => monotonic });
  wall = 1200;
  monotonic = 210;
  timing.prepareEvent({ type: "turn_complete", reason: "completed", text: "first" });
  wall = 2000;
  monotonic = 1010;
  const later = timing.prepareEvent({
    type: "turn_complete",
    reason: "aborted_streaming",
    text: "later",
  });
  expect(later).toMatchObject({
    reason: "aborted_streaming",
    text: "later",
    timestamp: 2000,
    startedAt: 1000,
    completedAt: 1200,
    durationMs: 200,
  });
});

test("an unstamped child terminal receives source time but cannot finish the root clock", () => {
  let wall = 1000;
  let monotonic = 10;
  const timing = createRunTiming({ now: () => wall, monotonicNow: () => monotonic });
  wall = 1200;
  monotonic = 210;
  const child = {
    type: "turn_complete" as const,
    reason: "completed" as const,
    agentId: "ordinary-child",
    startedAt: 1100,
    completedAt: 1150,
    durationMs: 50,
  };
  expect(timing.prepareEvent(child)).toEqual({ ...child, timestamp: 1200 });
  expect("timestamp" in child).toBe(false);
  wall = 1500;
  monotonic = 510;
  expect(timing.prepareEvent({ type: "turn_complete", reason: "completed" })).toMatchObject({
    timestamp: 1500,
    startedAt: 1000,
    completedAt: 1500,
    durationMs: 500,
  });
});

test("separate logical submissions keep independent start and terminal timing", () => {
  let wall = 1000;
  let monotonic = 10;
  const clock = { now: () => wall, monotonicNow: () => monotonic };
  const first = createRunTiming(clock);
  wall = 1200;
  monotonic = 210;
  const second = createRunTiming(clock);
  wall = 1500;
  monotonic = 510;
  expect(first.prepareEvent({ type: "turn_complete", reason: "completed" })).toMatchObject({
    startedAt: 1000,
    completedAt: 1500,
    durationMs: 500,
  });
  expect(second.prepareEvent({ type: "turn_complete", reason: "completed" })).toMatchObject({
    startedAt: 1200,
    completedAt: 1500,
    durationMs: 300,
  });
  expect(first.startedAt).toBe(1000);
  expect(second.startedAt).toBe(1200);
});
