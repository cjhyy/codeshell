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
import { assertSafeRunId } from "./ids.js";

export interface RunLockConfig {
  /** Base directory for runs. Default: ~/.code-shell/runs */
  runsDir?: string;
  /** Stale lock timeout in ms. Default: 60_000 (1 minute) */
  staleMs?: number;
  /** How long to wait for runs/<id>/run.json to appear before failing. */
  targetWaitMs?: number;
  /** Poll interval while waiting for the lock target file. */
  targetPollMs?: number;
}

export type RunLockAcquireResult =
  | { acquired: true }
  | {
      acquired: false;
      reason: "missing_target" | "locked";
      message?: string;
      code?: string;
    };

export class RunLock {
  private readonly runsDir: string;
  private readonly staleMs: number;
  private readonly targetWaitMs: number;
  private readonly targetPollMs: number;
  private readonly releaseFns = new Map<string, () => Promise<void>>();

  constructor(config?: RunLockConfig) {
    this.runsDir = config?.runsDir ?? join(homedir(), ".code-shell", "runs");
    this.staleMs = config?.staleMs ?? 60_000;
    this.targetWaitMs = config?.targetWaitMs ?? 2_000;
    this.targetPollMs = config?.targetPollMs ?? 10;
  }

  /**
   * Acquire a lock for a run. Missing target and held-lock failures are
   * intentionally distinct so callers don't silently abandon a run as "locked"
   * when the real issue is a bad/mismatched run store path.
   *
   * Race note: if the queue reaches acquire() before the file is visible, a
   * short wait bridges that gap. Only a proper-lockfile conflict is "locked".
   */
  async acquire(runId: string): Promise<RunLockAcquireResult> {
    const lockTarget = this.lockTarget(runId);
    if (!(await this.waitForTarget(lockTarget))) {
      logger.warn("run.lock.target_missing", { runId, lockTarget });
      return {
        acquired: false,
        reason: "missing_target",
        message: `Lock target did not appear: ${lockTarget}`,
      };
    }

    try {
      const release = await lock(lockTarget, {
        stale: this.staleMs,
        retries: 0,
      });
      this.releaseFns.set(runId, release);
      logger.info("run.lock.acquired", { runId });
      return { acquired: true };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      logger.warn("run.lock.conflict", {
        runId,
        lockTarget,
        code: e?.code,
        message: e?.message,
        alreadyHeldByThisInstance: this.releaseFns.has(runId),
      });
      return {
        acquired: false,
        reason: "locked",
        code: e?.code,
        message: e?.message,
      };
    }
  }

  /**
   * Wait (up to ~targetWaitMs) for the lock target file to exist, polling on a
   * short interval. Returns true once present, false if it never appears
   * within the window. Bridges the submit→executeRun create race without
   * blocking meaningfully when the file is already there (first check hits).
   */
  private async waitForTarget(lockTarget: string): Promise<boolean> {
    const deadline = Date.now() + this.targetWaitMs;
    while (!existsSync(lockTarget)) {
      if (Date.now() >= deadline) return false;
      await new Promise<void>((r) => setTimeout(r, this.targetPollMs));
    }
    return true;
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
    assertSafeRunId(runId);
    return join(this.runsDir, runId, "run.json");
  }
}
