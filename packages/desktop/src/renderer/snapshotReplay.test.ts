/**
 * snapshotReplay — pick which snapshot events a (re)subscribing renderer must
 * replay, given the highest seq it has already applied.
 *
 * After a remount the renderer has applied nothing (cursor 0) and replays the
 * whole snapshot. While live, it tracks the highest seq it has seen; on a
 * re-subscribe it replays only events past that cursor so the snapshot and the
 * live stream align with no gap and no duplicate. seq is assigned by the main
 * SessionSnapshotStore (live StreamEvents have no stable id).
 */
import { describe, it, expect } from "bun:test";
import { selectReplayEvents, snapshotHasUnfinishedTopLevelTurn } from "./snapshotReplay";
import type { SessionSnapshot } from "../preload/types";

const snap = (events: Array<{ seq: number; event: unknown }>, nextSeq: number): SessionSnapshot =>
  ({ events, nextSeq }) as unknown as SessionSnapshot;

describe("selectReplayEvents", () => {
  it("replays the whole snapshot when nothing has been applied (fresh remount)", () => {
    const s = snap(
      [
        { seq: 1, event: { type: "text_delta", text: "a" } },
        { seq: 2, event: { type: "text_delta", text: "b" } },
      ],
      3,
    );
    const { events, cursor } = selectReplayEvents(s, 0);
    expect(events).toEqual([
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
    ]);
    expect(cursor).toBe(2);
  });

  it("replays only events past the applied cursor (no duplicates)", () => {
    const s = snap(
      [
        { seq: 3, event: { type: "text_delta", text: "c" } },
        { seq: 4, event: { type: "text_delta", text: "d" } },
      ],
      5,
    );
    const { events, cursor } = selectReplayEvents(s, 3);
    expect(events).toEqual([{ type: "text_delta", text: "d" }]);
    expect(cursor).toBe(4);
  });

  it("replays nothing when already caught up; cursor unchanged", () => {
    const s = snap([{ seq: 2, event: { type: "x" } }], 3);
    const { events, cursor } = selectReplayEvents(s, 5);
    expect(events).toEqual([]);
    expect(cursor).toBe(5);
  });

  it("handles an empty snapshot (unknown session) without moving the cursor", () => {
    const s = snap([], 1);
    const { events, cursor } = selectReplayEvents(s, 7);
    expect(events).toEqual([]);
    expect(cursor).toBe(7);
  });

  it("advances the cursor to the max replayed seq even if entries arrive unordered", () => {
    const s = snap(
      [
        { seq: 4, event: { type: "d" } },
        { seq: 2, event: { type: "b" } },
      ],
      5,
    );
    const { events, cursor } = selectReplayEvents(s, 1);
    // Both are past the cursor; cursor advances to the highest seq seen.
    expect(events.length).toBe(2);
    expect(cursor).toBe(4);
  });
});

describe("snapshotHasUnfinishedTopLevelTurn", () => {
  it("stays running when the authoritative marker is true after the start was evicted", () => {
    const s = {
      events: [{ seq: 20, event: { type: "text_delta", text: "still working" } }],
      nextSeq: 21,
      topLevelRunning: true,
    } as unknown as SessionSnapshot;

    expect(snapshotHasUnfinishedTopLevelTurn(s)).toBe(true);
  });

  it("is idle when the authoritative marker is false despite a retained start without terminal", () => {
    const s = {
      events: [{ seq: 1, event: { type: "session_started", sessionId: "s1" } }],
      nextSeq: 2,
      topLevelRunning: false,
    } as unknown as SessionSnapshot;

    expect(snapshotHasUnfinishedTopLevelTurn(s)).toBe(false);
  });

  it("falls back to lifecycle inference for old snapshots without the marker", () => {
    const running = snap([{ seq: 1, event: { type: "stream_request_start" } }], 2);
    const idle = snap(
      [
        { seq: 1, event: { type: "session_started" } },
        { seq: 2, event: { type: "turn_complete" } },
      ],
      3,
    );

    expect(snapshotHasUnfinishedTopLevelTurn(running)).toBe(true);
    expect(snapshotHasUnfinishedTopLevelTurn(idle)).toBe(false);
  });

  it.each(["runId", "clientMessageId"])(
    "legacy inference retains a successor after a late %s terminal",
    (identity) => {
      const events = [
        { type: "session_started", [identity]: "A" },
        { type: "session_started", [identity]: "B" },
        { type: "stream_request_start", [identity]: "A" },
        { type: "turn_complete", [identity]: "A" },
        { type: "error", [identity]: "A" },
      ];
      const snapshot = () =>
        snap(
          events.map((event, index) => ({ seq: index + 1, event })),
          6,
        );
      expect(snapshotHasUnfinishedTopLevelTurn(snapshot())).toBe(true);
      events.push({ type: "turn_complete", [identity]: "B" });
      expect(snapshotHasUnfinishedTopLevelTurn(snapshot())).toBe(false);
    },
  );
});
