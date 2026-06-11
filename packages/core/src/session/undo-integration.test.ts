/**
 * Integration: the real /undo path through FileHistory + latestUndoTarget.
 * Verifies that snapshot-before-edit + "newest snapshot" selection + restore
 * actually brings a file's content back to its pre-edit state — the contract
 * the TUI /undo command relies on.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileHistory } from "./file-history.js";
import {
  latestUndoTarget,
  latestTurnUndoTargets,
  latestRedoTargets,
} from "./undo-target.js";

let root: string;
let sessionDir: string;
let workDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "undo-it-"));
  sessionDir = join(root, "session");
  workDir = join(root, "work");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("snapshot → edit → latestUndoTarget → restore brings content back", () => {
  const file = join(workDir, "a.txt");
  writeFileSync(file, "original\n", "utf-8");

  const fh = FileHistory.loadFromDir(sessionDir);
  // Pre-edit snapshot (what the engine hook does before Write/Edit/ApplyPatch).
  fh.saveSnapshot(file);
  // The edit.
  writeFileSync(file, "modified\n", "utf-8");

  const target = latestUndoTarget(fh.getAllSnapshots());
  expect(target).not.toBeNull();
  expect(target!.filePath).toBe(file);

  // The backup holds the pre-edit content.
  expect(readFileSync(target!.backupPath, "utf-8")).toBe("original\n");
  expect(readFileSync(file, "utf-8")).toBe("modified\n");

  // Restore → file is back to pre-edit.
  expect(fh.restoreLatest(target!.filePath)).toBe(true);
  expect(readFileSync(file, "utf-8")).toBe("original\n");
});

test("restoreAllToEarliest reverts every file to its pre-first-edit content", () => {
  const a = join(workDir, "a.txt");
  const b = join(workDir, "b.txt");
  writeFileSync(a, "a-orig\n", "utf-8");
  writeFileSync(b, "b-orig\n", "utf-8");

  const fh = FileHistory.loadFromDir(sessionDir);
  // Two rounds of edits on a (only the EARLIEST should be restored), one on b.
  fh.saveSnapshot(a);
  writeFileSync(a, "a-edit1\n", "utf-8");
  fh.saveSnapshot(a);
  writeFileSync(a, "a-edit2\n", "utf-8");
  fh.saveSnapshot(b);
  writeFileSync(b, "b-edit1\n", "utf-8");

  const results = fh.restoreAllToEarliest();
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results.map((r) => r.filePath).sort()).toEqual([a, b].sort());

  // Both back to their ORIGINAL (pre-first-edit) content, not the intermediate.
  expect(readFileSync(a, "utf-8")).toBe("a-orig\n");
  expect(readFileSync(b, "utf-8")).toBe("b-orig\n");
});

test("latestUndoTarget picks the most recently edited of several files", () => {
  const a = join(workDir, "a.txt");
  const b = join(workDir, "b.txt");
  writeFileSync(a, "a0\n", "utf-8");
  writeFileSync(b, "b0\n", "utf-8");

  const fh = FileHistory.loadFromDir(sessionDir);
  fh.saveSnapshot(a); // edit a first
  writeFileSync(a, "a1\n", "utf-8");
  fh.saveSnapshot(b); // then edit b — b is the most recent change
  writeFileSync(b, "b1\n", "utf-8");

  const target = latestUndoTarget(fh.getAllSnapshots());
  expect(target!.filePath).toBe(b);
  fh.restoreLatest(target!.filePath);
  expect(readFileSync(b, "utf-8")).toBe("b0\n");
  // a is untouched by the single-step undo.
  expect(readFileSync(a, "utf-8")).toBe("a1\n");
});

test("turn-level /undo reverts the whole latest turn, keeps earlier turns", () => {
  // The user's reported scenario: file A changed in turn 1, A and B both
  // changed in turn 2. `/undo` should undo ONLY turn 2 (A→turn-2-baseline, B
  // removed) and leave turn 1's change to A intact — then a second `/undo`
  // would peel turn 1.
  const a = join(workDir, "a.txt");
  const b = join(workDir, "b.txt");
  writeFileSync(a, "a-orig\n", "utf-8");

  const fh = FileHistory.loadFromDir(sessionDir);

  // --- turn 1: edit A ---
  fh.saveSnapshot(a, 1);
  writeFileSync(a, "a-turn1\n", "utf-8");

  // --- turn 2: edit A again, and create+edit B ---
  fh.saveSnapshot(a, 2); // pre-turn-2 baseline of A = "a-turn1"
  writeFileSync(a, "a-turn2\n", "utf-8");
  writeFileSync(b, "b-orig\n", "utf-8");
  fh.saveSnapshot(b, 2);
  writeFileSync(b, "b-turn2\n", "utf-8");

  const targets = latestTurnUndoTargets(fh.getAllSnapshots());
  expect(targets.map((t) => t.filePath).sort()).toEqual([a, b].sort());

  const beforeCount = fh.getAllSnapshots().length;
  const results = fh.undoLatestTurn(targets);
  expect(results.every((r) => r.ok)).toBe(true);

  // A reverts to its turn-2 baseline (= turn 1's result), NOT to the original.
  expect(readFileSync(a, "utf-8")).toBe("a-turn1\n");
  // B reverts to its turn-2 baseline ("b-orig"), the state before turn 2 edited it.
  expect(readFileSync(b, "utf-8")).toBe("b-orig\n");

  // Undo now MARKS the turn undone instead of deleting snapshots, so the total
  // count must not shrink (restore() may even append a fresh pre-restore snap).
  expect(fh.getAllSnapshots().length).toBeGreaterThanOrEqual(beforeCount);

  // Marking turn 2 undone makes latestTurnUndoTargets skip it → a second undo
  // now peels turn 1 (only A was touched in turn 1), reverting A to the original.
  const targets2 = latestTurnUndoTargets(fh.getAllSnapshots());
  expect(targets2.map((t) => t.filePath)).toEqual([a]);
  fh.undoLatestTurn(targets2);
  expect(readFileSync(a, "utf-8")).toBe("a-orig\n");
  expect(readFileSync(b, "utf-8")).toBe("b-orig\n");
});

describe("redo (turn-level)", () => {
  test("undo → redo round-trips a modified file back to the turn's result", () => {
    const a = join(workDir, "a.txt");
    writeFileSync(a, "a-orig\n", "utf-8");

    const fh = FileHistory.loadFromDir(sessionDir);
    // turn 5 edits a.
    fh.saveSnapshot(a, 5);
    writeFileSync(a, "a-turn5\n", "utf-8");

    // Undo turn 5 → a back to pre-turn content.
    const targets = latestTurnUndoTargets(fh.getAllSnapshots());
    fh.undoLatestTurn(targets);
    expect(readFileSync(a, "utf-8")).toBe("a-orig\n");

    // Redo is now available for turn 5.
    const redoTargets = latestRedoTargets(fh.getRedoRecords(), fh.getAllSnapshots());
    expect(redoTargets.map((r) => r.filePath)).toEqual([a]);
    expect(redoTargets[0]!.turnSeq).toBe(5);

    const redoResults = fh.redoLatestTurn(redoTargets);
    expect(redoResults.every((r) => r.ok)).toBe(true);
    // File is back to the turn-5 result.
    expect(readFileSync(a, "utf-8")).toBe("a-turn5\n");

    // After redo, turn 5 is no longer undone → no redo available, and undo
    // targets turn 5 again (round-trip is reversible).
    expect(latestRedoTargets(fh.getRedoRecords(), fh.getAllSnapshots())).toEqual([]);
    const undoAgain = latestTurnUndoTargets(fh.getAllSnapshots());
    expect(undoAgain.map((t) => t.filePath)).toEqual([a]);
  });

  test("created file: undo deletes it, redo recreates it with content", () => {
    const f = join(workDir, "created.txt");
    expect(existsSync(f)).toBe(false);

    const fh = FileHistory.loadFromDir(sessionDir);
    // Engine hook simulation: saveSnapshot before the tool runs returns null
    // (file does not exist yet) → record it as created this turn.
    expect(fh.saveSnapshot(f, 3)).toBeNull();
    fh.recordCreated(f, 3);
    // The tool creates the file.
    writeFileSync(f, "brand new\n", "utf-8");

    // Undo turn 3 → the created file is DELETED.
    const targets = latestTurnUndoTargets(fh.getAllSnapshots());
    fh.undoLatestTurn(targets);
    expect(existsSync(f)).toBe(false);

    // Redo turn 3 → the file reappears with its content.
    const redoTargets = latestRedoTargets(fh.getRedoRecords(), fh.getAllSnapshots());
    expect(redoTargets.map((r) => r.filePath)).toEqual([f]);
    expect(redoTargets[0]!.existedBefore).toBe(false);
    fh.redoLatestTurn(redoTargets);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("brand new\n");
  });

  test("created file recorded once even if built then edited in the same turn", () => {
    const f = join(workDir, "twice.txt");
    const fh = FileHistory.loadFromDir(sessionDir);
    // First tool call: file absent → null + recordCreated.
    expect(fh.saveSnapshot(f, 7)).toBeNull();
    fh.recordCreated(f, 7);
    writeFileSync(f, "v1\n", "utf-8");
    // Second tool call in the SAME turn: file now exists → real snapshot, and a
    // second recordCreated must be a no-op (still "created" once).
    fh.saveSnapshot(f, 7);
    fh.recordCreated(f, 7);
    writeFileSync(f, "v2\n", "utf-8");

    // Undo turn 7: file was created this turn → it must be DELETED, not
    // restored to the intra-turn "v1" snapshot.
    const targets = latestTurnUndoTargets(fh.getAllSnapshots());
    fh.undoLatestTurn(targets);
    expect(existsSync(f)).toBe(false);

    const redoTargets = latestRedoTargets(fh.getRedoRecords(), fh.getAllSnapshots());
    // Exactly one redo record for f.
    expect(redoTargets.filter((r) => r.filePath === f)).toHaveLength(1);
    fh.redoLatestTurn(redoTargets);
    // Redo restores the turn's final content.
    expect(readFileSync(f, "utf-8")).toBe("v2\n");
  });

  test("a new live turn after undo invalidates redo", () => {
    const a = join(workDir, "a.txt");
    writeFileSync(a, "a-orig\n", "utf-8");
    const fh = FileHistory.loadFromDir(sessionDir);

    fh.saveSnapshot(a, 1);
    writeFileSync(a, "a-turn1\n", "utf-8");
    fh.undoLatestTurn(latestTurnUndoTargets(fh.getAllSnapshots()));
    // redo available right after undo
    expect(latestRedoTargets(fh.getRedoRecords(), fh.getAllSnapshots())).toHaveLength(1);

    // A fresh turn 2 edits a (new live snapshot) → redo of turn 1 is invalidated.
    fh.saveSnapshot(a, 2);
    writeFileSync(a, "a-turn2\n", "utf-8");
    expect(latestRedoTargets(fh.getRedoRecords(), fh.getAllSnapshots())).toEqual([]);
  });

  test("/undo all (earliest) ignores undone turns and redo material", () => {
    const a = join(workDir, "a.txt");
    writeFileSync(a, "a-orig\n", "utf-8");
    const fh = FileHistory.loadFromDir(sessionDir);

    // turn 1 edits a, turn 2 edits a again.
    fh.saveSnapshot(a, 1);
    writeFileSync(a, "a-turn1\n", "utf-8");
    fh.saveSnapshot(a, 2);
    writeFileSync(a, "a-turn2\n", "utf-8");

    // Undo turn 2 (marks it undone, stores redo material).
    fh.undoLatestTurn(latestTurnUndoTargets(fh.getAllSnapshots()));
    expect(readFileSync(a, "utf-8")).toBe("a-turn1\n");

    // /undo all must go to the SESSION baseline (turn-1 pre-edit = "a-orig"),
    // not be confused by undone turn-2 snapshots or the redo backup.
    const results = fh.restoreAllToEarliest();
    expect(results.every((r) => r.ok)).toBe(true);
    expect(readFileSync(a, "utf-8")).toBe("a-orig\n");
  });
});
