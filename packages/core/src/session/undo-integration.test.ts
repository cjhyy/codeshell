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
  readdirSync,
  statSync,
  symlinkSync,
  chmodSync,
  renameSync,
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
  if (process.platform !== "win32") expect(statSync(target!.backupPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf-8")).toBe("modified\n");

  // Restore → file is back to pre-edit.
  expect(fh.restoreLatest(target!.filePath)).toBe(true);
  expect(readFileSync(file, "utf-8")).toBe("original\n");
  const indexFile = join(sessionDir, "file-history", "index.json");
  if (process.platform !== "win32") expect(statSync(indexFile).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(sessionDir, "file-history")).some((name) => name.endsWith(".tmp"))).toBe(
    false,
  );
});

test("load drops forged backups outside history and symlink backups", () => {
  const target = join(workDir, "target.txt");
  const outside = join(root, "outside-secret.txt");
  const historyDir = join(sessionDir, "file-history");
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(target, "safe\n", "utf-8");
  writeFileSync(outside, "secret\n", "utf-8");
  const symlinkBackup = join(historyDir, "symlink-backup");
  if (process.platform !== "win32") symlinkSync(outside, symlinkBackup);
  const records = [
    {
      filePath: target,
      timestamp: 1,
      backupPath: outside,
      hash: "x",
      size: 7,
    },
    ...(process.platform === "win32"
      ? []
      : [
          {
            filePath: target,
            timestamp: 2,
            backupPath: symlinkBackup,
            hash: "y",
            size: 7,
          },
        ]),
  ];
  writeFileSync(
    join(historyDir, "index.json"),
    JSON.stringify({ snapshots: records, redoRecords: [], created: [] }),
    "utf-8",
  );

  const loaded = FileHistory.loadFromDir(sessionDir);
  expect(loaded.getAllSnapshots()).toEqual([]);
  expect(loaded.restoreLatest(target)).toBe(false);
  expect(readFileSync(target, "utf-8")).toBe("safe\n");
});

test("returned snapshots cannot be mutated into an arbitrary restore target", () => {
  const tracked = join(workDir, "tracked.txt");
  const outside = join(root, "outside.txt");
  writeFileSync(tracked, "tracked-before\n", "utf-8");
  writeFileSync(outside, "outside-safe\n", "utf-8");
  const fh = FileHistory.loadFromDir(sessionDir);
  fh.saveSnapshot(tracked, 1);
  writeFileSync(tracked, "tracked-after\n", "utf-8");

  const forged = fh.getAllSnapshots()[0]!;
  forged.filePath = outside;

  expect(fh.restore(forged)).toBe(false);
  expect(readFileSync(outside, "utf-8")).toBe("outside-safe\n");
  expect(fh.getAllSnapshots()[0]!.filePath).toBe(tracked);
});

test("saveSnapshot returns a value copy, not the mutable internal record", () => {
  const tracked = join(workDir, "tracked.txt");
  const outside = join(root, "outside.txt");
  writeFileSync(tracked, "before\n", "utf-8");
  const fh = FileHistory.loadFromDir(sessionDir);
  const returned = fh.saveSnapshot(tracked, 1)!;
  returned.filePath = outside;

  expect(fh.getAllSnapshots()[0]!.filePath).toBe(tracked);
  expect(fh.restore(returned)).toBe(false);
});

test("stale FileHistory instances merge snapshots instead of losing updates", () => {
  const a = join(workDir, "a.txt");
  const b = join(workDir, "b.txt");
  writeFileSync(a, "a-before\n", "utf-8");
  writeFileSync(b, "b-before\n", "utf-8");
  const first = FileHistory.loadFromDir(sessionDir);
  const second = FileHistory.loadFromDir(sessionDir);

  expect(first.saveSnapshot(a, 1)).not.toBeNull();
  expect(second.saveSnapshot(b, 1)).not.toBeNull();

  const reloaded = FileHistory.loadFromDir(sessionDir);
  expect(reloaded.getAllSnapshots().map((snapshot) => snapshot.filePath).sort()).toEqual(
    [a, b].sort(),
  );
});

