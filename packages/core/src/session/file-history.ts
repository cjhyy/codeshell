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
  copyFileSync,
  chmodSync,
  lstatSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { earliestSnapshotsPerFile, latestRedoTargets } from "./undo-target.js";
import { acquireFileLock, writeFileAtomic } from "../utils/file-mutex.js";

export interface FileSnapshot {
  filePath: string;
  timestamp: number;
  backupPath: string;
  hash: string;
  size: number;
  /** Original POSIX permission bits, restored independently of backup privacy. */
  mode?: number;
  /** Canonical location at capture time, used to detect parent symlink swaps. */
  realPath?: string;
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
  /** False when the turn's result was file absence (for example a delete). */
  existedAfter?: boolean;
  /** Post-turn POSIX permission bits to restore on redo. */
  mode?: number;
  /** Canonical location of the target at capture time. */
  realPath?: string;
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
  /** Canonical destination planned before the creating tool ran. */
  realPath?: string;
  undone?: boolean;
}

/** On-disk index shape (v2). Legacy histories stored a bare FileSnapshot[]. */
interface HistoryIndex {
  snapshots: FileSnapshot[];
  redoRecords: RedoRecord[];
  created: CreatedMarker[];
}

export interface TurnUndoPlan {
  /** Undefined denotes a legacy, pre-turnSeq history bucket. */
  turnSeq?: number;
  snapshots: FileSnapshot[];
  createdPaths: string[];
  filePaths: string[];
}

const LEGACY_TURN = Number.MIN_SAFE_INTEGER;

export class FileHistory {
  private readonly historyDir: string;
  private lockDepth = 0;
  private snapshots: FileSnapshot[] = [];
  /**
   * Redo material for undone turns, kept SEPARATE from `snapshots` so it never
   * pollutes undo selection (latestTurnUndoTargets / earliestSnapshotsPerFile).
   */
  private redoRecords: RedoRecord[] = [];
  /** Per-turn "this file was created" markers (see CreatedMarker). */
  private created: CreatedMarker[] = [];

  constructor(sessionDir: string) {
    this.historyDir = resolve(sessionDir, "file-history");
    mkdirSync(this.historyDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.historyDir, 0o700);
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
    return this.withCurrentIndex(() => this.saveSnapshotUnlocked(filePath, turnSeq));
  }

  private saveSnapshotUnlocked(filePath: string, turnSeq?: number): FileSnapshot | null {
    if (turnSeq !== undefined && !isFiniteTurn(turnSeq)) return null;
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) return null;

    try {
      const sourceInfo = lstatSync(absPath);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) return null;
      const realPath = realpathSync(absPath);
      const content = readFileSync(absPath);
      const hash = createHash("md5").update(content).digest("hex");

      // Check if we already have this exact (path, content) for this turn. Dedup
      // is per-turn: the same content re-snapshotted in a later turn is a real
      // new pre-turn baseline and must be recorded, or turn-level undo would
      // miss it. Within a turn, re-snapshotting unchanged content is a no-op.
      const existing = this.snapshots.find(
        (s) => s.filePath === absPath && s.hash === hash && s.turnSeq === turnSeq,
      );
      if (existing) return { ...existing };

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
      if (process.platform !== "win32") chmodSync(backupPath, 0o600);

      const snapshot: FileSnapshot = {
        filePath: absPath,
        timestamp,
        backupPath,
        hash,
        size: content.length,
        mode: sourceInfo.mode & 0o7777,
        realPath,
        ...(turnSeq === undefined ? {} : { turnSeq }),
      };

      this.snapshots.push(snapshot);

      if (!this.saveIndex()) {
        this.snapshots.pop();
        try {
          rmSync(backupPath, { force: true });
        } catch {
          // The unreferenced private backup is harmless; preserve the write failure result.
        }
        return null;
      }

