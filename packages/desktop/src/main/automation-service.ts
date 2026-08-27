/**
 * Automation service — bridges the renderer's automation UI to the live
 * in-process CronScheduler held by main. Main injects the scheduler via
 * setAutomationScheduler() once startAutomation() has run; the IPC handlers
 * call into it for list/create/delete/pause/resume/run-now.
 *
 * Returns plain serializable summaries (no class instances cross IPC).
 */

import type {
  CronScheduler,
  CronJob,
  CronPermissionLevel,
  CronTemplateSource,
} from "@cjhyy/code-shell-core/internal";
import {
  resolveAutomationCreateAuthority,
  resolveAutomationUpdateAuthority,
  validateAutomationResumeAuthority,
  type AutomationAuthorityDeps,
} from "./automation-authority.js";

export interface AutomationSummary {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  cwd: string | null;
  projectId: string | null;
  rootId: string | null;
  timezone: string | null;
  permissionLevel: CronPermissionLevel | null;
  lastRun: number | null;
  nextRun: number | null;
  runCount: number;
  createdAt: number;
  /**
   * @deprecated Always null in this product.
   *
   * Only `bindCronToRunManager` writes `CronJob.lastRunId`, and production
   * automation goes through `startAutomation({ runner })` — a plain Engine
   * Session, never RunManager. Automation history IS the session list; the UI no
   * longer reads this. Kept on the wire so an older renderer does not break on a
   * missing key.
   */
  lastRunId: string | null;
  /** True = one-shot job: runs once then auto-deletes (CronCreate once:true). */
  once: boolean;
  /** Bound conversation to continue on fire (CronCreate resumeSessionId); null = fresh session. */
  resumeSessionId: string | null;
  /** Plugin template provenance; null for ordinary jobs. */
  templateSource: CronTemplateSource | null;
}

export interface CreateAutomationInput {
  name: string;
  schedule: string;
  prompt: string;
  cwd?: string;
  projectId?: string | null;
  rootId?: string | null;
  timezone?: string;
  permissionLevel?: CronPermissionLevel;
  /** Optional existing task to continue when the schedule fires. */
  resumeSessionId?: string;
  /** Main-only creator authority; never persisted. */
  authoritySessionId?: string;
  once?: boolean;
}

let scheduler: CronScheduler | null = null;

/** Injected by main after startAutomation(). */
export function setAutomationScheduler(s: CronScheduler | null): void {
  scheduler = s;
}

export function automationSummary(job: CronJob): AutomationSummary {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    prompt: job.prompt,
    enabled: job.enabled,
    cwd: job.cwd ?? null,
    projectId: job.projectId ?? null,
    rootId: job.rootId ?? null,
    timezone: job.timezone ?? null,
    permissionLevel: job.permissionLevel ?? null,
    lastRun: job.lastRun ?? null,
    nextRun: job.nextRun ?? null,
    runCount: job.runCount,
    createdAt: job.createdAt,
    lastRunId: job.lastRunId ?? null,
    once: job.once === true,
    resumeSessionId: job.resumeSessionId ?? null,
    templateSource: job.templateSource ?? null,
  };
}

function requireScheduler(): CronScheduler {
  if (!scheduler) throw new Error("automation scheduler not initialized");
  return scheduler;
}

/** Scheduler injection stays host-owned; plugin instantiation receives it explicitly. */
export function requireAutomationScheduler(): CronScheduler {
  return requireScheduler();
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
  return scheduler.list().map(automationSummary);
}

export function getAutomation(id: string): AutomationSummary | null {
  if (!scheduler) return null;
  syncFromStore();
  const job = scheduler.get(id);
  return job ? automationSummary(job) : null;
}

export async function createAutomation(
  input: CreateAutomationInput,
  authorityDeps: AutomationAuthorityDeps,
): Promise<AutomationSummary> {
  const authority = await resolveAutomationCreateAuthority(input, authorityDeps);
  const s = requireScheduler();
  syncFromStore();
  const job = s.create(input.name, input.schedule, input.prompt, {
    ...(authority.cwd !== undefined ? { cwd: authority.cwd } : {}),
    ...(typeof authority.projectId === "string" ? { projectId: authority.projectId } : {}),
    ...(typeof authority.rootId === "string" ? { rootId: authority.rootId } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.permissionLevel !== undefined ? { permissionLevel: input.permissionLevel } : {}),
    ...(input.resumeSessionId !== undefined ? { resumeSessionId: input.resumeSessionId } : {}),
    ...(input.once === true ? { once: true } : {}),
  });
  return automationSummary(job);
}

export interface UpdateAutomationInput {
  name?: string;
  prompt?: string;
  schedule?: string;
  timezone?: string;
  cwd?: string;
  projectId?: string | null;
  rootId?: string | null;
  permissionLevel?: CronPermissionLevel;
  resumeSessionId?: string | null;
}

export async function updateAutomation(
  id: string,
  patch: UpdateAutomationInput,
  authorityDeps: AutomationAuthorityDeps,
  scope?: { resumeSessionId: string },
): Promise<AutomationSummary | null> {
  const s = requireScheduler();
  syncFromStore();
  const existing = s.get(id);
  if (!existing) return null;
  if (scope && existing.resumeSessionId !== scope.resumeSessionId) {
    throw new Error("automation is not bound to the authorized resume Session");
  }
  const authority = await resolveAutomationUpdateAuthority(patch, existing, authorityDeps);
  const {
    cwd: _cwd,
    projectId: _projectId,
    rootId: _rootId,
    resumeSessionId: _resumeSessionId,
    ...definition
  } = patch;
  const job = s.update(id, { ...definition, ...authority });
  return job ? automationSummary(job) : null;
}

export async function listAutomationsForResumeSession(
  resumeSessionId: string,
  authorityDeps: AutomationAuthorityDeps,
): Promise<AutomationSummary[]> {
  const candidates = listAutomations().filter((job) => job.resumeSessionId === resumeSessionId);
  const validations = await Promise.all(
    candidates.map((job) =>
      validateAutomationResumeAuthority(
        {
          cwd: job.cwd ?? undefined,
          projectId: job.projectId ?? undefined,
          rootId: job.rootId ?? undefined,
          resumeSessionId,
        },
        authorityDeps,
      ),
    ),
  );
  return candidates.filter((_job, index) => validations[index]?.ok === true);
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
