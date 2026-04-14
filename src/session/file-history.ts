/**
 * File history — automatic backup of files before modifications.
 *
 * Stores snapshots in the session directory under file-history/.
 * Supports restoring files to a previous state.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { createHash } from "node:crypto";

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

      // Create backup
      const timestamp = Date.now();
      const safeName = absPath.replace(/[/\\:]/g, "_").slice(-100);
      const backupPath = join(this.historyDir, `${timestamp}_${safeName}`);

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
