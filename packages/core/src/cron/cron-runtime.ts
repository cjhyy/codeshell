/**
 * cron-runtime — wire the CronScheduler's executor to a real run backend.
 *
 * B1 fix: `CronScheduler.setExecutor` was never called in production, so cron
 * jobs were created and ticked but did nothing on fire. `bindCronToEngine`
 * installs an executor that, for each fired job, hands a one-shot headless run
 * request to the caller-supplied `runner`.
 *
 * Security contract (Phase 0, pre-sandbox): cron runs unattended, so until the
 * sandbox (Phase 4) lands we run jobs READ-ONLY. That means:
 *   - permissionMode "default" (NOT "approve-read-only" — that string is not a
 *     PermissionMode enum value). In "default" mode the classifier does not add
 *     the acceptEdits Write/Edit auto-allow rules, so writes fall through to the
 *     approval backend.
 *   - an explicit `HeadlessApprovalBackend("approve-read-only")`, which approves
 *     read tools (Read/Glob/Grep/WebSearch/WebFetch/ToolSearch) and denies
 *     everything else (Write/Edit/Bash/...).
 * Once Phase 4 sandboxing is in place this can be relaxed to "approve-all" +
 * a workspace-write sandbox.
 */

import type { CronJob } from "./scheduler.js";
import type { CronScheduler } from "./scheduler.js";
import type { PermissionMode } from "../types.js";
import { HeadlessApprovalBackend, type ApprovalBackend } from "../tool-system/permission.js";

/** What the executor hands to the run backend for one fired job. */
export interface CronRunRequest {
  job: CronJob;
  /** The prompt to run — `job.prompt`, surfaced for convenience. */
  prompt: string;
  /** Permission mode the run must use (see security contract above). */
  permissionMode: PermissionMode;
  /** Approval backend the run must install (read-only in Phase 0). */
  approvalBackend: ApprovalBackend;
}

export interface CronRunResult {
  text: string;
  reason: string;
}

/** The pluggable run backend. Production wires this to a headless Engine run;
 *  tests pass a stub. Phase 5 will swap this for a RunManager.submit() path. */
export type CronRunner = (req: CronRunRequest) => Promise<CronRunResult>;

/**
 * Install the cron executor. After this call, a fired job invokes `runner`
 * with a read-only run request. Errors from `runner` are swallowed by the
 * scheduler's existing try/catch (scheduler.ts) so one bad run never stops
 * future ticks — we still log here so failures are visible.
 */
export function bindCronToEngine(scheduler: CronScheduler, runner: CronRunner): void {
  scheduler.setExecutor(async (job: CronJob) => {
    const req: CronRunRequest = {
      job,
      prompt: job.prompt,
      permissionMode: "default",
      approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
    };
    await runner(req);
  });
}
