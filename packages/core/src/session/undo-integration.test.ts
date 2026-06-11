/**
 * Integration: the real /undo path through FileHistory + latestUndoTarget.
 * Verifies that snapshot-before-edit + "newest snapshot" selection + restore
 * actually brings a file's content back to its pre-edit state — the contract
 * the TUI /undo command relies on.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileHistory } from "./file-history.js";
import { latestUndoTarget, latestTurnUndoTargets } from "./undo-target.js";

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

  const results = fh.undoLatestTurn(targets);
  expect(results.every((r) => r.ok)).toBe(true);

  // A reverts to its turn-2 baseline (= turn 1's result), NOT to the original.
  expect(readFileSync(a, "utf-8")).toBe("a-turn1\n");
  // B reverts to its turn-2 baseline ("b-orig"), the state before turn 2 edited it.
  expect(readFileSync(b, "utf-8")).toBe("b-orig\n");

  // undoLatestTurn consumed turn 2's snapshots → a second undo now peels turn 1
  // (only A was touched in turn 1), reverting A to the original. B is untouched.
  const targets2 = latestTurnUndoTargets(fh.getAllSnapshots());
  expect(targets2.map((t) => t.filePath)).toEqual([a]);
  fh.undoLatestTurn(targets2);
  expect(readFileSync(a, "utf-8")).toBe("a-orig\n");
  expect(readFileSync(b, "utf-8")).toBe("b-orig\n");
});
