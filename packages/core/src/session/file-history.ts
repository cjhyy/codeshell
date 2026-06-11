/**
 * File history — automatic backup of files before modifications.
 *
 * Stores snapshots in the session directory under file-history/.
 * Supports restoring files to a previous state.
 */

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { earliestSnapshotsPerFile } from "./undo-target.js";

export interface FileSnapshot {
  filePath: string;
  timestamp: number;
  backupPath: string;
  hash: string;
  size: number;
  /**
   * The conversation turn (one user message = one turn) this snapshot was taken
   * in. Powers turn-level undo (`latestTurnUndoTargets`). Optional so snapshots
   * written before this feature still load; absent ones share the "undefined"
   * bucket and degrade to whole-session undo.
   */
  turnSeq?: number;
  /**
   * Set when this turn has been undone (by `undoLatestTurn`). Undone turns are
   * SKIPPED by undo target selection (so the next undo peels the prior turn)
   * but kept on disk so the turn can be re-applied via `redoLatestTurn`. Cleared
   * on redo. Replaces the earlier "delete on undo" approach so redo has material.
   */
  undone?: boolean;
}

/**
 * Redo material captured when a turn is undone: the file's content AT THE TIME
 * OF UNDO (i.e. the turn's result), so `redoLatestTurn` can re-apply it.
 * Stored separately from `snapshots` so it never pollutes undo selection
 * (latestUndoTarget / earliestSnapshotsPerFile / latestTurnUndoTargets).
 */
export interface RedoRecord {
  filePath: string;
  /** The turn this redo restores (matches the undone snapshots' turnSeq). */
  turnSeq: number;
  /** Backup of the post-turn content to re-apply on redo. */
  backupPath: string;
  /**
   * Whether the file EXISTED before this turn (had a pre-turn snapshot). False
   * means the turn CREATED it — undo deleted it, so redo must recreate it (and
   * conversely undo of a created file means "remove", handled by the caller).
   */
  existedBefore: boolean;
}

/**
 * Marks that a file was CREATED in a given turn (it did not exist before the
 * turn's first edit). Recorded by `recordCreated` from the engine hook when the
 * pre-edit `saveSnapshot` returns null (file absent). Drives the "undo deletes a
 * newly-created file / redo recreates it" behaviour. Like snapshots, a created
 * marker is flipped `undone` on undo and cleared on redo rather than deleted, so
 * the create/delete can round-trip.
 */
export interface CreatedMarker {
  filePath: string;
  turnSeq: number;
  undone?: boolean;
}

/** On-disk index shape (v2). Legacy histories stored a bare FileSnapshot[]. */
interface HistoryIndex {
  snapshots: FileSnapshot[];
  redoRecords: RedoRecord[];
  created: CreatedMarker[];
}

export class FileHistory {
  private readonly historyDir: string;
  private snapshots: FileSnapshot[] = [];
  /**
   * Redo material for undone turns, kept SEPARATE from `snapshots` so it never
   * pollutes undo selection (latestTurnUndoTargets / earliestSnapshotsPerFile).
   */
  private redoRecords: RedoRecord[] = [];
  /** Per-turn "this file was created" markers (see CreatedMarker). */
  private created: CreatedMarker[] = [];

  constructor(sessionDir: string) {
    this.historyDir = join(sessionDir, "file-history");
    mkdirSync(this.historyDir, { recursive: true });
  }

  /**
   * Save a snapshot of a file before it is modified.
   * Returns the snapshot record, or null if the file doesn't exist.
   *
   * `turnSeq` tags the snapshot with the current conversation turn so a later
   * `/undo` can revert exactly the files that turn changed (see
   * latestTurnUndoTargets). Omit it for callers without turn context.
   */
  saveSnapshot(filePath: string, turnSeq?: number): FileSnapshot | null {
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) return null;

