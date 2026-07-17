/**
 * automation/ — zero-environment-dependency scheduling module.
 *
 * Hosts (Electron main, future CLI server) load this module and inject their
 * own store + runner. The module imports nothing from Electron/Ink and makes
 * no GUI/TTY assumptions, so the same code runs in any host
 * (docs/automation-plan-2026-05-31.md, D1).
 */

import { CronScheduler } from "./scheduler.js";
import {
  bindCronToEngine,
  bindCronToRunManager,
  type CronRunner,
  type RunSubmitter,
} from "./runner.js";
import type { CronStore } from "./store.js";

export interface StartAutomationDeps {
  /** Persistence backend (injected; module never picks a path itself). */
  store: CronStore;
  /**
   * Execution backend. Provide exactly one:
   *   - `runner`: a one-shot run callback (Phase 1 direct-Engine path).
   *   - `runManager`: a RunManager submitter (Phase 2 — runs land in RunStore
   *     with full history/checkpoint/resume).
   */
  runner?: CronRunner;
  runManager?: RunSubmitter;
}

export interface AutomationHandle {
  scheduler: CronScheduler;
  /** Halt all timers and release the scheduler. Idempotent. */
  stop(): void;
}

/**
 * Wire a scheduler to a host-provided store + execution backend and restore
 * persisted jobs. Returns a handle the host keeps for its lifetime. Prefers
 * `runManager` when both are supplied (it gives run history).
 */
export function startAutomation(deps: StartAutomationDeps): AutomationHandle {
  const scheduler = new CronScheduler(deps.store);
  if (deps.runManager) {
    bindCronToRunManager(scheduler, deps.runManager);
  } else if (deps.runner) {
    bindCronToEngine(scheduler, deps.runner);
  } else {
    throw new Error("startAutomation requires either a runner or a runManager");
  }
  scheduler.loadJobs();
  return {
    scheduler,
    stop: () => scheduler.stopAll(),
  };
}

// Re-export the building blocks so hosts import everything from one place.
export { CronScheduler, cronScheduler, type CronJob } from "./scheduler.js";
export { CronStore, defaultCronStorePath } from "./store.js";
export {
  bindCronToEngine,
  bindCronToRunManager,
  type CronRunner,
  type CronRunRequest,
  type CronRunResult,
  type RunSubmitter,
} from "./runner.js";
export {
  isCronExpression,
  parseCronExpression,
  nextCronTime,
  type ParsedCron,
} from "./cron-expr.js";
export { validateSchedule } from "./scheduler.js";
export type {
  CronPermissionLevel,
  CronTemplateSource,
  CreateJobOptions,
  UpdateJobPatch,
} from "./scheduler.js";
export { resolveWritePolicy, wrapUntrustedInput, type WritePolicy } from "./write-policy.js";
export {
  runWriteJobInWorktree,
  type WriteJobGitOps,
  type RunWriteJobInput,
  type RunWriteJobResult,
} from "./write-run.js";