test("undo and redo preserve executable permission bits while backups remain private", () => {
  if (process.platform === "win32") return;
  const script = join(workDir, "run.sh");
  writeFileSync(script, "#!/bin/sh\necho before\n", { mode: 0o755 });
  chmodSync(script, 0o755);
  const fh = FileHistory.loadFromDir(sessionDir);
  const snapshot = fh.saveSnapshot(script, 6)!;
  expect(statSync(snapshot.backupPath).mode & 0o777).toBe(0o600);
  writeFileSync(script, "#!/bin/sh\necho after\n", "utf-8");
  chmodSync(script, 0o700);

  expect(fh.undoLatestTurn(fh.getLatestTurnUndoPlan()!.snapshots)[0]?.ok).toBe(true);
  expect(statSync(script).mode & 0o777).toBe(0o755);

  expect(fh.redoLatestTurn(fh.getLatestRedoRecords())[0]?.ok).toBe(true);
  expect(statSync(script).mode & 0o777).toBe(0o700);
});

test("legacy snapshots without turnSeq can undo, reload, and redo", () => {
  const tracked = join(workDir, "legacy.txt");
  writeFileSync(tracked, "legacy-before\n", "utf-8");
  const fh = FileHistory.loadFromDir(sessionDir);
  fh.saveSnapshot(tracked);
  writeFileSync(tracked, "legacy-after\n", "utf-8");

  expect(fh.undoLatestTurn(fh.getLatestTurnUndoPlan()!.snapshots)[0]?.ok).toBe(true);
  expect(readFileSync(tracked, "utf-8")).toBe("legacy-before\n");

  const reloaded = FileHistory.loadFromDir(sessionDir);
  expect(reloaded.getLatestRedoRecords()).toHaveLength(1);
  expect(reloaded.redoLatestTurn(reloaded.getLatestRedoRecords())[0]?.ok).toBe(true);
  expect(readFileSync(tracked, "utf-8")).toBe("legacy-after\n");
});

test("restore refuses a destination whose parent was replaced by a symlink", () => {
  if (process.platform === "win32") return;
  const parent = join(workDir, "parent");
  const movedParent = join(workDir, "parent-real");
  const tracked = join(parent, "tracked.txt");
  mkdirSync(parent);
  writeFileSync(tracked, "before\n", "utf-8");
  const fh = FileHistory.loadFromDir(sessionDir);
  const snapshot = fh.saveSnapshot(tracked, 1)!;
  writeFileSync(tracked, "after\n", "utf-8");
  renameSync(parent, movedParent);
  symlinkSync(movedParent, parent);

  expect(fh.restore(snapshot)).toBe(false);
  expect(readFileSync(join(movedParent, "tracked.txt"), "utf-8")).toBe("after\n");
});

