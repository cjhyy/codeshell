/**
 * SessionSnapshotStore — main-process, per-session event snapshot.
 *
 * Why: the renderer's route table + buffered events live in renderer memory
 * and are wiped on every remount (refresh / HMR / crash recovery). The main
 * process (AgentBridge) does NOT remount, so it is the right place to hold a
 * snapshot a reloaded renderer can re-subscribe to. Live StreamEvents carry no
 * stable id, so the store assigns its own monotonic `seq` per session — that
 * seq is the cursor the renderer uses to align the snapshot with the live
 * increment stream (dedup / no-gap).
 */
import { describe, it, expect } from "bun:test";
import { SessionSnapshotStore } from "./SessionSnapshotStore";

describe("SessionSnapshotStore", () => {
  it("appends events and returns them in order with a monotonic seq", () => {
    const store = new SessionSnapshotStore();
    const first = store.append("s1", { type: "text_delta", text: "a" });
    const second = store.append("s1", { type: "text_delta", text: "b" });

    const snap = store.get("s1");
    expect(first).toEqual({ seq: 1, event: { type: "text_delta", text: "a" } });
    expect(second).toEqual({ seq: 2, event: { type: "text_delta", text: "b" } });
    expect(snap.events.map((e) => e.event)).toEqual([
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
    ]);
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(snap.nextSeq).toBe(3);
  });

  it("keeps separate seq counters and logs per session", () => {
    const store = new SessionSnapshotStore();
    store.append("s1", { type: "text_delta", text: "a" });
    store.append("s2", { type: "text_delta", text: "x" });
    store.append("s1", { type: "text_delta", text: "b" });

    expect(store.get("s1").events.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.get("s2").events.map((e) => e.seq)).toEqual([1]);
  });

  it("returns an empty snapshot for an unknown session", () => {
    const store = new SessionSnapshotStore();
    const snap = store.get("nope");
    expect(snap.events).toEqual([]);
    expect(snap.nextSeq).toBe(1);
  });

  it("get(sessionId, sinceSeq) returns only events after the cursor", () => {
    const store = new SessionSnapshotStore();
    store.append("s1", { type: "text_delta", text: "a" }); // seq 1
    store.append("s1", { type: "text_delta", text: "b" }); // seq 2
    store.append("s1", { type: "text_delta", text: "c" }); // seq 3

    const snap = store.get("s1", 1);
    expect(snap.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(snap.nextSeq).toBe(4);
  });

  it("caps retained events to maxPerSession, dropping the oldest", () => {
    const store = new SessionSnapshotStore({ maxPerSession: 3 });
    for (let i = 1; i <= 5; i++) {
      store.append("s1", { type: "text_delta", text: String(i) });
    }
    const snap = store.get("s1");
    // Oldest two (seq 1,2) evicted; seq keeps climbing (no reuse).
    expect(snap.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(snap.nextSeq).toBe(6);
  });

  it("keeps top-level running authoritative after the start event is evicted", () => {
    const store = new SessionSnapshotStore({ maxPerSession: 2 });
    store.append("s1", { type: "session_started" });
    store.append("s1", { type: "text_delta", text: "a" });
    store.append("s1", { type: "text_delta", text: "b" });

    const snap = store.get("s1");
    expect(snap.events.map((e) => (e.event as { type: string }).type)).toEqual([
      "text_delta",
      "text_delta",
    ]);
    expect(snap.topLevelRunning).toBe(true);
  });

  it("marks retained unfinished starts idle when the worker exits", () => {
    const store = new SessionSnapshotStore();
    store.append("s1", { type: "session_started" });
    store.onWorkerExit(["s1"]);

    expect(store.get("s1").topLevelRunning).toBe(false);
  });

  it("clears only worker-owned running sessions when automation is also running", () => {
    const store = new SessionSnapshotStore();
    store.append("automation-1", { type: "session_started" });
    store.append("worker-1", { type: "session_started" });

    expect(store.get("automation-1").topLevelRunning).toBe(true);
    expect(store.get("worker-1").topLevelRunning).toBe(true);

    store.onWorkerExit(["worker-1"]);

    expect(store.get("automation-1").topLevelRunning).toBe(true);
    expect(store.get("worker-1").topLevelRunning).toBe(false);
  });

  it("does NOT clear a session's snapshot on worker exit (snapshot outlives worker)", () => {
    const store = new SessionSnapshotStore();
    store.append("s1", { type: "text_delta", text: "a" });
    store.onWorkerExit(["s1"]); // clean exit after a run — must not wipe snapshots
    expect(store.get("s1").events.length).toBe(1);
  });

  it("forget(sessionId) drops a single session (e.g. on session delete)", () => {
    const store = new SessionSnapshotStore();
    store.append("s1", { type: "text_delta", text: "a" });
    store.append("s2", { type: "text_delta", text: "x" });
    store.forget("s1");
    expect(store.get("s1").events).toEqual([]);
    expect(store.get("s2").events.length).toBe(1);
  });
});
