/**
 * Cron scheduler — schedule and manage recurring agent tasks.
 *
 * Supports simple cron-like intervals. Each job runs the Engine
 * with a predefined prompt on schedule.
 */

import type { CronStore } from "./store.js";
import { isCronExpression, parseCronExpression, nextCronTime } from "./cron-expr.js";

/**
 * How late a cron-expression timer may fire and still be considered "on time".
 * A setTimeout that fires within this window of its scheduled instant runs
 * normally; one that fires later (the host slept through the scheduled time
 * and the timer fired on wake) is treated as a misfire — skipped and re-armed
 * to the next occurrence. 90s comfortably clears cron's 60s granularity plus
 * normal timer jitter, while still catching a multi-minute/hour sleep drift.
 */
const CRON_MISFIRE_GRACE_MS = 90_000;

/**
 * True when a cron timer fired too far past its scheduled instant to be a
 * legitimate on-time run — i.e. the host slept through the scheduled time and
 * the timer fired on wake. Exported for unit testing the sleep/wake guard.
 */
export function isCronMisfire(scheduledFor: number, now: number): boolean {
  return now - scheduledFor > CRON_MISFIRE_GRACE_MS;
}

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
  /** True = one-shot: delete the job after its first real execution so it never
   *  fires again (e.g. "in 10 minutes, do X once"). */
  once?: boolean;
  /** When set, the fired job RESUMES this codeshell chat session instead of
   *  starting a fresh one: the prompt is appended as a new user turn to that
   *  session (restored from disk if not in memory), carrying its transcript /
   *  goal / context. Unset = the default standalone behaviour (new session per
   *  fire). The host's executor honours this. */
  resumeSessionId?: string;
  /** Why the job was auto-disabled (set by `disableWithReason`), e.g. a resume
   *  target whose session no longer exists. Surfaced in the UI so a silently
   *  stopped job is explainable; cleared when the job is re-enabled. */
  disabledReason?: string;
}

/** Optional metadata accepted by create(). */
export interface CreateJobOptions {
  cwd?: string;
  timezone?: string;
  permissionLevel?: CronPermissionLevel;
  once?: boolean;
  resumeSessionId?: string;
}

