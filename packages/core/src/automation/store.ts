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

import {
  chmodSync,
  mkdirSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { validateSchedule, type CronJob } from "./scheduler.js";
import { logger } from "../logging/logger.js";
import { lockSync } from "../utils/lockfile.js";

interface CronSnapshot {
  version: 1;
  jobs: CronJob[];
}

const MAX_CRON_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CRON_JOBS = 4_096;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

function normalizeJob(value: unknown, strict: boolean): CronJob | undefined {
  const invalid = (field: string): undefined => {
    if (strict) throw new Error(`invalid cron job ${field}`);
    return undefined;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !SAFE_ID.test(raw.id) || raw.id.includes("..")) {
    return invalid("id");
  }
  if (
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    raw.name.length > 512 ||
    raw.name.includes("\0")
  ) {
    return invalid("name");
  }
  if (
    typeof raw.schedule !== "string" ||
    !raw.schedule.trim() ||
    raw.schedule.length > 512 ||
    raw.schedule.includes("\0")
  ) {
    return invalid("schedule");
  }
  if (
    typeof raw.prompt !== "string" ||
    !raw.prompt.trim() ||
    raw.prompt.length > 1024 * 1024 ||
    raw.prompt.includes("\0")
  ) {
    return invalid("prompt");
  }
  if (typeof raw.enabled !== "boolean") return invalid("enabled");
  if (!Number.isSafeInteger(raw.runCount) || (raw.runCount as number) < 0) {
    return invalid("runCount");
  }
  if (!Number.isSafeInteger(raw.createdAt) || (raw.createdAt as number) < 0) {
    return invalid("createdAt");
  }
  if (
    raw.cwd !== undefined &&
    (typeof raw.cwd !== "string" || raw.cwd.length > 32_768 || raw.cwd.includes("\0"))
  ) {
    return invalid("cwd");
  }
  if (
    raw.timezone !== undefined &&
    (typeof raw.timezone !== "string" || raw.timezone.length > 128 || raw.timezone.includes("\0"))
  ) {
    return invalid("timezone");
  }
  if (
    raw.permissionLevel !== undefined &&
    raw.permissionLevel !== "read-only" &&
    raw.permissionLevel !== "workspace-write" &&
    raw.permissionLevel !== "full"
  ) {
    return invalid("permissionLevel");
  }
  for (const field of ["lastRun", "nextRun"] as const) {
    if (
      raw[field] !== undefined &&
      (!Number.isSafeInteger(raw[field]) || (raw[field] as number) < 0)
    ) {
      return invalid(field);
    }
  }
  for (const field of ["lastRunId", "resumeSessionId"] as const) {
    if (
      raw[field] !== undefined &&
      (typeof raw[field] !== "string" ||
        !(raw[field] as string) ||
        (raw[field] as string).length > 128 ||
        (raw[field] as string).includes("\0"))
    ) {
      return invalid(field);
    }
  }
  if (raw.once !== undefined && typeof raw.once !== "boolean") return invalid("once");
  if (
    raw.disabledReason !== undefined &&
    (typeof raw.disabledReason !== "string" || raw.disabledReason.length > 4_096)
  ) {
    return invalid("disabledReason");
  }

  let templateSource: CronJob["templateSource"];
  if (raw.templateSource !== undefined) {
    if (!raw.templateSource || typeof raw.templateSource !== "object" || Array.isArray(raw.templateSource)) {
      return invalid("templateSource");
    }
    const source = raw.templateSource as Record<string, unknown>;
    if (
      typeof source.installKey !== "string" ||
      !source.installKey ||
      source.installKey.length > 512 ||
      typeof source.templateId !== "string" ||
      !source.templateId ||
      source.templateId.length > 512 ||
      typeof source.revision !== "string" ||
      !source.revision ||
      source.revision.length > 512 ||
      (source.pluginVersion !== undefined &&
        (typeof source.pluginVersion !== "string" || source.pluginVersion.length > 128))
    ) {
      return invalid("templateSource");
    }
    templateSource = {
      installKey: source.installKey,
      templateId: source.templateId,
      revision: source.revision,
      ...(typeof source.pluginVersion === "string" ? { pluginVersion: source.pluginVersion } : {}),
    };
  }

  try {
    validateSchedule(raw.schedule, typeof raw.timezone === "string" ? raw.timezone : undefined);
  } catch {
    return invalid("schedule");
  }

  return {
    id: raw.id,
    name: raw.name,
    schedule: raw.schedule,
    prompt: raw.prompt,
    enabled: raw.enabled,
    runCount: raw.runCount as number,
    createdAt: raw.createdAt as number,
    ...(typeof raw.lastRun === "number" ? { lastRun: raw.lastRun } : {}),
    ...(typeof raw.nextRun === "number" ? { nextRun: raw.nextRun } : {}),
    ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
    ...(typeof raw.timezone === "string" ? { timezone: raw.timezone } : {}),
    ...(raw.permissionLevel === "read-only" ||
    raw.permissionLevel === "workspace-write" ||
    raw.permissionLevel === "full"
      ? { permissionLevel: raw.permissionLevel }
      : {}),
    ...(typeof raw.lastRunId === "string" ? { lastRunId: raw.lastRunId } : {}),
    ...(raw.once === true ? { once: true } : {}),
    ...(typeof raw.resumeSessionId === "string" ? { resumeSessionId: raw.resumeSessionId } : {}),
    ...(typeof raw.disabledReason === "string" ? { disabledReason: raw.disabledReason } : {}),
    ...(templateSource ? { templateSource } : {}),
  };
}

/**
 * Default global location. Mirrors FileRunStore's `~/.code-shell/...` layout.
 * An explicit `root` (a `~/.code-shell`-equivalent data root) overrides the
 * default; absent → today's behavior byte-for-byte.
 */
export function defaultCronStorePath(root?: string): string {
  return join(root ?? join(homedir(), ".code-shell"), "cron.json");
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
      if (statSync(this.file).size > MAX_CRON_FILE_BYTES) {
        throw new Error("cron store exceeds the maximum file size");
      }
      const raw = readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as CronSnapshot;
      if (!parsed || !Array.isArray(parsed.jobs)) return [];
      const jobs: CronJob[] = [];
      const ids = new Set<string>();
      for (const value of parsed.jobs.slice(0, MAX_CRON_JOBS)) {
        const job = normalizeJob(value, false);
        if (!job || ids.has(job.id)) continue;
        ids.add(job.id);
        jobs.push(job);
      }
      return jobs;
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
    if (!Array.isArray(jobs) || jobs.length > MAX_CRON_JOBS) {
      throw new Error("cron store exceeds the maximum job count");
    }
    const normalized: CronJob[] = [];
    const ids = new Set<string>();
    let estimatedBytes = 32;
    for (const value of jobs) {
      const job = normalizeJob(value, true)!;
      if (ids.has(job.id)) throw new Error(`duplicate cron job id: ${job.id}`);
      ids.add(job.id);
      estimatedBytes += Buffer.byteLength(JSON.stringify(job)) + 2;
      if (estimatedBytes > MAX_CRON_FILE_BYTES) {
        throw new Error("cron store exceeds the maximum file size");
      }
      normalized.push(job);
    }
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);

    const snapshot: CronSnapshot = { version: 1, jobs: normalized };
    // Unique tmp name so a concurrent writer can't clobber our staging file.
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", {
        encoding: "utf-8",
        mode: 0o600,
      });
      renameSync(tmp, this.file);
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Preserve the original persistence error.
      }
    }
  }

  private acquireStoreLock(): () => void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
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

// Reused across calls — Atomics.wait only reads slot 0, which always stays 0,
// so a single shared buffer is safe and avoids per-call allocation in the
// lock-retry loop.
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
}
