/**
 * Automation service — bridges the renderer's automation UI to the live
 * in-process CronScheduler held by main. Main injects the scheduler via
 * setAutomationScheduler() once startAutomation() has run; the IPC handlers
 * call into it for list/create/delete/pause/resume/run-now.
 *
 * Returns plain serializable summaries (no class instances cross IPC).
 */

import type { CronScheduler, CronJob, CronPermissionLevel } from "@cjhyy/code-shell-core/internal";

export interface AutomationSummary {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  cwd: string | null;
  timezone: string | null;
  permissionLevel: CronPermissionLevel | null;
  lastRun: number | null;
  nextRun: number | null;
  runCount: number;
  createdAt: number;
  lastRunId: string | null;
  /** True = one-shot job: runs once then auto-deletes (CronCreate once:true). */
  once: boolean;
  /** Bound conversation to continue on fire (CronCreate resumeSessionId); null = fresh session. */
  resumeSessionId: string | null;
}

export interface CreateAutomationInput {
  name: string;
  schedule: string;
  prompt: string;
  cwd?: string;
  timezone?: string;
  permissionLevel?: CronPermissionLevel;
}

let scheduler: CronScheduler | null = null;

/** Injected by main after startAutomation(). */
export function setAutomationScheduler(s: CronScheduler | null): void {
  scheduler = s;
}

function toSummary(job: CronJob): AutomationSummary {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    prompt: job.prompt,
    enabled: job.enabled,
    cwd: job.cwd ?? null,
    timezone: job.timezone ?? null,
    permissionLevel: job.permissionLevel ?? null,
    lastRun: job.lastRun ?? null,
    nextRun: job.nextRun ?? null,
    runCount: job.runCount,
    createdAt: job.createdAt,
    lastRunId: job.lastRunId ?? null,
    once: job.once === true,
    resumeSessionId: job.resumeSessionId ?? null,
  };
}

function requireScheduler(): CronScheduler {
  if (!scheduler) throw new Error("automation scheduler not initialized");
  return scheduler;
}

/**
 * Reload jobs from the shared on-disk store before reading. The desktop agent
 * worker is a separate process; a chat-created job (via CronCreate) is written
 * to ~/.code-shell/cron.json by that worker but isn't in main's in-memory
 * scheduler until we reload. loadJobs() is idempotent and (since main has
 * execution enabled) arms any newly-seen job so main takes over its schedule.
 */
function syncFromStore(): void {
  scheduler?.loadJobs();
}

/** Reload cron jobs from the shared on-disk store into main's live scheduler,
 *  arming any newly-seen job. Called when the worker reports a cron change
 *  (agent/cronChanged) so an AI-created job takes effect without the user
 *  opening the automation UI. loadJobs() is idempotent. */
export function reloadAutomations(): void {
  scheduler?.loadJobs();
}

export function listAutomations(): AutomationSummary[] {
  if (!scheduler) return [];
  syncFromStore();
  return scheduler.list().map(toSummary);
}

export function getAutomation(id: string): AutomationSummary | null {
  if (!scheduler) return null;
  syncFromStore();
  const job = scheduler.get(id);
  return job ? toSummary(job) : null;
}

export function createAutomation(input: CreateAutomationInput): AutomationSummary {
  const s = requireScheduler();
  syncFromStore();
  const job = s.create(input.name, input.schedule, input.prompt, {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.permissionLevel !== undefined ? { permissionLevel: input.permissionLevel } : {}),
  });
  return toSummary(job);
}

export interface UpdateAutomationInput {
  name?: string;
  prompt?: string;
  schedule?: string;
  timezone?: string;
  cwd?: string;
  permissionLevel?: CronPermissionLevel;
}

export function updateAutomation(id: string, patch: UpdateAutomationInput): AutomationSummary | null {
  const s = requireScheduler();
  syncFromStore();
  const job = s.update(id, patch);
  return job ? toSummary(job) : null;
}

export function deleteAutomation(id: string): boolean {
  const s = requireScheduler();
  syncFromStore();
  return s.delete(id);
}

export function pauseAutomation(id: string): boolean {
  const s = requireScheduler();
  syncFromStore();
  return s.pause(id);
}

export function resumeAutomation(id: string): boolean {
  const s = requireScheduler();
  syncFromStore();
  return s.resume(id);
}

/** Fire a job immediately (out of band of its schedule). Returns false if unknown. */
export function runAutomationNow(id: string): boolean {
  const s = requireScheduler();
  syncFromStore();
  return s.runNow(id);
}

/**
 * Abort the in-flight run of cron job `id`, if any, and wait for it to fully
 * settle. Used when the user deletes a still-running automation session — the
 * run's in-main Engine is cancelled AND we await its teardown (incl. the final
 * saveState) so the caller can delete the session dir without racing a late
 * write that would recreate it. Resolves false when no run is in flight.
 */
export function cancelAutomationRun(id: string): Promise<boolean> {
  return scheduler?.abort(id) ?? Promise.resolve(false);
}