/** Fields editable via update(). Any omitted field is left unchanged. */
export interface UpdateJobPatch {
  name?: string;
  prompt?: string;
  schedule?: string;
  timezone?: string;
  cwd?: string;
  permissionLevel?: CronPermissionLevel;
}

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Job ids with an execution currently in flight — prevents a tick from
   *  starting a second run of a job whose previous run hasn't finished. */
  private running = new Set<string>();
  /** In-flight runs keyed by job id: the AbortController that cancels the run,
   *  plus `done` — a promise that resolves when the run has FULLY settled
   *  (executor returned, including any post-abort bookkeeping like Engine's
   *  final saveState). The re-entrancy guard (`running`) ensures at most one
   *  run per job, so one entry per job id is sufficient. `abort(jobId)` trips
   *  the controller and returns `done` so callers can wait for the run to
   *  actually stop before acting (e.g. deleting its session dir without racing
   *  a final write that would recreate it). */
  private runningControllers = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private nextId = 1;
  private onExecute?: (job: CronJob, signal: AbortSignal) => Promise<void>;
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

  setExecutor(fn: (job: CronJob, signal: AbortSignal) => Promise<void>): void {
    this.onExecute = fn;
  }

  /**
   * Abort the in-flight run of `jobId`, if any. Aborts the AbortSignal handed
   * to the executor (which Engine.run cooperates with — it resolves with
   * reason "aborted_streaming" rather than throwing). Returns false when the
   * job has no run currently in flight (already settled, never started, or
   * unknown id). The run's own finally block clears the controller, so a
   * settled run is a no-op here.
   */
  async abort(jobId: string): Promise<boolean> {
    const entry = this.runningControllers.get(jobId);
    if (!entry) return false;
    entry.controller.abort();
    // Wait for the run to fully settle (the executor's promise, incl. any
    // post-abort write) so callers don't race its teardown.
    await entry.done;
    return true;
  }

  /**
   * Restore persisted jobs and rebuild their timers. Call once at startup
   * after `setStore`. nextRun is recomputed forward from now — we do NOT
   * catch up on runs missed while the process was down (avoids a restart
   * thundering-herd; aligns with Codex's stateless philosophy). Disabled
   * jobs are restored without a timer.
   */
  /**
   * Reconcile in-memory jobs against the on-disk store (the store is the source
   * of truth). Safe to call repeatedly — used both at startup and as a periodic
   * re-sync when another process (e.g. the desktop agent worker) may have
   * created/deleted/changed jobs through the same store. Reconciliation:
   *   - jobs on disk but not in memory  → added (and armed if enabled)
   *   - jobs in memory but not on disk  → removed + timer cleared
   *   - jobs whose schedule/enabled differ → re-armed to match disk
   *
   * Pass `{ arm: false }` in a host that must NOT execute jobs (the worker —
   * separate process from the one that owns execution); it still tracks +
   * persists but starts no timers, so jobs never run twice across processes.
   */
  loadJobs(opts?: { arm?: boolean }): void {
    if (!this.store) return;
    this.reconcileJobs(this.store.load(), opts);
  }

  private reconcileJobs(persisted: CronJob[], opts?: { arm?: boolean }): void {
    const arm = opts?.arm ?? true;
    const onDisk = new Map(persisted.map((j) => [j.id, j]));

    // 1. Drop in-memory jobs that no longer exist on disk (deleted elsewhere).
    for (const id of [...this.jobs.keys()]) {
      if (!onDisk.has(id)) {
        this.clearTimer(id);
        this.jobs.delete(id);
      }
    }

    // 2. Add or update jobs from disk.
    let maxId = 0;
    for (const job of persisted) {
      const prev = this.jobs.get(job.id);
      this.jobs.set(job.id, job);
      const n = parseInt(job.id, 10);
      if (Number.isFinite(n) && n > maxId) maxId = n;

      // (Re)arm when execution is on. arm() is idempotent (clears any prior
      // timer first), so calling it for unchanged jobs is harmless; it also
      // refreshes nextRun for display.
      if (arm && job.enabled) {
        this.arm(job);
      } else {
        // Disabled (or arm suppressed): ensure no stale timer survives a
        // prior enabled state.
        if (prev && this.timers.has(job.id)) this.clearTimer(job.id);
        // Still refresh nextRun for display even when not arming.
        if (!arm || !job.enabled) this.refreshNextRunForDisplay(job);
      }
    }
    this.nextId = Math.max(this.nextId, maxId + 1);
  }

  private nextPersistedId(jobs: CronJob[]): string {
    let maxId = 0;
    for (const job of jobs) {
      const n = parseInt(job.id, 10);
      if (Number.isFinite(n) && n > maxId) maxId = n;
    }
    return String(Math.max(this.nextId, maxId + 1));
  }

  /** Recompute nextRun without arming a timer (for display in disabled/no-arm hosts). */
  private refreshNextRunForDisplay(job: CronJob): void {
    if (isCronExpression(job.schedule)) {
      const next = nextCronTime(parseCronExpression(job.schedule), job.timezone ?? "UTC", Date.now());
      job.nextRun = next ?? undefined;
    } else {
      try {
        job.nextRun = Date.now() + parseSchedule(job.schedule);
      } catch {
        job.nextRun = undefined;
      }
    }
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

  private persistRunStats(job: CronJob): void {
    // No store → nothing to persist. (persist() would also no-op here.)
    if (!this.store) return;
    try {
      this.store.mutate((jobs) => {
        const idx = jobs.findIndex((j) => j.id === job.id);
        if (idx === -1) return { jobs, result: null };
        const next = [...jobs];
        next[idx] = {
          ...next[idx],
          lastRun: job.lastRun,
          nextRun: job.nextRun,
          runCount: job.runCount,
          ...(job.lastRunId !== undefined ? { lastRunId: job.lastRunId } : {}),
        };
        return { jobs: next, result: null };
      });
    } catch {
      // Persistence is best-effort; missed UI metadata must not stop scheduling.
    }
  }

  create(name: string, schedule: string, prompt: string, opts?: CreateJobOptions): CronJob {
    // Validate the schedule up front (interval or cron expr) so a bad string
    // surfaces at create time, not silently at the first missed tick.
    validateSchedule(schedule, opts?.timezone);

    if (this.store) {
      const tx = this.store.mutate((jobs) => {
        const id = this.nextPersistedId(jobs);
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
          ...(opts?.once === true ? { once: true } : {}),
          ...(opts?.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
        };
        this.refreshNextRunForDisplay(job);
        return { jobs: [...jobs, job], result: job };
      });
      this.reconcileJobs(tx.jobs);
      return this.jobs.get(tx.result.id) ?? tx.result;
    }

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
      ...(opts?.once === true ? { once: true } : {}),
      ...(opts?.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
    };

    this.jobs.set(id, job);
    this.arm(job);
    this.persist();
    return job;
  }

  delete(id: string): boolean {
    if (this.store) {
      const tx = this.store.mutate((jobs) => {
        const next = jobs.filter((j) => j.id !== id);
        return { jobs: next, result: next.length !== jobs.length };
      });
      this.reconcileJobs(tx.jobs);
      return tx.result;
    }

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
    if (this.store) {
      const tx = this.store.mutate((jobs) => {
        let changed = false;
        const next = jobs.map((j) => {
          if (j.id !== id) return j;
          changed = true;
          return { ...j, enabled: false };
        });
        return { jobs: next, result: changed };
      });
      this.reconcileJobs(tx.jobs);
      return tx.result;
    }

    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = false;
    this.clearTimer(id);
    this.persist();
    return true;
  }

  /**
   * Auto-disable a job and record WHY (e.g. its resume target session was
   * deleted). Unlike `delete`, the job is retained (enabled=false) so the user
   * can see it stopped and its reason in the UI, then delete or re-point it.
   * Mirrors `pause` but also stamps `disabledReason`. Idempotent-safe: a
   * subsequent `resume()` clears the reason.
   */
  disableWithReason(id: string, reason: string): boolean {
    if (this.store) {
      const tx = this.store.mutate((jobs) => {
        let changed = false;
        const next = jobs.map((j) => {
          if (j.id !== id) return j;
          changed = true;
          return { ...j, enabled: false, disabledReason: reason };
        });
        return { jobs: next, result: changed };
      });
      this.reconcileJobs(tx.jobs);
      return tx.result;
    }

    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = false;
    job.disabledReason = reason;
    this.clearTimer(id);
    this.persist();
    return true;
  }

  resume(id: string): boolean {
    if (this.store) {
      const tx = this.store.mutate((jobs) => {
        let changed = false;
        const next = jobs.map((j) => {
          if (j.id !== id) return j;
          changed = true;
          const job = { ...j, enabled: true, disabledReason: undefined };
          this.refreshNextRunForDisplay(job);
          return job;
        });
        return { jobs: next, result: changed };
      });
      this.reconcileJobs(tx.jobs);
      return tx.result;
    }

    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = true;
    job.disabledReason = undefined;
    this.arm(job);
    this.persist();
    return true;
  }

  /**
   * Edit an existing job's fields (name/prompt/schedule/timezone/cwd/
   * permissionLevel) without recreating it. A changed schedule is validated up
   * front (throws on invalid, leaving the job untouched), then the timer is
   * re-armed so the new schedule takes effect immediately. Enabled state is
   * preserved — a paused job stays paused (no timer). Returns the updated job,
   * or null if the id is unknown.
   */
  update(id: string, patch: UpdateJobPatch): CronJob | null {
    if (this.store) {
      const tx = this.store.mutate((jobs) => {
        let updated: CronJob | null = null;
        const next = jobs.map((j) => {
          if (j.id !== id) return j;
          const job = { ...j };

          const nextSchedule = patch.schedule ?? job.schedule;
          const nextTimezone = patch.timezone ?? job.timezone;
          if (patch.schedule !== undefined || patch.timezone !== undefined) {
            validateSchedule(nextSchedule, nextTimezone);
          }

          if (patch.name !== undefined) job.name = patch.name;
          if (patch.prompt !== undefined) job.prompt = patch.prompt;
          if (patch.schedule !== undefined) job.schedule = patch.schedule;
          if (patch.timezone !== undefined) job.timezone = patch.timezone;
          if (patch.cwd !== undefined) job.cwd = patch.cwd;
          if (patch.permissionLevel !== undefined) job.permissionLevel = patch.permissionLevel;
          this.refreshNextRunForDisplay(job);
          updated = job;
          return job;
        });
        return { jobs: next, result: updated };
      });
      this.reconcileJobs(tx.jobs);
      return tx.result ? this.jobs.get(id) ?? tx.result : null;
    }

    const job = this.jobs.get(id);
    if (!job) return null;

    // Validate a new schedule/timezone BEFORE mutating anything.
    const nextSchedule = patch.schedule ?? job.schedule;
    const nextTimezone = patch.timezone ?? job.timezone;
    if (patch.schedule !== undefined || patch.timezone !== undefined) {
      validateSchedule(nextSchedule, nextTimezone);
    }

    if (patch.name !== undefined) job.name = patch.name;
    if (patch.prompt !== undefined) job.prompt = patch.prompt;
    if (patch.schedule !== undefined) job.schedule = patch.schedule;
    if (patch.timezone !== undefined) job.timezone = patch.timezone;
    if (patch.cwd !== undefined) job.cwd = patch.cwd;
    if (patch.permissionLevel !== undefined) job.permissionLevel = patch.permissionLevel;

    // Re-arm so a schedule/timezone change drives execution now. arm() is
    // idempotent and respects enabled + executionEnabled (paused → no timer,
    // but nextRun still refreshed for display).
    if (job.enabled) {
      this.arm(job);
    } else {
      this.clearTimer(id);
      this.refreshNextRunForDisplay(job);
    }
    this.persist();
    return job;
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
    const scheduledFor = next;
    const delay = Math.max(0, next - Date.now());
    const timer = setTimeout(() => {
      // Misfire guard for sleep/wake drift. A setTimeout pauses while the host
      // sleeps, then fires the instant the machine wakes — which can be hours
      // off the scheduled wall-clock (observed: a `0 9 * * *` job running at
      // 06:56 because the Mac did a maintenance wake and the timer fired on
      // resume). If we wake too far PAST the scheduled instant, this is a
      // misfire: skip running and re-arm to the next correct occurrence rather
      // than running at the wrong time.
      if (isCronMisfire(scheduledFor, Date.now())) {
        if (job.enabled) this.armCron(job);
        return;
      }
      void this.fire(job, () => {
        // Re-arm for the following occurrence — but only if the job still
        // exists. A one-shot (once) job deletes itself in fire()'s finally,
        // so this closure must not resurrect it via a stale reference.
        if (job.enabled && this.jobs.has(job.id)) this.armCron(job);
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
    // One in-flight entry per job. abort(jobId) trips `controller` (Engine.run
    // cooperates and resolves early) and awaits `done`, which we resolve in the
    // finally below once the run — including any post-abort write — has settled.
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    this.runningControllers.set(job.id, { controller, done });
    job.lastRun = Date.now();
    job.runCount++;
    afterStats();
    // Persist updated run stats so runCount/lastRun/nextRun survive a restart.
    this.persistRunStats(job);
    try {
      await this.onExecute?.(job, controller.signal);
    } catch {
      // Job execution failed — continue scheduling.
    } finally {
      // The executor may have recorded lastRunId on the job. Persist only run
      // metadata so an old in-flight job cannot overwrite an edited prompt or
      // schedule with its stale copy.
      this.persistRunStats(job);
      this.running.delete(job.id);
      this.runningControllers.delete(job.id);
      // One-shot: delete after its first execution so it never fires again.
      // Done after persistRunStats so the final stats write can't race the
      // removal; delete() clears the timer + removes from store/in-memory.
      if (job.once) this.delete(job.id);
      // Unblock any abort() awaiting this run's teardown.
      resolveDone();
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
export function parseSchedule(schedule: string): number {
  const match = schedule.match(/^(\d+)(s|m|h|d)$/);
  if (match) {
    const value = parseInt(match[1], 10);
    // A zero interval ("0s"/"0m"/…) → 0ms → setInterval(fn, 0) spins
    // continuously. Reject it (fall through to throw), matching the raw-ms
    // path's `> 0` guard and the "throw on bad input" contract.
    if (value > 0) {
      switch (match[2]) {
        case "s": return value * 1000;
        case "m": return value * 60 * 1000;
        case "h": return value * 60 * 60 * 1000;
        case "d": return value * 24 * 60 * 60 * 1000;
      }
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
