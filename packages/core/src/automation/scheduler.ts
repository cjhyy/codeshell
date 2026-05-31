/**
 * Cron scheduler — schedule and manage recurring agent tasks.
 *
 * Supports simple cron-like intervals. Each job runs the Engine
 * with a predefined prompt on schedule.
 */

import type { CronStore } from "./store.js";
import { isCronExpression, parseCronExpression, nextCronTime } from "./cron-expr.js";

/** Permission tier a scheduled job runs under (Phase 5 enforces write tiers). */
export type CronPermissionLevel = "read-only" | "workspace-write" | "full";

export interface CronJob {
  id: string;
  name: string;
  schedule: string;        // cron expression ("0 9 * * 1-5") or interval ("5m", "1h", "1500")
  prompt: string;          // task prompt to run
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  runCount: number;
  createdAt: number;
  /** Working directory the job runs in (the project it monitors/edits). */
  cwd?: string;
  /** IANA timezone for cron-expression schedules (e.g. "Asia/Shanghai"). Default "UTC". */
  timezone?: string;
  /** Permission tier; defaults to read-only when unset. */
  permissionLevel?: CronPermissionLevel;
  /** RunStore run id of the most recent execution (Phase 2 RunManager path). */
  lastRunId?: string;
}

/** Optional metadata accepted by create(). */
export interface CreateJobOptions {
  cwd?: string;
  timezone?: string;
  permissionLevel?: CronPermissionLevel;
}

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Job ids with an execution currently in flight — prevents a tick from
   *  starting a second run of a job whose previous run hasn't finished. */
  private running = new Set<string>();
  private nextId = 1;
  private onExecute?: (job: CronJob) => Promise<void>;
  /** Optional persistence backend. When set, every create/delete/pause/resume
   *  writes the full job set to disk so jobs survive a restart. */
  private store?: CronStore;
  /** When false, the scheduler persists + tracks jobs but NEVER arms timers
   *  (so it can't execute). Used by the desktop agent worker, a separate
   *  process from the main process that owns execution. Default true. */
  private executionEnabled = true;

  constructor(store?: CronStore) {
    this.store = store;
  }

  /**
   * Disable (or re-enable) timer arming / execution. A host that only needs to
   * persist + read jobs — never run them — calls setExecutionEnabled(false).
   * Stops any timers already armed when turning off.
   */
  setExecutionEnabled(enabled: boolean): void {
    this.executionEnabled = enabled;
    if (!enabled) {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    }
  }

  /** Attach (or replace) the persistence backend. Used to give the shared
   *  singleton a store at runtime startup without changing its identity. */
  setStore(store: CronStore): void {
    this.store = store;
  }

  setExecutor(fn: (job: CronJob) => Promise<void>): void {
    this.onExecute = fn;
  }

  /**
   * Restore persisted jobs and rebuild their timers. Call once at startup
   * after `setStore`. nextRun is recomputed forward from now — we do NOT
   * catch up on runs missed while the process was down (avoids a restart
   * thundering-herd; aligns with Codex's stateless philosophy). Disabled
   * jobs are restored without a timer.
   */
  /**
   * Restore persisted jobs into memory. By default also (re)arms timers for
   * enabled jobs. Pass `{ arm: false }` in a host that must NOT execute jobs —
   * e.g. the desktop agent worker, which is a separate process from the main
   * process that owns execution. There the worker only persists (so CronCreate
   * sees existing ids and writes to the shared store) and must never start
   * timers, or jobs would run twice (once per process) and fight over run stats.
   */
  loadJobs(opts?: { arm?: boolean }): void {
    if (!this.store) return;
    const arm = opts?.arm ?? true;
    const persisted = this.store.load();
    let maxId = 0;
    for (const job of persisted) {
      this.jobs.set(job.id, job);
      // Advance id allocation past every restored id so a newly created job
      // can't collide with a restored one.
      const n = parseInt(job.id, 10);
      if (Number.isFinite(n) && n > maxId) maxId = n;
      if (arm && job.enabled) {
        // nextRun is recomputed forward from now; we do NOT catch up missed runs.
        this.arm(job);
      }
    }
    this.nextId = Math.max(this.nextId, maxId + 1);
  }

  private persist(): void {
    if (!this.store) return;
    try {
      this.store.save([...this.jobs.values()]);
    } catch {
      // Persistence is best-effort: an unwritable disk should not break the
      // in-memory scheduler. The store logs the failure.
    }
  }

  create(name: string, schedule: string, prompt: string, opts?: CreateJobOptions): CronJob {
    // Validate the schedule up front (interval or cron expr) so a bad string
    // surfaces at create time, not silently at the first missed tick.
    validateSchedule(schedule, opts?.timezone);

    const id = String(this.nextId++);
    const job: CronJob = {
      id,
      name,
      schedule,
      prompt,
      enabled: true,
      runCount: 0,
      createdAt: Date.now(),
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.timezone !== undefined ? { timezone: opts.timezone } : {}),
      ...(opts?.permissionLevel !== undefined ? { permissionLevel: opts.permissionLevel } : {}),
    };

    this.jobs.set(id, job);
    this.arm(job);
    this.persist();
    return job;
  }

  delete(id: string): boolean {
    this.clearTimer(id);
    const deleted = this.jobs.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  list(): CronJob[] {
    return [...this.jobs.values()];
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  pause(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = false;
    this.clearTimer(id);
    this.persist();
    return true;
  }

  resume(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = true;
    this.arm(job);
    this.persist();
    return true;
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Fire a job immediately, out of band of its schedule (the "Run now" button).
   * Respects the re-entrancy guard (no-op if a run is already in flight) and
   * does not disturb the existing timer. Returns false if the id is unknown.
   */
  runNow(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    // Run-stat bookkeeping is shared with scheduled fires; nextRun is left as-is
    // (a manual run shouldn't shift the next scheduled occurrence). force=true
    // so a paused job can still be run on demand.
    void this.fire(job, () => {}, true);
    return true;
  }

  /**
   * Arm a job's timer. Interval schedules ("5m") use setInterval; cron-
   * expression schedules ("0 9 * * 1-5") compute the next trigger in the
   * job's timezone and use setTimeout, re-arming after each fire. nextRun is
   * updated to reflect the scheduled instant.
   */
  private arm(job: CronJob): void {
    this.clearTimer(job.id);
    if (isCronExpression(job.schedule)) {
      // Compute nextRun for display even when execution is disabled.
      const cron = parseCronExpression(job.schedule);
      const next = nextCronTime(cron, job.timezone ?? "UTC", Date.now());
      job.nextRun = next ?? undefined;
      if (!this.executionEnabled) return;
      this.armCron(job);
    } else {
      const intervalMs = parseSchedule(job.schedule);
      job.nextRun = Date.now() + intervalMs;
      if (!this.executionEnabled) return;
      const timer = setInterval(() => void this.fire(job, () => this.refreshIntervalNextRun(job, intervalMs)), intervalMs);
      this.timers.set(job.id, timer);
    }
  }

  private refreshIntervalNextRun(job: CronJob, intervalMs: number): void {
    job.nextRun = Date.now() + intervalMs;
  }

  private armCron(job: CronJob): void {
    const cron = parseCronExpression(job.schedule);
    const tz = job.timezone ?? "UTC";
    const next = nextCronTime(cron, tz, Date.now());
    if (next === null) {
      // Unsatisfiable within the search window — leave unscheduled.
      job.nextRun = undefined;
      return;
    }
    job.nextRun = next;
    const delay = Math.max(0, next - Date.now());
    const timer = setTimeout(() => {
      void this.fire(job, () => {
        // Re-arm for the following occurrence.
        if (job.enabled) this.armCron(job);
      });
    }, delay);
    this.timers.set(job.id, timer);
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  /**
   * Shared fire path for both schedule kinds. Re-entrancy guard, run-stat
   * bookkeeping, persistence, then the executor. `afterStats` updates nextRun
   * for the next occurrence (interval: now+interval; cron: re-armed inside).
   */
  private async fire(job: CronJob, afterStats: () => void, force = false): Promise<void> {
    if (!job.enabled && !force) return;
    // Re-entrancy guard: if this job's previous run is still in flight
    // (onExecute slower than the interval), skip rather than stacking
    // overlapping executions that double-count runCount.
    if (this.running.has(job.id)) return;
    this.running.add(job.id);
    job.lastRun = Date.now();
    job.runCount++;
    afterStats();
    // Persist updated run stats so runCount/lastRun/nextRun survive a restart.
    this.persist();
    try {
      await this.onExecute?.(job);
    } catch {
      // Job execution failed — continue scheduling.
    } finally {
      this.running.delete(job.id);
    }
  }
}

/** Validate a schedule string (interval or cron expr) without scheduling. Throws on invalid. */
function validateSchedule(schedule: string, timezone?: string): void {
  if (isCronExpression(schedule)) {
    parseCronExpression(schedule); // throws on bad fields
    // Validate timezone is acceptable to Intl (throws RangeError if not).
    if (timezone !== undefined) {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    }
    return;
  }
  parseSchedule(schedule); // throws on bad interval
}

/**
 * Parse a schedule string into milliseconds.
 * Supports: "30s", "5m", "1h", "1d", or raw (all-digit) milliseconds.
 *
 * Throws on anything else rather than silently falling back to a default —
 * a typo like "5mn" should surface as an error, not quietly schedule every
 * 10 minutes (review-2026-05-30).
 */
function parseSchedule(schedule: string): number {
  const match = schedule.match(/^(\d+)(s|m|h|d)$/);
  if (match) {
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case "s": return value * 1000;
      case "m": return value * 60 * 1000;
      case "h": return value * 60 * 60 * 1000;
      case "d": return value * 24 * 60 * 60 * 1000;
    }
  }
  // Raw milliseconds — must be all digits and > 0 (parseInt would otherwise
  // accept "1500abc").
  if (/^\d+$/.test(schedule)) {
    const ms = parseInt(schedule, 10);
    if (ms > 0) return ms;
  }

  throw new Error(
    `Invalid schedule: ${JSON.stringify(schedule)}. Use "30s"/"5m"/"1h"/"1d" or a positive number of milliseconds.`,
  );
}

export const cronScheduler = new CronScheduler();
