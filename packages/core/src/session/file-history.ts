/**
 * File history — automatic backup of files before modifications.
 *
 * Stores snapshots in the session directory under file-history/.
 * Supports restoring files to a previous state.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
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
}

export class FileHistory {
  private readonly historyDir: string;
  private snapshots: FileSnapshot[] = [];

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
   * Turn-level undo: revert every file the most recent conversation turn changed
   * to its pre-turn state, then DROP that turn's snapshots so a subsequent
   * `/undo` peels the previous turn (instead of re-targeting the same turn — the
   * snapshots are never re-selectable once consumed). Powers `/undo`.
   *
   * `targets` are computed by the caller (latestTurnUndoTargets) up front and
   * reused here so the preview and the restore agree on exactly what reverts.
   * Returns a per-file result so a partial failure doesn't hide which reverted.
   */
  undoLatestTurn(targets: FileSnapshot[]): Array<{ filePath: string; ok: boolean }> {
    if (targets.length === 0) return [];
    // The turn being undone = the turnSeq shared by the targets (all from the
    // same latest turn). Capture it before restore() appends fresh snapshots.
    const undoneTurn = targets[0]!.turnSeq;
    const results = targets.map((snap) => ({
      filePath: snap.filePath,
      ok: this.restore(snap),
    }));
    // Consume the turn: drop every snapshot tagged with it so the next undo
    // moves to the prior turn. Untagged (legacy / restore-time) snapshots are
    // left alone. If the turn was untagged (legacy history), there's no stable
    // turn to peel — leave snapshots as-is rather than wiping the whole history.
    if (undoneTurn !== undefined) {
      this.snapshots = this.snapshots.filter((s) => s.turnSeq !== undoneTurn);
      this.saveIndex();
    }
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
      writeFileSync(indexPath, JSON.stringify(this.snapshots, null, 2), "utf-8");
    } catch {
      // Silent fail
    }
  }

  static loadFromDir(sessionDir: string): FileHistory {
    const history = new FileHistory(sessionDir);
    const indexPath = join(history.historyDir, "index.json");
    if (existsSync(indexPath)) {
      try {
        history.snapshots = JSON.parse(readFileSync(indexPath, "utf-8"));
      } catch {
        // Start fresh
      }
    }
    return history;
  }
}
