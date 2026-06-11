import { describe, expect, test } from "bun:test";
import {
  latestUndoTarget,
  earliestSnapshotsPerFile,
  latestTurnUndoTargets,
  latestRedoTargets,
} from "./undo-target.js";
import type { FileSnapshot, RedoRecord } from "./file-history.js";

const snap = (
  filePath: string,
  timestamp: number,
  turnSeq?: number,
  undone?: boolean,
): FileSnapshot => ({
  filePath,
  timestamp,
  backupPath: `/backups/${filePath}.${timestamp}`,
  hash: `${filePath}-${timestamp}`,
  size: 1,
  ...(turnSeq === undefined ? {} : { turnSeq }),
  ...(undone === undefined ? {} : { undone }),
});

const redo = (
  filePath: string,
  turnSeq: number,
  existedBefore = true,
): RedoRecord => ({
  filePath,
  turnSeq,
  backupPath: `/redo/${filePath}.${turnSeq}`,
  existedBefore,
});

describe("latestUndoTarget", () => {
  test("empty history → null", () => {
    expect(latestUndoTarget([])).toBeNull();
  });

  test("single snapshot → itself", () => {
    const s = snap("a.ts", 100);
    expect(latestUndoTarget([s])).toBe(s);
  });

  test("picks the greatest timestamp regardless of array order", () => {
    const a = snap("a.ts", 100);
    const b = snap("b.ts", 300);
    const c = snap("c.ts", 200);
    expect(latestUndoTarget([a, b, c])).toBe(b);
  });

  test("same-millisecond tie → last entry in array order wins", () => {
    const first = snap("a.ts", 500);
    const second = snap("b.ts", 500);
    expect(latestUndoTarget([first, second])).toBe(second);
  });
});

describe("earliestSnapshotsPerFile", () => {
  test("empty → []", () => {
    expect(earliestSnapshotsPerFile([])).toEqual([]);
  });

  test("one snapshot per file, earliest of each", () => {
    const a1 = snap("a.ts", 100);
    const a2 = snap("a.ts", 300); // later edit of a — should NOT be picked
    const b1 = snap("b.ts", 200);
    const out = earliestSnapshotsPerFile([a1, a2, b1]);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.filePath === "a.ts")).toBe(a1);
    expect(out.find((s) => s.filePath === "b.ts")).toBe(b1);
  });

  test("ordered by each file's first-edit time, oldest first", () => {
    const out = earliestSnapshotsPerFile([
      snap("b.ts", 300),
      snap("a.ts", 100),
      snap("c.ts", 200),
    ]);
    expect(out.map((s) => s.filePath)).toEqual(["a.ts", "c.ts", "b.ts"]);
  });

  test("same-ms tie for one file → first array entry wins", () => {
    const first = snap("a.ts", 500);
    first.hash = "FIRST";
    const second = snap("a.ts", 500);
    second.hash = "SECOND";
    const out = earliestSnapshotsPerFile([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0]!.hash).toBe("FIRST");
  });
});