      return { ...snapshot };
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
    this.withCurrentIndex(() => this.recordCreatedUnlocked(filePath, turnSeq));
  }

  private recordCreatedUnlocked(filePath: string, turnSeq: number): void {
    if (!isFiniteTurn(turnSeq)) return;
    const absPath = resolve(filePath);
    const existing = this.created.find(
      (c) => c.filePath === absPath && c.turnSeq === turnSeq,
    );
    if (existing) return;
    const realPath = this.canonicalizeNewPath(absPath);
    const marker: CreatedMarker = {
      filePath: absPath,
      turnSeq,
      ...(realPath ? { realPath } : {}),
    };
    this.created.push(marker);
    if (!this.saveIndex()) this.created.pop();
  }

  /**
   * Capture a create marker before the tool runs, but do not persist it yet.
   * `lstat` (rather than `existsSync`) deliberately treats dangling symlinks as
   * existing: a failed/no-follow Write must never turn such a path into a
   * create marker that a later undo would remove.
   */
  prepareCreated(filePath: string, turnSeq: number): CreatedMarker | null {
    if (!isFiniteTurn(turnSeq)) return null;
    const absPath = resolve(filePath);
    try {
      lstatSync(absPath);
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const realPath = this.canonicalizeNewPath(absPath);
    return {
      filePath: absPath,
      turnSeq,
      ...(realPath ? { realPath } : {}),
    };
  }

  /** Persist a marker previously returned by prepareCreated after tool success. */
  commitCreated(marker: CreatedMarker): void {
    this.withCurrentIndex(() => this.commitCreatedUnlocked(marker));
  }

  private commitCreatedUnlocked(marker: CreatedMarker): void {
    if (!isCreatedMarker(marker)) return;
    const existing = this.created.find(
      (candidate) =>
        candidate.filePath === marker.filePath && candidate.turnSeq === marker.turnSeq,
    );
    if (existing) return;
    this.created.push({ ...marker, undone: undefined });
    if (!this.saveIndex()) this.created.pop();
  }

  /** Redo material captured by past undos (see RedoRecord). Returns a copy. */
  getRedoRecords(): RedoRecord[] {
    return this.redoRecords.map((record) => ({ ...record }));
  }

  /** Latest redo records after accounting for create-only live turns. */
  getLatestRedoRecords(): RedoRecord[] {
    const records = latestRedoTargets(this.redoRecords, this.snapshots);
    if (records.length === 0) return [];
    const redoTurn = records[0]!.turnSeq;
    const snapshots = this.snapshots.filter(
      (snapshot) => this.turnKey(snapshot.turnSeq) === redoTurn,
    );
    const markers = this.created.filter((marker) => marker.turnSeq === redoTurn);
    if (
      snapshots.length + markers.length === 0 ||
      snapshots.some((snapshot) => !snapshot.undone) ||
      markers.some((marker) => !marker.undone)
    ) {
      return [];
    }
    if (this.created.some((marker) => !marker.undone && marker.turnSeq > redoTurn)) {
      return [];
    }
    return records.map((record) => ({ ...record }));
  }

  /**
   * Authoritative latest-turn plan, including turns that only created files.
   * Keeping this decision in FileHistory prevents UI callers from accidentally
   * selecting an older snapshot-only turn.
   */
  getLatestTurnUndoPlan(): TurnUndoPlan | null {
    const plan = this.latestTurnUndoPlanInternal();
    if (!plan) return null;
    return {
      turnSeq: plan.turnSeq,
      snapshots: plan.snapshots.map((snapshot) => ({ ...snapshot })),
      createdPaths: [...plan.createdPaths],
      filePaths: [...plan.filePaths],
    };
  }

  /**
   * Get all snapshots for a specific file.
   */
  getSnapshots(filePath: string): FileSnapshot[] {
    const absPath = resolve(filePath);
    return this.snapshots
      .filter((s) => s.filePath === absPath)
      .map((snapshot) => ({ ...snapshot }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Restore a file to a specific snapshot.
   */
  restore(snapshot: FileSnapshot): boolean {
    return this.withCurrentIndex(() => {
      const authoritative = this.findSnapshot(snapshot);
      return authoritative ? this.restoreSnapshot(authoritative, true) : false;
    });
  }

  /**
   * Restore a file to its most recent snapshot.
   */
  restoreLatest(filePath: string): boolean {
    return this.withCurrentIndex(() => {
      const snapshots = this.getSnapshots(filePath);
      if (snapshots.length === 0) return false;
      return this.restore(snapshots[0]);
    });
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
    return this.withCurrentIndex(() => {
      const targets = earliestSnapshotsPerFile(this.snapshots);
      return targets.map((snap) => ({ filePath: snap.filePath, ok: this.restore(snap) }));
    });
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
      if (
        this.redoRecords.some(
          (record) => record.filePath === filePath && record.turnSeq === turnSeq,
        )
      ) {
        return true;
      }
      if (!existsSync(filePath)) {
        const snapshot = this.snapshots.find(
          (candidate) =>
            candidate.filePath === filePath && this.turnKey(candidate.turnSeq) === turnSeq,
        );
        const backupPath = join(
          this.historyDir,
          `redo_absent_${Date.now()}_${randomUUID()}`,
        );
        writeFileAtomic(backupPath, "", 0o600);
        this.redoRecords.push({
          filePath,
          turnSeq,
          backupPath,
          existedBefore,
          existedAfter: false,
          ...(snapshot?.realPath ? { realPath: snapshot.realPath } : {}),
        });
        return true;
      }
      const sourceInfo = lstatSync(filePath);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) return false;
      const content = readFileSync(filePath);
      const hash = createHash("md5").update(content).digest("hex");
      const timestamp = Date.now();
      const pathHash = createHash("md5").update(filePath).digest("hex").slice(0, 8);
      const safeName = filePath.replace(/[/\\:]/g, "_").slice(-80);
      const backupPath = join(
        this.historyDir,
        `redo_${timestamp}_${pathHash}_${hash.slice(0, 8)}_${randomUUID()}_${safeName}`,
      );
      copyFileSync(filePath, backupPath);
      if (process.platform !== "win32") chmodSync(backupPath, 0o600);
      this.redoRecords.push({
        filePath,
        turnSeq,
        backupPath,
        existedBefore,
        existedAfter: true,
        mode: sourceInfo.mode & 0o7777,
        realPath: realpathSync(filePath),
      });
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
    return this.withCurrentIndex(() => this.undoLatestTurnUnlocked(targets));
  }

  private undoLatestTurnUnlocked(
    targets: FileSnapshot[],
  ): Array<{ filePath: string; ok: boolean }> {
    const plan = this.latestTurnUndoPlanInternal();
    if (!plan) return [];
    if (!this.isExactSnapshotSet(targets, plan.snapshots)) {
      return plan.filePaths.map((filePath) => ({ filePath, ok: false }));
    }
    const undoneTurn = plan.turnKey;

    const results: Array<{ filePath: string; ok: boolean }> = [];

    // Files created this turn: delete them (after stashing redo material). Skip
    // files that are also a restore target — created wins (the file didn't exist
    // pre-turn, so its "pre-turn state" is "absent" → delete, not restore).
    const createdThisTurn = this.created.filter(
      (c) => !c.undone && c.turnSeq === undoneTurn,
    );
    const createdPaths = new Set(createdThisTurn.map((c) => c.filePath));

    // Validate every destination against the location recorded BEFORE the
    // creating/editing tool ran. Redo backups describe the current location,
    // so comparing only against them is tautological and would miss a parent
    // directory swapped to a symlink after the edit.
    const safeToCapture = plan.filePaths.every((filePath) => {
      if (!this.isSafeDestination(filePath)) return false;
      const marker = createdThisTurn.find((candidate) => candidate.filePath === filePath);
      const snapshot = plan.snapshots.find((candidate) => candidate.filePath === filePath);
      const expectedRealPath = marker?.realPath ?? snapshot?.realPath;
      if (!this.matchesRecordedLocation(filePath, expectedRealPath)) return false;
      return !snapshot || this.isSafeBackup(snapshot.backupPath);
    });
    if (!safeToCapture) {
      return plan.filePaths.map((filePath) => ({ filePath, ok: false }));
    }

    // Capture every post-turn state before mutating any file. A missing file is
    // a legitimate post-turn state (delete), represented by an absence marker.
    // If any capture fails, leave all working files untouched and keep the turn
    // live so the user can retry.
    const captured = plan.filePaths.map((filePath) =>
      this.captureRedoBackup(filePath, undoneTurn, !createdPaths.has(filePath)),
    );
    if (captured.some((ok) => !ok)) {
      this.discardRedoTurn(undoneTurn);
      this.saveIndex();
      return plan.filePaths.map((filePath) => ({ filePath, ok: false }));
    }

    const redoForTurn = new Map(
      this.redoRecords
        .filter((record) => record.turnSeq === undoneTurn)
        .map((record) => [record.filePath, record]),
    );
    const canApply = plan.filePaths.every((filePath) => {
      const redo = redoForTurn.get(filePath);
      if (!redo || !this.isSafeBackup(redo.backupPath)) return false;
      if (!this.isSafeDestination(filePath)) return false;
      if (!this.matchesRecordedLocation(filePath, redo.realPath)) return false;
      const snapshot = plan.snapshots.find((candidate) => candidate.filePath === filePath);
      return !snapshot || this.isSafeBackup(snapshot.backupPath);
    });
    if (!canApply) {
      this.discardRedoTurn(undoneTurn);
      this.saveIndex();
      return plan.filePaths.map((filePath) => ({ filePath, ok: false }));
    }

    // Commit the complete recovery plan before touching working files. If the
    // process crashes during a restore, the next load still has the original
    // post-turn material and can safely retry the idempotent operation.
    if (!this.saveIndex()) {
      this.discardRedoTurn(undoneTurn);
      return plan.filePaths.map((filePath) => ({ filePath, ok: false }));
    }

    for (const c of createdThisTurn) {
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
    for (const snap of plan.snapshots) {
      if (createdPaths.has(snap.filePath)) continue;
      results.push({ filePath: snap.filePath, ok: this.restoreSnapshot(snap, false) });
    }

    if (results.some((result) => !result.ok)) {
      this.saveIndex();
      return results;
    }

    // Mark the turn undone (snapshots + created markers) — keep them on disk so
    // redo has material and the turn is re-applyable.
    for (const s of this.snapshots) {
      if (this.turnKey(s.turnSeq) === undoneTurn) s.undone = true;
    }
    for (const c of this.created) {
      if (c.turnSeq === undoneTurn) c.undone = true;
    }
    if (!this.saveIndex()) {
      for (const s of this.snapshots) {
        if (this.turnKey(s.turnSeq) === undoneTurn) s.undone = false;
      }
      for (const c of this.created) {
        if (c.turnSeq === undoneTurn) c.undone = false;
      }
      return results.map((result) => ({ ...result, ok: false }));
    }
    return results;
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
    return this.withCurrentIndex(() => this.redoLatestTurnUnlocked(redoTargets));
  }

  private redoLatestTurnUnlocked(
    redoTargets: RedoRecord[],
  ): Array<{ filePath: string; ok: boolean }> {
    if (redoTargets.length === 0) return [];
    const expected = this.getLatestRedoRecords();
    const authoritative = redoTargets.map((record) => this.findRedoRecord(record));
    const expectedBackups = new Set(expected.map((record) => record.backupPath));
    const suppliedBackups = new Set(
      authoritative.flatMap((record) => (record ? [record.backupPath] : [])),
    );
    const exactCurrentSet =
      authoritative.every((record): record is RedoRecord => record !== undefined) &&
      suppliedBackups.size === authoritative.length &&
      suppliedBackups.size === expectedBackups.size &&
      [...suppliedBackups].every((backupPath) => expectedBackups.has(backupPath));

    // Treat caller-provided records as untrusted values. Besides protecting the
    // destination path, this prevents a stale preview from consuming a newer
    // turn's only redo material.
    if (!exactCurrentSet) {
      return redoTargets.map((record) => ({ filePath: record.filePath, ok: false }));
    }

    const turn = authoritative[0]!.turnSeq;

    const results = authoritative.map((rec) => {
      let ok = false;
      try {
        if (
          this.isSafeBackup(rec.backupPath) &&
          this.isSafeDestination(rec.filePath) &&
          this.matchesRecordedLocation(rec.filePath, rec.realPath)
        ) {
          if (rec.existedAfter === false) {
            if (existsSync(rec.filePath)) rmSync(rec.filePath, { force: true });
          } else {
            copyFileSync(rec.backupPath, rec.filePath);
            this.restoreMode(rec.filePath, rec.mode);
          }
          ok = true;
        }
      } catch {
        ok = false;
      }
      return { filePath: rec.filePath, ok };
    });

    // A partial filesystem failure must not consume redo history. Successful
    // copies are safe to repeat when the user retries after fixing the failed
    // path, while deleting the records here would make recovery impossible.
    if (results.some((result) => !result.ok)) {
      return results;
    }

    // Un-mark the turn and remove redo references in the index first. Backup
    // files are deleted only after that commit succeeds; deleting them first
    // creates a crash window where the durable index points at missing redo.
    const previousRedoRecords = this.redoRecords;
    for (const s of this.snapshots) {
      if (this.turnKey(s.turnSeq) === turn) s.undone = false;
    }
    for (const c of this.created) {
      if (c.turnSeq === turn) c.undone = false;
    }
    const consumedBackups = new Set(authoritative.map((record) => record.backupPath));
    const consumedRecords = this.redoRecords.filter(
      (record) => consumedBackups.has(record.backupPath) || record.turnSeq === turn,
    );
    this.redoRecords = this.redoRecords.filter(
      (record) => !consumedBackups.has(record.backupPath) && record.turnSeq !== turn,
    );
    if (!this.saveIndex()) {
      for (const s of this.snapshots) {
        if (this.turnKey(s.turnSeq) === turn) s.undone = true;
      }
      for (const c of this.created) {
        if (c.turnSeq === turn) c.undone = true;
      }
      this.redoRecords = previousRedoRecords;
      return results.map((result) => ({ ...result, ok: false }));
    }
    for (const record of consumedRecords) {
      try {
        if (this.isSafeBackup(record.backupPath)) rmSync(record.backupPath, { force: true });
      } catch {
        // The index no longer references this file; cleanup remains best effort.
      }
    }
    return results;
  }

  /**
   * All snapshots in record (chronological) order. Used by undo to pick the
   * single most-recent modification across every file (see latestUndoTarget).
   * Returns a copy so callers can't mutate the internal list.
   */
  getAllSnapshots(): FileSnapshot[] {
    return this.snapshots.map((snapshot) => ({ ...snapshot }));
  }

  private saveIndex(): boolean {
    try {
      const indexPath = join(this.historyDir, "index.json");
      const index: HistoryIndex = {
        snapshots: this.snapshots,
        redoRecords: this.redoRecords,
        created: this.created,
      };
      writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`, 0o600);
      return true;
    } catch {
      return false;
    }
  }

  static loadFromDir(sessionDir: string): FileHistory {
    const history = new FileHistory(sessionDir);
    history.reloadIndex(false);
    return history;
  }

  /** Serialize every read-modify-write and refresh after taking the lock. */
  private withCurrentIndex<T>(operation: () => T): T {
    if (this.lockDepth > 0) return operation();
    const indexPath = join(this.historyDir, "index.json");
    const release = acquireFileLock(indexPath);
    this.lockDepth = 1;
    try {
      this.reloadIndex(true);
      return operation();
    } finally {
      this.lockDepth = 0;
      release();
    }
  }

  private reloadIndex(throwOnInvalid: boolean): void {
    const indexPath = join(this.historyDir, "index.json");
    this.snapshots = [];
    this.redoRecords = [];
    this.created = [];
    if (existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(readFileSync(indexPath, "utf-8"));
        if (Array.isArray(parsed)) {
          // Legacy v1: bare FileSnapshot[]. No redo/created material existed yet.
          this.snapshots = parsed.filter((value) => this.isSnapshot(value));
        } else {
          const index = parsed as Partial<HistoryIndex>;
          this.snapshots = Array.isArray(index.snapshots)
            ? index.snapshots.filter((value) => this.isSnapshot(value))
            : [];
          this.redoRecords = Array.isArray(index.redoRecords)
            ? index.redoRecords.filter((value) => this.isRedoRecord(value))
            : [];
          this.created = Array.isArray(index.created)
            ? index.created.filter(isCreatedMarker)
            : [];
        }
      } catch (err) {
        if (throwOnInvalid) throw err;
        // Read-only load keeps the historical recovery behavior. A later
        // mutation reloads under lock and fails closed instead of overwriting
        // the malformed index with an empty one.
      }
    }
  }

  private isSafeBackup(backupPath: unknown): backupPath is string {
    if (!this.isContainedBackupPath(backupPath)) return false;
    try {
      const info = lstatSync(backupPath);
      return info.isFile() && !info.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private isContainedBackupPath(backupPath: unknown): backupPath is string {
    if (typeof backupPath !== "string" || !isAbsolute(backupPath)) return false;
    const rel = relative(this.historyDir, resolve(backupPath));
    return Boolean(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  }

  /** Never follow a destination symlink while restoring an old file version. */
  private isSafeDestination(filePath: unknown): filePath is string {
    if (typeof filePath !== "string" || !isAbsolute(filePath)) return false;
    if (!existsSync(filePath)) return true;
    try {
      const info = lstatSync(filePath);
      return info.isFile() && !info.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private canonicalizeNewPath(filePath: string): string | undefined {
    const absPath = resolve(filePath);
    let candidate = absPath;
    const missingSegments: string[] = [];
    for (let depth = 0; depth < 256; depth += 1) {
      try {
        return join(realpathSync(candidate), ...missingSegments.reverse());
      } catch {
        const parent = dirname(candidate);
        if (parent === candidate) return undefined;
        missingSegments.push(basename(candidate));
        candidate = parent;
      }
    }
    return undefined;
  }

  private matchesRecordedLocation(filePath: string, realPath: string | undefined): boolean {
    if (!realPath) return true; // Legacy index written before canonical metadata.
    try {
      const current = existsSync(filePath) ? realpathSync(filePath) : this.canonicalizeNewPath(filePath);
      return current === realPath;
    } catch {
      return false;
    }
  }

  private restoreSnapshot(snapshot: FileSnapshot, saveCurrent: boolean): boolean {
    try {
      if (!this.isSafeBackup(snapshot.backupPath)) return false;
      if (!this.isSafeDestination(snapshot.filePath)) return false;
      if (!this.matchesRecordedLocation(snapshot.filePath, snapshot.realPath)) return false;
      const currentMode = this.readMode(snapshot.filePath);
      if (saveCurrent && existsSync(snapshot.filePath) && !this.saveSnapshot(snapshot.filePath)) {
        return false;
      }
      copyFileSync(snapshot.backupPath, snapshot.filePath);
      this.restoreMode(snapshot.filePath, snapshot.mode ?? currentMode);
      return true;
    } catch {
      return false;
    }
  }

  private readMode(filePath: string): number | undefined {
    if (process.platform === "win32" || !existsSync(filePath)) return undefined;
    try {
      return lstatSync(filePath).mode & 0o7777;
    } catch {
      return undefined;
    }
  }

  private restoreMode(filePath: string, mode: number | undefined): void {
    if (process.platform === "win32" || mode === undefined) return;
    chmodSync(filePath, mode);
  }

  private discardRedoTurn(turnSeq: number): void {
    this.redoRecords = this.redoRecords.filter((record) => {
      if (record.turnSeq !== turnSeq) return true;
      try {
        if (this.isSafeBackup(record.backupPath)) rmSync(record.backupPath, { force: true });
      } catch {
        // Best-effort cleanup; dropping the index reference is the safety boundary.
      }
      return false;
    });
  }

  private turnKey(turnSeq: number | undefined): number {
    return turnSeq ?? LEGACY_TURN;
  }

  private latestTurnUndoPlanInternal(): (TurnUndoPlan & { turnKey: number }) | null {
    let latest = -Infinity;
    let found = false;
    for (const snapshot of this.snapshots) {
      if (snapshot.undone) continue;
      latest = Math.max(latest, this.turnKey(snapshot.turnSeq));
      found = true;
    }
    for (const marker of this.created) {
      if (marker.undone) continue;
      latest = Math.max(latest, marker.turnSeq);
      found = true;
    }
    if (!found) return null;

    const earliest = new Map<string, FileSnapshot>();
    for (const snapshot of this.snapshots) {
      if (snapshot.undone || this.turnKey(snapshot.turnSeq) !== latest) continue;
      const current = earliest.get(snapshot.filePath);
      if (!current || snapshot.timestamp < current.timestamp) {
        earliest.set(snapshot.filePath, snapshot);
      }
    }
    const snapshots = [...earliest.values()].sort((a, b) => a.timestamp - b.timestamp);
    const createdPaths = this.created
      .filter((marker) => !marker.undone && marker.turnSeq === latest)
      .map((marker) => marker.filePath);
    const filePaths = [...new Set([...createdPaths, ...snapshots.map((item) => item.filePath)])];
    return {
      turnKey: latest,
      ...(latest === LEGACY_TURN ? {} : { turnSeq: latest }),
      snapshots,
      createdPaths,
      filePaths,
    };
  }

  private isExactSnapshotSet(candidates: FileSnapshot[], expected: FileSnapshot[]): boolean {
    if (candidates.length !== expected.length) return false;
    const remaining = [...expected];
    for (const candidate of candidates) {
      const index = remaining.findIndex((snapshot) => this.sameSnapshot(snapshot, candidate));
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
    return remaining.length === 0;
  }

  private sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
    return (
      a.filePath === b.filePath &&
      a.timestamp === b.timestamp &&
      a.backupPath === b.backupPath &&
      a.hash === b.hash &&
      a.size === b.size &&
      a.turnSeq === b.turnSeq &&
      a.undone === b.undone
    );
  }

  private findSnapshot(candidate: FileSnapshot): FileSnapshot | undefined {
    return this.snapshots.find((snapshot) => this.sameSnapshot(snapshot, candidate));
  }

  private findRedoRecord(candidate: RedoRecord): RedoRecord | undefined {
    return this.redoRecords.find(
      (record) =>
        record.filePath === candidate.filePath &&
        record.turnSeq === candidate.turnSeq &&
        record.backupPath === candidate.backupPath &&
        record.existedBefore === candidate.existedBefore &&
        record.existedAfter === candidate.existedAfter,
    );
  }

  private isSnapshot(value: unknown): value is FileSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const snapshot = value as Partial<FileSnapshot>;
    return (
      typeof snapshot.filePath === "string" &&
      isAbsolute(snapshot.filePath) &&
      typeof snapshot.timestamp === "number" &&
      Number.isFinite(snapshot.timestamp) &&
      typeof snapshot.hash === "string" &&
      typeof snapshot.size === "number" &&
      Number.isFinite(snapshot.size) &&
      (snapshot.mode === undefined || isFileMode(snapshot.mode)) &&
      (snapshot.realPath === undefined ||
        (typeof snapshot.realPath === "string" && isAbsolute(snapshot.realPath))) &&
      (snapshot.turnSeq === undefined || isFiniteTurn(snapshot.turnSeq)) &&
      (snapshot.undone === undefined || typeof snapshot.undone === "boolean") &&
      this.isSafeBackup(snapshot.backupPath)
    );
  }

  private isRedoRecord(value: unknown): value is RedoRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Partial<RedoRecord>;
    return (
      typeof record.filePath === "string" &&
      isAbsolute(record.filePath) &&
      typeof record.turnSeq === "number" &&
      isHistoryTurn(record.turnSeq) &&
      typeof record.existedBefore === "boolean" &&
      (record.existedAfter === undefined || typeof record.existedAfter === "boolean") &&
      (record.mode === undefined || isFileMode(record.mode)) &&
      (record.realPath === undefined ||
        (typeof record.realPath === "string" && isAbsolute(record.realPath))) &&
      this.isContainedBackupPath(record.backupPath)
    );
  }
}

function isCreatedMarker(value: unknown): value is CreatedMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Partial<CreatedMarker>;
  return (
    typeof marker.filePath === "string" &&
    isAbsolute(marker.filePath) &&
    typeof marker.turnSeq === "number" &&
    isFiniteTurn(marker.turnSeq) &&
    (marker.realPath === undefined ||
      (typeof marker.realPath === "string" && isAbsolute(marker.realPath))) &&
    (marker.undone === undefined || typeof marker.undone === "boolean")
  );
}

function isFiniteTurn(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHistoryTurn(value: unknown): value is number {
  return value === LEGACY_TURN || isFiniteTurn(value);
}

function isFileMode(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0o7777;
}