    try {
      const content = readFileSync(absPath);
      const hash = createHash("md5").update(content).digest("hex");

      // Check if we already have this exact (path, content) for this turn. Dedup
      // is per-turn: the same content re-snapshotted in a later turn is a real
      // new pre-turn baseline and must be recorded, or turn-level undo would
      // miss it. Within a turn, re-snapshotting unchanged content is a no-op.
      const existing = this.snapshots.find(
        (s) => s.filePath === absPath && s.hash === hash && s.turnSeq === turnSeq,
      );
      if (existing) return existing;

      // Create backup. The filename must uniquely identify (path, content): a
      // bare 100-char tail of the path can collide for two different files
      // whose tails coincide, and with the same ms timestamp the second
      // copyFileSync would silently overwrite the first backup while both
      // index entries point to it (restore would then return the wrong file's
      // content). Fold a full-path hash and the content hash into the name so
      // distinct (path, content) pairs never share a backup file.
      const timestamp = Date.now();
      const pathHash = createHash("md5").update(absPath).digest("hex").slice(0, 8);
      const safeName = absPath.replace(/[/\\:]/g, "_").slice(-80);
      const backupPath = join(
        this.historyDir,
        `${timestamp}_${pathHash}_${hash.slice(0, 8)}_${safeName}`,
      );

      copyFileSync(absPath, backupPath);

      const snapshot: FileSnapshot = {
        filePath: absPath,
        timestamp,
        backupPath,
        hash,
        size: content.length,
        ...(turnSeq === undefined ? {} : { turnSeq }),
      };

      this.snapshots.push(snapshot);

      // Write index
      this.saveIndex();

      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Record that `filePath` was CREATED in `turnSeq` — called by the engine hook
   * when the pre-edit saveSnapshot returns null (file did not exist yet). Idempotent
   * per (path, turn): a file built then edited again in the same turn is recorded
   * once, so undo deletes it (rather than restoring an intra-turn snapshot). A
   * marker already flipped `undone` from a prior undo is reused as-is (not
   * re-armed) — only fresh turns create new markers.
   */
  recordCreated(filePath: string, turnSeq: number): void {
    const absPath = resolve(filePath);
    const existing = this.created.find(
      (c) => c.filePath === absPath && c.turnSeq === turnSeq,
    );
    if (existing) return;
    this.created.push({ filePath: absPath, turnSeq });
    this.saveIndex();
  }

  /** Redo material captured by past undos (see RedoRecord). Returns a copy. */
  getRedoRecords(): RedoRecord[] {
    return [...this.redoRecords];
  }

  /**
   * Get all snapshots for a specific file.
   */
  getSnapshots(filePath: string): FileSnapshot[] {
    const absPath = resolve(filePath);
    return this.snapshots
      .filter((s) => s.filePath === absPath)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Restore a file to a specific snapshot.
   */
  restore(snapshot: FileSnapshot): boolean {
    try {
      if (!existsSync(snapshot.backupPath)) return false;
      // Save current state before restoring
      this.saveSnapshot(snapshot.filePath);
      copyFileSync(snapshot.backupPath, snapshot.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Restore a file to its most recent snapshot.
   */
  restoreLatest(filePath: string): boolean {
    const snapshots = this.getSnapshots(filePath);
    if (snapshots.length === 0) return false;
    return this.restore(snapshots[0]);
  }

  /**
   * Get all tracked files.
   */
  getTrackedFiles(): string[] {
    return [...new Set(this.snapshots.map((s) => s.filePath))];
  }

  /**
   * Restore EVERY tracked file to its earliest snapshot — the state before the
   * first AI edit this session. Powers `/undo all`. Targets are computed up
   * front (restore() appends a new snapshot, so reading them lazily mid-loop
   * would be unstable). Returns a per-file result so a partial failure doesn't
   * hide which files reverted.
   */
  restoreAllToEarliest(): Array<{ filePath: string; ok: boolean }> {
    const targets = earliestSnapshotsPerFile(this.snapshots);
    return targets.map((snap) => ({ filePath: snap.filePath, ok: this.restore(snap) }));
  }

  /**
   * Capture the file's CURRENT on-disk content into a fresh redo backup and
   * append a RedoRecord. `existedBefore` distinguishes a modified file (true,
   * redo re-applies content) from a turn-created file (false, redo recreates it).
   * Returns false if the file can't be read (then no record is added).
   */
  private captureRedoBackup(
    filePath: string,
    turnSeq: number,
    existedBefore: boolean,
  ): boolean {
    try {
      if (!existsSync(filePath)) return false;
      const content = readFileSync(filePath);
      const hash = createHash("md5").update(content).digest("hex");
      const timestamp = Date.now();
      const pathHash = createHash("md5").update(filePath).digest("hex").slice(0, 8);
      const safeName = filePath.replace(/[/\\:]/g, "_").slice(-80);
      const backupPath = join(
        this.historyDir,
        `redo_${timestamp}_${pathHash}_${hash.slice(0, 8)}_${safeName}`,
      );
      copyFileSync(filePath, backupPath);
      this.redoRecords.push({ filePath, turnSeq, backupPath, existedBefore });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Turn-level undo: revert every file the most recent conversation turn changed
   * back to its pre-turn state. Unlike the earlier "delete on undo" approach this
   * now (a) captures the turn's RESULT as redo material so `redoLatestTurn` can
   * re-apply it, and (b) MARKS the turn's snapshots `undone` rather than deleting
   * them — `latestTurnUndoTargets` skips undone turns, so a subsequent `/undo`
   * still peels the previous turn ("onion"). Powers `/undo`.
   *
   * Files the turn CREATED (recorded via recordCreated) are DELETED on undo (with
   * existedBefore:false redo material) instead of restored. `targets` come from
   * latestTurnUndoTargets so preview and restore agree. Returns per-file results.
   */
  undoLatestTurn(targets: FileSnapshot[]): Array<{ filePath: string; ok: boolean }> {
    // The turn being undone = the turnSeq shared by the targets (all from the
    // same latest live turn). Created-only turns may have no snapshot targets, so
    // fall back to the created markers' turn.
    const undoneTurn =
      targets[0]?.turnSeq ?? this.latestLiveCreatedTurn();
    if (undoneTurn === undefined) return [];

    const results: Array<{ filePath: string; ok: boolean }> = [];

    // Files created this turn: delete them (after stashing redo material). Skip
    // files that are also a restore target — created wins (the file didn't exist
    // pre-turn, so its "pre-turn state" is "absent" → delete, not restore).
    const createdThisTurn = this.created.filter(
      (c) => !c.undone && c.turnSeq === undoneTurn,
    );
    const createdPaths = new Set(createdThisTurn.map((c) => c.filePath));
    for (const c of createdThisTurn) {
      this.captureRedoBackup(c.filePath, undoneTurn, false);
      let ok = true;
      try {
        if (existsSync(c.filePath)) rmSync(c.filePath, { force: true });
      } catch {
        ok = false;
      }
      results.push({ filePath: c.filePath, ok });
    }

    // Modified (pre-existing) files: stash the current result as redo material,
    // then restore the pre-turn content.
    for (const snap of targets) {
      if (createdPaths.has(snap.filePath)) continue;
      this.captureRedoBackup(snap.filePath, undoneTurn, true);
      results.push({ filePath: snap.filePath, ok: this.restore(snap) });
    }

    // Mark the turn undone (snapshots + created markers) — keep them on disk so
    // redo has material and the turn is re-applyable.
    for (const s of this.snapshots) {
      if (s.turnSeq === undoneTurn) s.undone = true;
    }
    for (const c of this.created) {
      if (c.turnSeq === undoneTurn) c.undone = true;
    }
    this.saveIndex();
    return results;
  }

  /** Greatest turnSeq among not-yet-undone created markers, or undefined. */
  private latestLiveCreatedTurn(): number | undefined {
    let max: number | undefined;
    for (const c of this.created) {
      if (c.undone) continue;
      if (max === undefined || c.turnSeq > max) max = c.turnSeq;
    }
    return max;
  }

  /**
   * Turn-level redo: re-apply a previously undone turn. For each redo target,
   * write the stashed post-turn content back to disk (existedBefore:false
   * records RECREATE a turn-created file). Then clear the `undone` flags on that
   * turn's snapshots and created markers, and drop the consumed redo records.
   *
   * `redoTargets` come from latestRedoTargets (which guarantees they are the
   * latest still-undone turn). Returns per-file results.
   */
  redoLatestTurn(redoTargets: RedoRecord[]): Array<{ filePath: string; ok: boolean }> {
    if (redoTargets.length === 0) return [];
    const turn = redoTargets[0]!.turnSeq;

    const results = redoTargets.map((rec) => {
      let ok = false;
      try {
        if (existsSync(rec.backupPath)) {
          copyFileSync(rec.backupPath, rec.filePath);
          ok = true;
        }
      } catch {
        ok = false;
      }
      return { filePath: rec.filePath, ok };
    });

    // Un-mark the turn: it is live again, so undo can re-target it.
    for (const s of this.snapshots) {
      if (s.turnSeq === turn) s.undone = false;
    }
    for (const c of this.created) {
      if (c.turnSeq === turn) c.undone = false;
    }
    // Consume the redo records for this turn (and remove their backups).
    const consumed = new Set(redoTargets);
    this.redoRecords = this.redoRecords.filter((r) => {
      if (consumed.has(r) || r.turnSeq === turn) {
        try {
          if (existsSync(r.backupPath)) rmSync(r.backupPath, { force: true });
        } catch {
          // best-effort cleanup
        }
        return false;
      }
      return true;
    });
    this.saveIndex();
    return results;
  }

  /**
   * All snapshots in record (chronological) order. Used by undo to pick the
   * single most-recent modification across every file (see latestUndoTarget).
   * Returns a copy so callers can't mutate the internal list.
   */
  getAllSnapshots(): FileSnapshot[] {
    return [...this.snapshots];
  }

  private saveIndex(): void {
    try {
      const indexPath = join(this.historyDir, "index.json");
      const index: HistoryIndex = {
        snapshots: this.snapshots,
        redoRecords: this.redoRecords,
        created: this.created,
      };
      writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
    } catch {
      // Silent fail
    }
  }

  static loadFromDir(sessionDir: string): FileHistory {
    const history = new FileHistory(sessionDir);
    const indexPath = join(history.historyDir, "index.json");
    if (existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(readFileSync(indexPath, "utf-8"));
        if (Array.isArray(parsed)) {
          // Legacy v1: bare FileSnapshot[]. No redo/created material existed yet.
          history.snapshots = parsed;
        } else {
          const index = parsed as Partial<HistoryIndex>;
          history.snapshots = index.snapshots ?? [];
          history.redoRecords = index.redoRecords ?? [];
          history.created = index.created ?? [];
        }
      } catch {
        // Start fresh
      }
    }
    return history;
  }
}