describe("latestTurnUndoTargets", () => {
  test("empty history → []", () => {
    expect(latestTurnUndoTargets([])).toEqual([]);
  });

  test("only the latest turn's files, each at its pre-turn state", () => {
    // turn 1 edits a.ts; turn 2 edits a.ts again and b.ts.
    // Undoing the latest turn (2) reverts a.ts to its turn-2-start state
    // (ts 250, NOT 100 which is turn 1) and b.ts to ts 260 — but NOT turn 1.
    const a_t1 = snap("a.ts", 100, 1);
    const a_t2a = snap("a.ts", 250, 2);
    const a_t2b = snap("a.ts", 280, 2); // a edited twice in turn 2
    const b_t2 = snap("b.ts", 260, 2);
    const out = latestTurnUndoTargets([a_t1, a_t2a, a_t2b, b_t2]);
    expect(out.map((s) => s.filePath).sort()).toEqual(["a.ts", "b.ts"]);
    // a.ts must restore to the EARLIEST snapshot WITHIN turn 2 (250), not turn 1 (100)
    expect(out.find((s) => s.filePath === "a.ts")).toBe(a_t2a);
    expect(out.find((s) => s.filePath === "b.ts")).toBe(b_t2);
  });

  test("ordered by each file's first-edit time within the turn, oldest first", () => {
    const out = latestTurnUndoTargets([
      snap("b.ts", 300, 5),
      snap("a.ts", 100, 5),
      snap("c.ts", 200, 5),
    ]);
    expect(out.map((s) => s.filePath)).toEqual(["a.ts", "c.ts", "b.ts"]);
  });

  test("picks the greatest turnSeq even if its timestamps are not the newest overall", () => {
    // Pathological clock: turn 2's snapshot has a smaller timestamp than turn 1's.
    // Turn boundary is defined by turnSeq, not wall-clock.
    const t1 = snap("a.ts", 999, 1);
    const t2 = snap("b.ts", 100, 2);
    const out = latestTurnUndoTargets([t1, t2]);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe("b.ts");
  });

  test("legacy snapshots without turnSeq fall back to a single 'turn' (undefined)", () => {
    // Pre-feature snapshots have no turnSeq. They all share the undefined
    // bucket; latestTurnUndoTargets returns each file's earliest — i.e. it
    // degrades to whole-session behaviour rather than crashing.
    const a = snap("a.ts", 100);
    const a2 = snap("a.ts", 200);
    const b = snap("b.ts", 150);
    const out = latestTurnUndoTargets([a, a2, b]);
    expect(out.map((s) => s.filePath).sort()).toEqual(["a.ts", "b.ts"]);
    expect(out.find((s) => s.filePath === "a.ts")).toBe(a);
  });

  test("mixed legacy + tagged → tagged turns win over the undefined bucket", () => {
    const legacy = snap("old.ts", 50); // no turnSeq
    const tagged = snap("new.ts", 100, 1);
    const out = latestTurnUndoTargets([legacy, tagged]);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe("new.ts");
  });

  test("skips undone turns: after turn 2 is undone, selects turn 1 (peel onion)", () => {
    // turn 1 edits a.ts; turn 2 edits a.ts and b.ts but was undone (marked).
    // latestTurnUndoTargets must SKIP the undone turn-2 snapshots and re-select
    // turn 1 so a second /undo peels the prior turn.
    const a_t1 = snap("a.ts", 100, 1);
    const a_t2 = snap("a.ts", 250, 2, true);
    const b_t2 = snap("b.ts", 260, 2, true);
    const out = latestTurnUndoTargets([a_t1, a_t2, b_t2]);
    expect(out.map((s) => s.filePath)).toEqual(["a.ts"]);
    expect(out[0]).toBe(a_t1);
  });

  test("all turns undone → []", () => {
    const a = snap("a.ts", 100, 1, true);
    const b = snap("b.ts", 200, 2, true);
    expect(latestTurnUndoTargets([a, b])).toEqual([]);
  });
});

describe("earliestSnapshotsPerFile (skip undone)", () => {
  test("undone snapshots are ignored when picking each file's baseline", () => {
    // a.ts: a real undone turn-2 snapshot (300) plus a live turn-1 snapshot (100).
    // The baseline must be 100, not the undone 300, even though both are earlier.
    const a_live = snap("a.ts", 100, 1);
    const a_undone = snap("a.ts", 50, 2, true); // earlier ts but undone → skip
    const out = earliestSnapshotsPerFile([a_undone, a_live]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(a_live);
  });

  test("a file with only undone snapshots drops out entirely", () => {
    const a = snap("a.ts", 100, 1, true);
    const b = snap("b.ts", 200, 1);
    const out = earliestSnapshotsPerFile([a, b]);
    expect(out.map((s) => s.filePath)).toEqual(["b.ts"]);
  });
});

describe("latestRedoTargets", () => {
  test("empty inputs → []", () => {
    expect(latestRedoTargets([], [])).toEqual([]);
  });

  test("returns the latest-turn redo records when that turn is the redoable one", () => {
    // turn 2 was just undone (its snapshots are marked undone) → redo available.
    const records = [redo("a.ts", 2), redo("b.ts", 2)];
    const snaps = [snap("a.ts", 250, 2, true), snap("b.ts", 260, 2, true)];
    const out = latestRedoTargets(records, snaps);
    expect(out.map((r) => r.filePath).sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("picks only the GREATEST turnSeq among redo records", () => {
    const records = [redo("a.ts", 1), redo("b.ts", 2)];
    const snaps = [snap("a.ts", 100, 1, true), snap("b.ts", 200, 2, true)];
    const out = latestRedoTargets(records, snaps);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe("b.ts");
  });

  test("a newer LIVE turn supersedes the redo turn → []", () => {
    // After undoing turn 2, a new turn 3 edited files (live, not undone) → the
    // redo of turn 2 is no longer the latest undone state; must be unavailable.
    const records = [redo("a.ts", 2)];
    const snaps = [
      snap("a.ts", 250, 2, true), // turn 2 still marked undone
      snap("c.ts", 400, 3), // fresh LIVE turn 3 supersedes the redo
    ];
    expect(latestRedoTargets(records, snaps)).toEqual([]);
  });

  test("created-only redo record (existedBefore false, no pre-turn snapshot) still returned", () => {
    // A file created in turn 2 has NO pre-turn snapshot; the RedoRecord is the
    // only evidence. With no newer live turn, redo must still be available.
    const records = [redo("a.ts", 2, false)];
    const out = latestRedoTargets(records, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.existedBefore).toBe(false);
  });
});
