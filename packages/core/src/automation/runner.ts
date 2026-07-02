/**
 * cron-runtime — wire the CronScheduler's executor to a real run backend.
 *
 * B1 fix: `CronScheduler.setExecutor` was never called in production, so cron
 * jobs were created and ticked but did nothing on fire. `bindCronToEngine`
 * installs an executor that, for each fired job, hands a one-shot headless run
 * request to the caller-supplied `runner`.
 *
 * Security contract: cron runs unattended, so each job's permission tier
 * (`job.permissionLevel`) is resolved through `resolveWritePolicy`, which maps
 * the tier to a permissionMode + approval backend (see write-policy.ts). The
 * mode stays "default" so the classifier doesn't add its own acceptEdits
 * auto-allow rules ahead of the backend — the backend is the single source of
 * truth for what a tier permits. An undefined/unknown tier falls back to the
 * read-only backend.
 */

import type { CronJob } from "./scheduler.js";
import type { CronScheduler } from "./scheduler.js";
import type { PermissionMode } from "../types.js";
import type { ApprovalBackend } from "../tool-system/permission.js";
import type { SandboxMode } from "../tool-system/sandbox/index.js";
import { AUTOMATION_RUN_SOURCE } from "../run/EngineRunner.js";
import { resolveWritePolicy } from "./write-policy.js";

/** What the executor hands to the run backend for one fired job. */
export interface CronRunRequest {
  job: CronJob;
  /** The prompt to run — `job.prompt`, surfaced for convenience. */
  prompt: string;
  /** Permission mode the run must use (see security contract above). */
  permissionMode: PermissionMode;
  /** Approval backend the run must install (resolved from the job's tier). */
  approvalBackend: ApprovalBackend;
  /** Sandbox mode the run should confine writes/shell to (resolved from the
   *  job's tier). The host runner must forward this to `Engine({ sandbox })`
   *  so even a `full` tier can't escape the workspace — defense in depth on
   *  top of the approval backend. */
  sandboxMode: SandboxMode;
  /** Abort signal for the run — tripped by `CronScheduler.abort(jobId)` when
   *  the run must be cancelled mid-flight (e.g. the user deletes its session
   *  while it's still executing). Forward to `Engine.run({ signal })`. */
  signal?: AbortSignal;
}

export interface CronRunResult {
  text: string;
  reason: string;
  /**
   * When present, this fire hit a PERMANENT failure that will recur every tick
   * (e.g. a `resumeSessionId` whose session was deleted). The scheduler should
   * auto-disable the job with `stop.reason` rather than silently retrying
   * forever. Absent = transient/normal outcome; keep scheduling.
   */
  stop?: { reason: string };
}

/** The pluggable run backend. Production wires this to a headless Engine run;
 *  tests pass a stub. Phase 5 will swap this for a RunManager.submit() path. */
export type CronRunner = (req: CronRunRequest) => Promise<CronRunResult>;

/**
 * Install the cron executor. After this call, a fired job invokes `runner`
 * with a run request whose permission tier comes from the job. Transient errors
 * from `runner` are swallowed by the scheduler's try/catch (scheduler.ts) so one
 * bad run never stops future ticks. A PERMANENT failure the runner flags via
 * `result.stop` (e.g. a resume target whose session was deleted) auto-disables
 * the job with that reason, so it stops silently retrying forever.
 */
export function bindCronToEngine(scheduler: CronScheduler, runner: CronRunner): void {
  scheduler.setExecutor(async (job: CronJob, signal: AbortSignal) => {
    const policy = resolveWritePolicy(job.permissionLevel);
    const req: CronRunRequest = {
      job,
      prompt: job.prompt,
      permissionMode: policy.permissionMode,
      approvalBackend: policy.approvalBackend,
      sandboxMode: policy.sandboxMode,
      signal,
    };
    const result = await runner(req);
    if (result?.stop) {
      scheduler.disableWithReason(job.id, result.stop.reason);
    }
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
  scheduler.setExecutor(async (job: CronJob, _signal: AbortSignal) => {
    const snapshot = await runManager.submit({
      objective: job.prompt,
      cwd: job.cwd,
      metadata: { source: AUTOMATION_RUN_SOURCE, cronJobId: job.id, cronJobName: job.name },
    });
    // Record the run id on the job so the UI can link to run history.
    job.lastRunId = snapshot.runId;
  });
}
