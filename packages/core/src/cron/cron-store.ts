/**
 * CronStore — persistence for cron jobs.
 *
 * Writes a single-file JSON snapshot of all jobs to `~/.code-shell/cron.json`
 * (global by default), so scheduled tasks survive a process restart. Uses the
 * same atomic tmp+rename write as FileRunStore so a crash mid-write can't
 * truncate the file and lose every job.
 *
 * Concurrency model (v1): single-process. The snapshot is read-modify-write,
 * so two processes mutating cron jobs simultaneously is a lost-update risk.
 * codeshell runs the scheduler in one process (the REPL/daemon), so this is
 * acceptable for v1 — but it is NOT safe for concurrent writers. A future
 * version that needs multi-process safety should switch to a JSONL event log
 * (append + replay) or a file lock. Documented here and in the plan so the
 * limitation is explicit rather than a silent footgun.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CronJob } from "./scheduler.js";
import { logger } from "../logging/logger.js";

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

  /** Persist the full job set. Atomic: stage to .tmp, then rename. */
  save(jobs: CronJob[]): void {
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
}
