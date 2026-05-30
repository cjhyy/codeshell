/**
 * Cron scheduler — schedule and manage recurring agent tasks.
 *
 * Supports simple cron-like intervals. Each job runs the Engine
 * with a predefined prompt on schedule.
 */

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

  setExecutor(fn: (job: CronJob) => Promise<void>): void {
    this.onExecute = fn;
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
    return job;
  }

  delete(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    return this.jobs.delete(id);
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
    return true;
  }

  resume(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = true;
    const intervalMs = parseSchedule(job.schedule);
    this.startTimer(job, intervalMs);
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
