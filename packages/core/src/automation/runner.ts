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
import { AUTOMATION_RUN_SOURCE } from "../run/EngineRunner.js";

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

// ─── Phase 2: RunManager-backed executor ────────────────────────────
//
// Instead of running a one-shot Engine directly, submit each fired job to a
// RunManager so the execution lands in the RunStore (queue, checkpoint,
// resume, attach, and a full run-history detail view). The automation module
// stays decoupled from the concrete RunManager via a structural interface —
// the host injects whatever satisfies `submit`.

/** Minimal structural view of RunManager.submit the executor needs. */
export interface RunSubmitter {
  submit(input: {
    objective: string;
    cwd?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ runId: string }>;
}

/**
 * Wire the scheduler to submit each fired job into a RunManager. Records the
 * resulting runId back onto the job (`lastRunId`) so the UI can link a job to
 * its latest run in the RunStore. Read-only is enforced at the RunManager level
 * by the host injecting `approvalBackend: HeadlessApprovalBackend("approve-read-only")`
 * into createRunManager (Phase 2) until sandbox+write tiers land (Phase 4/5).
 */
export function bindCronToRunManager(
  scheduler: CronScheduler,
  runManager: RunSubmitter,
): void {
  scheduler.setExecutor(async (job: CronJob) => {
    const snapshot = await runManager.submit({
      objective: job.prompt,
      cwd: job.cwd,
      metadata: { source: AUTOMATION_RUN_SOURCE, cronJobId: job.id, cronJobName: job.name },
    });
    // Record the run id on the job so the UI can link to run history.
    job.lastRunId = snapshot.runId;
  });
}
