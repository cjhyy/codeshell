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
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readSync,
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
  for (const field of ["projectId", "rootId"] as const) {
    if (
      raw[field] !== undefined &&
      (typeof raw[field] !== "string" ||
        !(raw[field] as string) ||
        (raw[field] as string).length > 512 ||
        (raw[field] as string).includes("\0"))
    ) {
      return invalid(field);
    }
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
  let lastExecution: CronJob["lastExecution"];
  if (raw.lastExecution !== undefined) {
    const value = raw.lastExecution as NonNullable<CronJob["lastExecution"]>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.id !== "string" ||
      !SAFE_ID.test(value.id) ||
      value.id.includes("..") ||
      !["running", "completed", "failed", "cancelled", "interrupted"].includes(value.status) ||
      !Number.isSafeInteger(value.startedAt) ||
      value.startedAt < 0 ||
      (value.status === "running"
        ? value.finishedAt !== undefined
        : !Number.isSafeInteger(value.finishedAt) || value.finishedAt! < value.startedAt) ||
      (value.detail !== undefined &&
        (typeof value.detail !== "string" ||
          value.detail.length > 2000 ||
          value.detail.includes("\0")))
    )
      return invalid("lastExecution");
    lastExecution = {
      id: value.id,
      status: value.status,
      startedAt: value.startedAt,
      ...(value.finishedAt !== undefined ? { finishedAt: value.finishedAt } : {}),
      ...(value.detail !== undefined ? { detail: value.detail } : {}),
    };
  }
  let panelSource: CronJob["panelSource"];
  if (raw.panelSource !== undefined) {
    const value = raw.panelSource as CronJob["panelSource"];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.appId !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value.appId) ||
      typeof value.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.revision)
    )
      return invalid("panelSource");
    panelSource = { appId: value.appId, revision: value.revision };
  }
  if (
    raw.creationKey !== undefined &&
    (typeof raw.creationKey !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(raw.creationKey))
  )
    return invalid("creationKey");
  if (
    raw.disabledReason !== undefined &&
    (typeof raw.disabledReason !== "string" || raw.disabledReason.length > 4_096)
  ) {
    return invalid("disabledReason");
  }

  let templateSource: CronJob["templateSource"];
  if (raw.templateSource !== undefined) {
    if (
      !raw.templateSource ||
      typeof raw.templateSource !== "object" ||
      Array.isArray(raw.templateSource)
    ) {
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
    ...(typeof raw.projectId === "string" ? { projectId: raw.projectId } : {}),
    ...(typeof raw.rootId === "string" ? { rootId: raw.rootId } : {}),
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
    ...(panelSource ? { panelSource } : {}),
    ...(lastExecution ? { lastExecution } : {}),
    ...(typeof raw.creationKey === "string" ? { creationKey: raw.creationKey } : {}),
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

  constructor(
    file?: string,
    private readonly options: { strictRead?: boolean } = {},
  ) {
    this.file = file ?? defaultCronStorePath();
  }

  /** Load persisted jobs. Strict hosts reject corrupt snapshots; legacy callers tolerate them. */
  load(): CronJob[] {
    return this.loadUnlocked();
  }

  /**
   * Atomically load, mutate, and save jobs under the store lock. This is the
   * safe path for create/update/delete/pause/resume across the desktop main
   * process and the agent worker process.
   */
  mutate<T>(fn: (jobs: CronJob[]) => { jobs: CronJob[]; result: T }): {
    jobs: CronJob[];
    result: T;
  } {
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
    if (!this.options.strictRead && !existsSync(this.file)) return [];
    try {
      let raw: string;
      if (this.options.strictRead) {
        // Refuse links, directories and unbounded reads; validate the same open
        // descriptor that supplies the snapshot, not a previously stat'ed path.
        let fd: number;
        try {
          const info = lstatSync(this.file);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe cron store file");
          fd = openSync(
            this.file,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
        try {
          const info = fstatSync(fd);
          if (!info.isFile() || info.size > MAX_CRON_FILE_BYTES)
            throw new Error("unsafe or oversized cron store file");
          const chunks: Buffer[] = [];
          let bytes = 0;
          while (bytes <= MAX_CRON_FILE_BYTES) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CRON_FILE_BYTES + 1 - bytes));
            const count = readSync(fd, chunk, 0, chunk.length, null);
            if (count === 0) break;
            bytes += count;
            chunks.push(chunk.subarray(0, count));
          }
          if (bytes > MAX_CRON_FILE_BYTES) throw new Error("oversized cron store file");
          raw = Buffer.concat(chunks, bytes).toString("utf-8");
        } finally {
          closeSync(fd);
        }
      } else {
        if (statSync(this.file).size > MAX_CRON_FILE_BYTES)
          throw new Error("cron store exceeds the maximum file size");
        raw = readFileSync(this.file, "utf-8");
      }
      const parsed = JSON.parse(raw) as CronSnapshot;
      if (!parsed || !Array.isArray(parsed.jobs)) {
        if (this.options.strictRead) throw new Error("invalid cron snapshot");
        return [];
      }
      if (this.options.strictRead && (parsed.version !== 1 || parsed.jobs.length > MAX_CRON_JOBS))
        throw new Error("unsupported or oversized cron snapshot");
      const jobs: CronJob[] = [];
      const ids = new Set<string>();
      const keys = new Set<string>();
      for (const value of parsed.jobs.slice(0, MAX_CRON_JOBS)) {
        const job = normalizeJob(value, !!this.options.strictRead);
        if (
          this.options.strictRead &&
          job &&
          (ids.has(job.id) || (job.creationKey !== undefined && keys.has(job.creationKey)))
        )
          throw new Error("duplicate cron job identity");
        if (!job || ids.has(job.id)) continue;
        ids.add(job.id);
        if (job.creationKey !== undefined) keys.add(job.creationKey);
        jobs.push(job);
      }
      return jobs;
    } catch (err) {
      if (this.options.strictRead) throw err;
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
    const keys = new Set<string>();
    let estimatedBytes = 32;
    for (const value of jobs) {
      const job = normalizeJob(value, true)!;
      if (ids.has(job.id)) throw new Error(`duplicate cron job id: ${job.id}`);
      ids.add(job.id);
      if (this.options.strictRead && job.creationKey !== undefined && keys.has(job.creationKey))
        throw new Error("duplicate cron job creation key");
      if (job.creationKey !== undefined) keys.add(job.creationKey);
      estimatedBytes += Buffer.byteLength(JSON.stringify(job)) + 2;
      if (estimatedBytes > MAX_CRON_FILE_BYTES) {
        throw new Error("cron store exceeds the maximum file size");
      }
      normalized.push(job);
    }
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (this.options.strictRead) {
      const info = lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("unsafe cron store directory");
    }
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
    if (this.options.strictRead) {
      const info = lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("unsafe cron store directory");
    }
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
