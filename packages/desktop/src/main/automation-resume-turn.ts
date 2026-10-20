import { ErrorCodes } from "@cjhyy/code-shell-core";
import type { CronJob, CronRunResult } from "@cjhyy/code-shell-core/internal";
import type { WorkerFrameMeta } from "@cjhyy/code-shell-server/worker";

type WorkerOutcome = { ok: true; result: unknown } | { ok: false; message: string; code?: number };

/** The part of AgentBridge a resume turn needs. */
export interface AutomationResumeBridge {
  requestWorker(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    options: {
      settleOnExit?: boolean;
      failFast?: boolean;
      waitForRunCompletion?: boolean;
      meta: WorkerFrameMeta;
    },
  ): Promise<WorkerOutcome>;
}

/**
 * Admission budget only: once the worker announces agent/runAccepted the request
 * waits for the real turn result (or worker exit), however long the turn takes.
 */
export const AUTOMATION_RESUME_ADMISSION_TIMEOUT_MS = 120_000;

const RESUME_META: WorkerFrameMeta = { origin: "host", producer: "automation-resume" };

/**
 * "Continue this conversation" jobs (job.resumeSessionId) don't run a headless
 * Engine — they feed their prompt into the LIVE session as a new user turn,
 * exactly like a human typing at a scheduled time. agent/run with an existing
 * sessionId makes the worker resume it from disk if it isn't already live
 * (engine.ts: exists()→resume). The run then inherits that session's own cwd /
 * permission mode / tools / background-completion wakeup.
 *
 * The returned promise settles only when the turn itself settles, so the
 * scheduler's same-job re-entrancy guard covers the whole turn. A worker
 * rejection or a lost/unconfirmed run throws, so the lifecycle reports a
 * failure rather than a completion.
 */
export function createAutomationResumeTurn(deps: {
  bridge: () => AutomationResumeBridge | null | undefined;
  notifyMissingTarget: (job: CronJob | undefined) => Promise<void>;
  admissionTimeoutMs?: number;
}) {
  return async (
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
    job?: CronJob,
  ): Promise<CronRunResult> => {
    const bridge = deps.bridge();
    if (!bridge) throw new Error("agent bridge is not ready");
    signal?.throwIfAborted();
    // requireExisting: if the user deleted the target conversation, the worker
    // returns SessionNotFound instead of running the prompt against a blank
    // session. We turn that into a `stop` so the scheduler auto-disables this
    // recurring job (and the host notifies the user) rather than silently
    // re-firing into nothing every tick.
    const run = bridge.requestWorker(
      "agent/run",
      {
        task: prompt,
        sessionId,
        requireExisting: true,
        ...(job?.projectId ? { projectId: job.projectId } : {}),
        ...(job?.rootId ? { rootId: job.rootId } : {}),
      },
      deps.admissionTimeoutMs ?? AUTOMATION_RESUME_ADMISSION_TIMEOUT_MS,
      { settleOnExit: true, failFast: true, waitForRunCompletion: true, meta: RESUME_META },
    );
    // Cancelling the scheduler run cancels the turn it injected; the request
    // still settles from the worker's own (aborted) result.
    const cancel = () => {
      void bridge.requestWorker("agent/cancel", { sessionId }, 15_000, {
        settleOnExit: true,
        failFast: true,
        meta: RESUME_META,
      });
    };
    signal?.addEventListener("abort", cancel, { once: true });
    let res: WorkerOutcome;
    try {
      res = await run;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    if (res.ok) {
      const r = res.result as { text?: string; reason?: string } | undefined;
      return { text: r?.text ?? "", reason: r?.reason ?? "done" };
    }
    if (res.code === ErrorCodes.SessionNotFound) {
      // A missing bound conversation is rare and consequential, so notify even while focused.
      await deps.notifyMissingTarget(job);
      return {
        text: "",
        reason: "resume-target-missing",
        stop: { reason: "续接的对话已被删除,已停止该定时任务" },
      };
    }
    throw new Error(res.message);
  };
}
