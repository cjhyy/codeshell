import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileRunStore } from "./FileRunStore.js";
import type { RunEvent } from "./types.js";

// Regression: appendJsonl stored the chained promise in appendLocks even when
// appendFileSync threw. A failed write left a REJECTED promise in the map, so
// every later append to that file chained off it, never ran its callback, and
// failed forever — breaking the serialize-writes guarantee
// (review-2026-05-30, high at FileRunStore.ts:73-81). The lock must recover.

function ev(runId: string, eventId: string): RunEvent {
  return { eventId, runId, type: "run_event" as never, timestamp: 1, data: {} };
}

describe("FileRunStore appendEvent lock recovery", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-runstore-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failed append does not poison subsequent appends to the same file", async () => {
    const store = new FileRunStore(dir);
    const runId = "r1";

    // Force the FIRST append to throw: make events.jsonl a directory so
    // appendFileSync hits EISDIR.
    const runDir = join(dir, runId);
    mkdirSync(runDir, { recursive: true });
    const eventsPath = join(runDir, "events.jsonl");
    mkdirSync(eventsPath, { recursive: true });

    await expect(store.appendEvent(ev(runId, "e1"))).rejects.toBeDefined();

    // Repair the path so a real file can be written.
    rmSync(eventsPath, { recursive: true, force: true });

    // The next append MUST run (not silently skip on a poisoned lock).
    await store.appendEvent(ev(runId, "e2"));
    const events = await store.listEvents(runId);
    expect(events.map((e) => e.eventId)).toEqual(["e2"]);
    expect(existsSync(eventsPath)).toBe(true);
  });

  test("concurrent appends to the same file are serialized — no lost/interleaved lines", async () => {
    const store = new FileRunStore(dir);
    const runId = "r2";
    const ids = Array.from({ length: 50 }, (_, i) => `e${i}`);
    // Fire all appends without awaiting between them.
    await Promise.all(ids.map((id) => store.appendEvent(ev(runId, id))));
    const events = await store.listEvents(runId);
    // Every line present and parseable (serialization prevents interleaving).
    expect(events.length).toBe(50);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(50);
  });
});
