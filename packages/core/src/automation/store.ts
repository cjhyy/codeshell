/**
 * CronStore — persistence for cron jobs.
 *
 * Writes a single-file JSON snapshot of all jobs to `~/.code-shell/cron.json`
 * (global by default), so scheduled tasks survive a process restart. Uses the
 * same atomic tmp+rename write as FileRunStore so a crash mid-write can't
 * truncate the file and lose every job.
 *
 * Cross-process writes are serialized with a directory lock. Hosts that need
 * read-modify-write behavior should use mutate() so load + save happen under
 * the same lock and one process cannot overwrite another process's new job
 * with a stale in-memory snapshot.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CronJob } from "./scheduler.js";
import { logger } from "../logging/logger.js";
import { lockSync } from "../utils/lockfile.js";

interface CronSnapshot {
  version: 1;
  jobs: CronJob[];
}

/** Default global location. Mirrors FileRunStore's `~/.code-shell/...` layout. */
export function defaultCronStorePath(): string {
  return join(homedir(), ".code-shell", "cron.json");
}

export class CronStore {
  private readonly file: string;

  constructor(file?: string) {
    this.file = file ?? defaultCronStorePath();
  }

  /** Load all persisted jobs. Returns [] when absent or unreadable. */
  load(): CronJob[] {
    return this.loadUnlocked();
  }

  /**
   * Atomically load, mutate, and save jobs under the store lock. This is the
   * safe path for create/update/delete/pause/resume across the desktop main
   * process and the agent worker process.
   */
  mutate<T>(
    fn: (jobs: CronJob[]) => { jobs: CronJob[]; result: T },
  ): { jobs: CronJob[]; result: T } {
    const release = this.acquireStoreLock();
    try {
      const current = this.loadUnlocked();
      const next = fn(current);
      this.saveUnlocked(next.jobs);
      return next;
    } finally {
      release();
    }
  }

  /** Persist the full job set. Atomic: stage to .tmp, then rename. */
  save(jobs: CronJob[]): void {
    const release = this.acquireStoreLock();
    try {
      this.saveUnlocked(jobs);
    } finally {
      release();
    }
  }

  private loadUnlocked(): CronJob[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as CronSnapshot;
      if (!parsed || !Array.isArray(parsed.jobs)) return [];
      return parsed.jobs;
    } catch (err) {
      // Corrupt snapshot — log and start fresh rather than crashing startup.
      logger.warn("cron_store.load_failed", {
        cat: "cron",
        file: this.file,
        error: (err as Error).message,
      });
      return [];
    }
  }

  private saveUnlocked(jobs: CronJob[]): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const snapshot: CronSnapshot = { version: 1, jobs };
    // Unique tmp name so a concurrent writer can't clobber our staging file.
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  private acquireStoreLock(): () => void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const deadline = Date.now() + 1_000;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        return lockSync(dir, {
          stale: 10_000,
          retries: 0,
        });
      } catch (err) {
        lastError = err;
        sleepSync(10);
      }
    }
    throw lastError;
  }
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}
