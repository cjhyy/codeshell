/**
 * Cron scheduler — schedule and manage recurring agent tasks.
 *
 * Supports simple cron-like intervals. Each job runs the Engine
 * with a predefined prompt on schedule.
 */

import type { CronStore } from "./cron-store.js";

export interface CronJob {
  id: string;
  name: string;
  schedule: string;        // cron expression or interval string (e.g. "5m", "1h", "0 */2 * * *")
  prompt: string;          // task prompt to run
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  runCount: number;
  createdAt: number;
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

  constructor(store?: CronStore) {
    this.store = store;
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
  loadJobs(): void {
    if (!this.store) return;
    const persisted = this.store.load();
    let maxId = 0;
    for (const job of persisted) {
      this.jobs.set(job.id, job);
      // Advance id allocation past every restored id so a newly created job
      // can't collide with a restored one.
      const n = parseInt(job.id, 10);
      if (Number.isFinite(n) && n > maxId) maxId = n;
      if (job.enabled) {
        const intervalMs = parseSchedule(job.schedule);
        job.nextRun = Date.now() + intervalMs;
        this.startTimer(job, intervalMs);
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

  create(name: string, schedule: string, prompt: string): CronJob {
    const id = String(this.nextId++);
    const intervalMs = parseSchedule(schedule);

    const job: CronJob = {
      id,
      name,
      schedule,
      prompt,
      enabled: true,
      nextRun: Date.now() + intervalMs,
      runCount: 0,
      createdAt: Date.now(),
    };

    this.jobs.set(id, job);
    this.startTimer(job, intervalMs);
    this.persist();
    return job;
  }

  delete(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
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
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    this.persist();
    return true;
  }

  resume(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = true;
    const intervalMs = parseSchedule(job.schedule);
    this.startTimer(job, intervalMs);
    this.persist();
    return true;
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  private startTimer(job: CronJob, intervalMs: number): void {
    if (this.timers.has(job.id)) {
      clearInterval(this.timers.get(job.id)!);
    }

    const timer = setInterval(async () => {
      if (!job.enabled) return;
      // Re-entrancy guard: if this job's previous run is still in flight
      // (onExecute slower than the interval), skip this tick rather than
      // stacking overlapping executions that double-count runCount/nextRun.
      if (this.running.has(job.id)) return;
      this.running.add(job.id);
      job.lastRun = Date.now();
      job.runCount++;
      job.nextRun = Date.now() + intervalMs;
      // Persist updated run stats so runCount/lastRun survive a restart.
      this.persist();
      try {
        await this.onExecute?.(job);
      } catch {
        // Job execution failed — continue scheduling
      } finally {
        this.running.delete(job.id);
      }
    }, intervalMs);

    this.timers.set(job.id, timer);
  }
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
