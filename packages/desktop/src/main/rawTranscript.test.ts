/**
 * parseRawTranscriptEvents — read the on-disk transcript as raw events that
 * preserve the cursor fields (id / turnNumber / timestamp).
 *
 * The folded reader (transcriptToFoldItems) drops the per-event `id`, which is
 * the only stable dedup key on disk. Phase 4 needs the raw events so a renderer
 * whose main-snapshot window has been evicted can re-read the disk transcript
 * and resume from a known event id without duplicating.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseRawTranscriptEvents, getSessionEvents } from "./rawTranscript";

const j = (objs: unknown[]): string => objs.map((o) => JSON.stringify(o)).join("\n");

describe("parseRawTranscriptEvents", () => {
  const events = [
    { id: "a", type: "session_meta", timestamp: 1, turnNumber: 0, data: { sessionId: "s1" } },
    { id: "b", type: "message", timestamp: 2, turnNumber: 0, data: { role: "user", content: "hi" } },
    { id: "c", type: "turn_boundary", timestamp: 3, turnNumber: 1, data: { turnNumber: 1 } },
  ];

  it("returns all raw events with id/turnNumber/timestamp preserved", () => {
    const out = parseRawTranscriptEvents(j(events));
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ id: "a", type: "session_meta", turnNumber: 0, timestamp: 1 });
    expect(out[2]).toMatchObject({ id: "c", type: "turn_boundary", turnNumber: 1 });
  });

  it("returns only events after the given sinceId (exclusive)", () => {
    const out = parseRawTranscriptEvents(j(events), "b");
    expect(out.map((e) => e.id)).toEqual(["c"]);
  });

  it("returns all events when sinceId is not found", () => {
    const out = parseRawTranscriptEvents(j(events), "missing");
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("skips malformed lines instead of throwing", () => {
    const jsonl = `${JSON.stringify(events[0])}\n{not json\n${JSON.stringify(events[1])}`;
    const out = parseRawTranscriptEvents(jsonl);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("returns [] for empty input", () => {
    expect(parseRawTranscriptEvents("")).toEqual([]);
    expect(parseRawTranscriptEvents("  \n  ")).toEqual([]);
  });
});

describe("getSessionEvents (filesystem)", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-raw-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns [] for a missing session", async () => {
    expect(await getSessionEvents("nope", undefined, dir)).toEqual([]);
  });

  it("returns [] for an unsafe session id (path traversal)", async () => {
    expect(await getSessionEvents("../etc", undefined, dir)).toEqual([]);
    expect(await getSessionEvents("..", undefined, dir)).toEqual([]);
  });

  it("reads raw events from a session dir transcript.jsonl", async () => {
    const sdir = path.join(dir, "sess-9");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(
      path.join(sdir, "transcript.jsonl"),
      [
        JSON.stringify({ id: "a", type: "message", timestamp: 1, turnNumber: 0, data: { role: "user", content: "yo" } }),
        JSON.stringify({ id: "b", type: "turn_boundary", timestamp: 2, turnNumber: 1, data: {} }),
      ].join("\n") + "\n",
    );
    const out = await getSessionEvents("sess-9", undefined, dir);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
    const tail = await getSessionEvents("sess-9", "a", dir);
    expect(tail.map((e) => e.id)).toEqual(["b"]);
  });
});