test("restore refuses to follow a destination symlink", () => {
  if (process.platform === "win32") return;
  const tracked = join(workDir, "tracked.txt");
  const outside = join(root, "outside.txt");
  writeFileSync(tracked, "tracked-before\n", "utf-8");
  writeFileSync(outside, "outside-safe\n", "utf-8");
  const fh = FileHistory.loadFromDir(sessionDir);
  const snapshot = fh.saveSnapshot(tracked, 1)!;
  rmSync(tracked);
  symlinkSync(outside, tracked);

  expect(fh.restore(snapshot)).toBe(false);
  expect(readFileSync(outside, "utf-8")).toBe("outside-safe\n");
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

  test("forged redo values cannot overwrite or delete an outside file", () => {
    const a = join(workDir, "a.txt");
    const outside = join(root, "outside.txt");
    writeFileSync(a, "a-orig\n", "utf-8");
    writeFileSync(outside, "outside-safe\n", "utf-8");
    const fh = FileHistory.loadFromDir(sessionDir);
    fh.saveSnapshot(a, 5);
    writeFileSync(a, "a-turn5\n", "utf-8");
    fh.undoLatestTurn(latestTurnUndoTargets(fh.getAllSnapshots()));

    const forged = fh.getRedoRecords()[0]!;
    forged.filePath = outside;
    forged.backupPath = outside;
    expect(fh.redoLatestTurn([forged])).toEqual([{ filePath: outside, ok: false }]);
    expect(readFileSync(outside, "utf-8")).toBe("outside-safe\n");
    expect(fh.getRedoRecords()).toHaveLength(1);
  });

  test("failed redo keeps its material so the operation can be retried", () => {
    const a = join(workDir, "a.txt");
    writeFileSync(a, "a-orig\n", "utf-8");
    const fh = FileHistory.loadFromDir(sessionDir);
    fh.saveSnapshot(a, 5);
    writeFileSync(a, "a-turn5\n", "utf-8");
    fh.undoLatestTurn(latestTurnUndoTargets(fh.getAllSnapshots()));
    const redo = fh.getRedoRecords()[0]!;
    rmSync(redo.backupPath);

    expect(fh.redoLatestTurn([redo])).toEqual([{ filePath: a, ok: false }]);
    expect(fh.getRedoRecords()).toHaveLength(1);

    writeFileSync(redo.backupPath, "a-turn5\n", "utf-8");
    expect(fh.redoLatestTurn(fh.getRedoRecords())).toEqual([{ filePath: a, ok: true }]);
    expect(readFileSync(a, "utf-8")).toBe("a-turn5\n");
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
    const plan = fh.getLatestTurnUndoPlan();
    expect(plan?.filePaths).toEqual([f]);
    fh.undoLatestTurn(plan!.snapshots);
    expect(existsSync(f)).toBe(false);

    // Redo turn 3 → the file reappears with its content.
    const redoTargets = latestRedoTargets(fh.getRedoRecords(), fh.getAllSnapshots());
    expect(redoTargets.map((r) => r.filePath)).toEqual([f]);
    expect(redoTargets[0]!.existedBefore).toBe(false);
    fh.redoLatestTurn(redoTargets);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, "utf-8")).toBe("brand new\n");
  });

  test("undo refuses a created path whose parent was replaced by a symlink", () => {
    if (process.platform === "win32") return;
    const parent = join(workDir, "parent");
    const movedParent = join(workDir, "parent-original");
    const outsideParent = join(root, "outside-parent");
    const created = join(parent, "created.txt");
    mkdirSync(parent);
    mkdirSync(outsideParent);
    const fh = FileHistory.loadFromDir(sessionDir);
    fh.recordCreated(created, 3);
    writeFileSync(created, "turn-created\n", "utf-8");
    renameSync(parent, movedParent);
    writeFileSync(join(outsideParent, "created.txt"), "outside-safe\n", "utf-8");
    symlinkSync(outsideParent, parent);

    const plan = fh.getLatestTurnUndoPlan()!;
    expect(fh.undoLatestTurn(plan.snapshots)).toEqual([{ filePath: created, ok: false }]);
    expect(readFileSync(join(outsideParent, "created.txt"), "utf-8")).toBe("outside-safe\n");
    expect(readFileSync(join(movedParent, "created.txt"), "utf-8")).toBe("turn-created\n");
    expect(fh.getRedoRecords()).toEqual([]);
  });

  test("a create-only latest turn wins over an older snapshot turn", () => {
    const old = join(workDir, "old.txt");
    const created = join(workDir, "created.txt");
    writeFileSync(old, "old-before\n", "utf-8");
    const fh = FileHistory.loadFromDir(sessionDir);
    fh.saveSnapshot(old, 1);
    writeFileSync(old, "old-after\n", "utf-8");
    fh.recordCreated(created, 2);
    writeFileSync(created, "new\n", "utf-8");

    const plan = fh.getLatestTurnUndoPlan();
    expect(plan?.turnSeq).toBe(2);
    expect(plan?.snapshots).toEqual([]);
    expect(plan?.filePaths).toEqual([created]);
    expect(fh.undoLatestTurn(plan!.snapshots)).toEqual([{ filePath: created, ok: true }]);
    expect(existsSync(created)).toBe(false);
    expect(readFileSync(old, "utf-8")).toBe("old-after\n");
  });

  test("a deleted file round-trips through undo and redo", () => {
    const f = join(workDir, "deleted.txt");
    writeFileSync(f, "before-delete\n", "utf-8");
    const fh = FileHistory.loadFromDir(sessionDir);
    fh.saveSnapshot(f, 4);
    rmSync(f);

    const plan = fh.getLatestTurnUndoPlan()!;
    expect(fh.undoLatestTurn(plan.snapshots)).toEqual([{ filePath: f, ok: true }]);
    expect(readFileSync(f, "utf-8")).toBe("before-delete\n");

    const redo = fh.getRedoRecords();
    expect(redo[0]?.existedAfter).toBe(false);
    expect(fh.redoLatestTurn(redo)).toEqual([{ filePath: f, ok: true }]);
    expect(existsSync(f)).toBe(false);
  });

  test("forged undo values cannot redirect an undo to another file", () => {
    const tracked = join(workDir, "tracked.txt");
    const outside = join(root, "outside.txt");
    writeFileSync(tracked, "before\n", "utf-8");
    writeFileSync(outside, "outside-safe\n", "utf-8");
    const fh = FileHistory.loadFromDir(sessionDir);
    fh.saveSnapshot(tracked, 8);
    writeFileSync(tracked, "after\n", "utf-8");
    const forged = fh.getLatestTurnUndoPlan()!.snapshots;
    forged[0]!.filePath = outside;

    expect(fh.undoLatestTurn(forged).every((result) => !result.ok)).toBe(true);
    expect(readFileSync(outside, "utf-8")).toBe("outside-safe\n");
    expect(readFileSync(tracked, "utf-8")).toBe("after\n");
  });

  test("failed redo capture leaves files untouched and discards partial material", () => {
    if (process.platform === "win32") return;
    const a = join(workDir, "a.txt");
    const b = join(workDir, "b.txt");
    const outside = join(root, "outside.txt");
    writeFileSync(a, "a-before\n", "utf-8");
    writeFileSync(b, "b-before\n", "utf-8");
    writeFileSync(outside, "outside-safe\n", "utf-8");
    const fh = FileHistory.loadFromDir(sessionDir);
    fh.saveSnapshot(a, 9);
    fh.saveSnapshot(b, 9);
    writeFileSync(a, "a-after\n", "utf-8");
    rmSync(b);
    symlinkSync(outside, b);

    const result = fh.undoLatestTurn(fh.getLatestTurnUndoPlan()!.snapshots);
    expect(result.every((item) => !item.ok)).toBe(true);
    expect(readFileSync(a, "utf-8")).toBe("a-after\n");
    expect(readFileSync(outside, "utf-8")).toBe("outside-safe\n");
    expect(fh.getRedoRecords()).toEqual([]);
    expect(fh.getLatestRedoRecords()).toEqual([]);
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

  test("a new create-only turn after undo also invalidates redo", () => {
    const a = join(workDir, "a.txt");
    const created = join(workDir, "created.txt");
    writeFileSync(a, "a-orig\n", "utf-8");
    const fh = FileHistory.loadFromDir(sessionDir);
    fh.saveSnapshot(a, 1);
    writeFileSync(a, "a-turn1\n", "utf-8");
    fh.undoLatestTurn(fh.getLatestTurnUndoPlan()!.snapshots);
    expect(fh.getLatestRedoRecords()).toHaveLength(1);

    fh.recordCreated(created, 2);
    writeFileSync(created, "new turn\n", "utf-8");
    expect(fh.getLatestRedoRecords()).toEqual([]);
    expect(fh.redoLatestTurn(fh.getRedoRecords()).every((result) => !result.ok)).toBe(true);
    expect(readFileSync(a, "utf-8")).toBe("a-orig\n");
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
