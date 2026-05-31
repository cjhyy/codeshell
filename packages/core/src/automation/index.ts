/**
 * automation/ — zero-environment-dependency scheduling module.
 *
 * Hosts (Electron main, future CLI server) load this module and inject their
 * own store + runner. The module imports nothing from Electron/Ink and makes
 * no GUI/TTY assumptions, so the same code runs in any host
 * (docs/automation-plan-2026-05-31.md, D1).
 */

import { CronScheduler } from "./scheduler.js";
import { bindCronToEngine, type CronRunner } from "./runner.js";
import type { CronStore } from "./store.js";

export interface StartAutomationDeps {
  /** Persistence backend (injected; module never picks a path itself). */
  store: CronStore;
  /** Run backend invoked when a job fires (injected by the host). */
  runner: CronRunner;
}

export interface AutomationHandle {
  scheduler: CronScheduler;
  /** Halt all timers and release the scheduler. Idempotent. */
  stop(): void;
}

/**
 * Wire a scheduler to a host-provided store + runner and restore persisted
 * jobs. Returns a handle the host keeps for its lifetime.
 */
export function startAutomation(deps: StartAutomationDeps): AutomationHandle {
  const scheduler = new CronScheduler(deps.store);
  bindCronToEngine(scheduler, deps.runner);
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
  type CronRunner,
  type CronRunRequest,
  type CronRunResult,
} from "./runner.js";
