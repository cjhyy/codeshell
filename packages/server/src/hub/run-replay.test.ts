import { expect, test } from "bun:test";
import { HubRunReplay } from "./run-replay.js";

test("refresh combines a durable pre-run prefix with one live overlay and a race cursor", () => {
  const replay = new HubRunReplay();
  const durable = [{ id: "old" }, { id: "accepted-user" }, { id: "persisted-step" }];
  replay.begin("session", "request", 1);
  const user = { type: "session_user_message", text: "new turn" };
  const partial = { type: "text_delta", text: "unfinished assistant" };
  replay.append("session", user);
  const before = replay.append("session", partial);
  const snapshot = replay.snapshot("session", durable);
  expect(snapshot.transcript).toEqual([{ id: "old" }]);
  expect(snapshot.liveStream?.events.map((entry) => entry.event)).toEqual([user, partial]);
  expect(snapshot.streamCursor).toEqual(before);
  const after = replay.append("session", { type: "text_delta", text: " tail" });
  expect(after.epoch).toBe(before.epoch);
  expect(after.sequence).toBeGreaterThan(snapshot.streamCursor.sequence);
  expect(snapshot.liveStream?.events).toHaveLength(2);
  replay.finish("session", "request");
  expect(replay.snapshot("session", durable).transcript).toEqual(durable);
  expect(replay.snapshot("session", durable).liveStream).toBeUndefined();
});

test("overlapping requests keep the earliest baseline until both finish", () => {
  const replay = new HubRunReplay();
  replay.begin("session", "first", 1);
  replay.append("session", { type: "user_message", text: "first" });
  replay.begin("session", "second", 2);
  replay.finish("session", "first");
  const snapshot = replay.snapshot("session", [1, 2, 3]);
  expect(snapshot.transcript).toEqual([1]);
  expect(snapshot.liveStream?.events).toHaveLength(1);
  replay.finish("session", "second");
  expect(replay.snapshot("session", [1, 2, 3]).transcript).toEqual([1, 2, 3]);
});

test("missing-record recovery is limited to a tracked empty baseline", () => {
  const replay = new HubRunReplay();
  expect(replay.hasEmptyBaseline("new")).toBe(false);
  replay.begin("new", "first", 0);
  expect(replay.hasEmptyBaseline("new")).toBe(true);
  replay.begin("new", "second", 3);
  replay.finish("new", "first");
  expect(replay.hasEmptyBaseline("new")).toBe(true);
  replay.finish("new", "second");
  expect(replay.hasEmptyBaseline("new")).toBe(false);
  replay.begin("existing", "request", 1);
  expect(replay.hasEmptyBaseline("existing")).toBe(false);
});

test("bounded replay falls back to durable data with an explicit incomplete marker", () => {
  const replay = new HubRunReplay({ maxBytes: 60, maxEvents: 2 });
  replay.begin("session", "request", 1);
  replay.append("session", { text: "x".repeat(61) });
  replay.append("session", { text: "later" });
  const snapshot = replay.snapshot("session", [1, 2]);
  expect(snapshot.transcript).toEqual([1, 2]);
  expect(snapshot.liveStream).toEqual({ events: [], truncated: true });
  expect(snapshot.streamCursor.sequence).toBe(2);
});

test("worker exit releases overlays without recycling the stream cursor", () => {
  const replay = new HubRunReplay();
  replay.begin("session", "request", 0);
  const cursor = replay.append("session", { text: "before exit" });
  replay.clear();
  expect(replay.snapshot("session", []).liveStream).toBeUndefined();
  const next = replay.append("other-session", { text: "new worker" });
  expect(next.epoch).toBe(cursor.epoch);
  expect(next.sequence).toBeGreaterThan(cursor.sequence);
  expect(new HubRunReplay().snapshot("session", []).streamCursor.epoch).not.toBe(cursor.epoch);
});

test("concurrent sessions share a total memory budget and finishing one releases it", () => {
  const replay = new HubRunReplay({ maxBytes: 1000, maxEvents: 100, maxTotalBytes: 100 });
  replay.begin("first", "request-a", 0);
  replay.begin("second", "request-b", 0);
  replay.append("first", { text: "a".repeat(60) });
  replay.append("second", { text: "b".repeat(60) });
  expect(replay.snapshot("first", []).liveStream?.truncated).toBe(false);
  expect(replay.snapshot("second", ["durable"]).liveStream).toEqual({
    events: [],
    truncated: true,
  });
  replay.finish("first", "request-a");
  replay.begin("third", "request-c", 0);
  replay.append("third", { text: "c".repeat(60) });
  expect(replay.snapshot("third", []).liveStream?.truncated).toBe(false);
});

test("overlays and snapshot objects cannot mutate each other, and a finished run starts a fresh baseline", () => {
  const replay = new HubRunReplay();
  const event = { text: "original" };
  replay.begin("session", "first", 1);
  replay.append("session", event);
  event.text = "changed externally";
  const snapshot = replay.snapshot("session", ["old", "persisted"]);
  expect(snapshot.liveStream?.events[0]?.event).toEqual({ text: "original" });
  (snapshot.liveStream!.events[0]!.event as { text: string }).text = "changed by reader";
  expect(replay.snapshot("session", []).liveStream?.events[0]?.event).toEqual({ text: "original" });
  replay.finish("session", "first");
  replay.begin("session", "second", 2);
  expect(replay.snapshot("session", ["old", "persisted", "current"]).transcript).toEqual([
    "old",
    "persisted",
  ]);
  expect(replay.snapshot("session", []).liveStream?.events).toEqual([]);
});
