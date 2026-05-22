/**
 * RunLock — file-based locking to prevent multiple workers from executing
 * the same run concurrently.
 *
 * Uses proper-lockfile (via lazy wrapper) for cross-process safe locking.
 * Each run gets a lock on its run.json file.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { lock, check, unlock } from "../utils/lockfile.js";
import { logger } from "../logging/logger.js";

export interface RunLockConfig {
  /** Base directory for runs. Default: ~/.code-shell/runs */
  runsDir?: string;
  /** Stale lock timeout in ms. Default: 60_000 (1 minute) */
  staleMs?: number;
}

export class RunLock {
  private readonly runsDir: string;
  private readonly staleMs: number;
  private readonly releaseFns = new Map<string, () => Promise<void>>();

  constructor(config?: RunLockConfig) {
    this.runsDir = config?.runsDir ?? join(homedir(), ".code-shell", "runs");
    this.staleMs = config?.staleMs ?? 60_000;
  }

  /**
   * Acquire a lock for a run. Returns true if acquired, false if already held.
   */
  async acquire(runId: string): Promise<boolean> {
    const lockTarget = this.lockTarget(runId);
    if (!existsSync(lockTarget)) return false;

    try {
      const release = await lock(lockTarget, {
        stale: this.staleMs,
        retries: 0,
      });
      this.releaseFns.set(runId, release);
      logger.info("run.lock.acquired", { runId });
      return true;
    } catch {
      // Lock already held by another process
      return false;
    }
  }

  /**
   * Release the lock for a run.
   */
  async release(runId: string): Promise<void> {
    const releaseFn = this.releaseFns.get(runId);
    if (releaseFn) {
      try {
        await releaseFn();
      } catch {
        // Lock may already be released (stale cleanup)
      }
      this.releaseFns.delete(runId);
      logger.info("run.lock.released", { runId });
    }
  }

  /**
   * Check if a run is currently locked by any process.
   */
  async isLocked(runId: string): Promise<boolean> {
    const lockTarget = this.lockTarget(runId);
    if (!existsSync(lockTarget)) return false;
    try {
      return await check(lockTarget, { stale: this.staleMs });
    } catch {
      return false;
    }
  }

  /**
   * Force-unlock a stale lock (e.g., after crash recovery).
   */
  async forceUnlock(runId: string): Promise<void> {
    const lockTarget = this.lockTarget(runId);
    if (!existsSync(lockTarget)) return;
    try {
      await unlock(lockTarget);
      logger.info("run.lock.force_unlocked", { runId });
    } catch {
      // Already unlocked
    }
  }

  /**
   * Release all locks held by this instance.
   */
  async releaseAll(): Promise<void> {
    for (const [runId] of this.releaseFns) {
      await this.release(runId);
    }
  }

  private lockTarget(runId: string): string {
    return join(this.runsDir, runId, "run.json");
  }
}
