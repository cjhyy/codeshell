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
import { latestUndoTarget } from "./undo-target.js";

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
