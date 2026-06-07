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
   */
  saveSnapshot(filePath: string): FileSnapshot | null {
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) return null;

    try {
      const content = readFileSync(absPath);
      const hash = createHash("md5").update(content).digest("hex");

      // Check if we already have this exact version
      const existing = this.snapshots.find(
        (s) => s.filePath === absPath && s.hash === hash,
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
