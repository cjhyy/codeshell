import type { SessionSummary } from "./transcripts";

/**
 * Pure teardown plan for deleting a session. Deleting a session must always
 * remove its on-disk dir (~/.code-shell/sessions/<id>/) AND reap its background
 * shells — the `sessions:delete` IPC does both (closeSession → killSession,
 * deleteSession → rm dir). Automation sessions additionally cancel the in-flight
 * cron run first (so it stops rewriting the dir we're about to delete) and clear
 * any legacy RunStore run dir.
 *
 * Kept pure + separate from the React handler so the decision is unit-testable.
 */
export interface SessionDeletionPlan {
  /** Engine session id to hand to `deleteSession` (disk dir + shell reap). */
  deleteEngineId: string;
  /** Cron job to cancel before delete (automation + still in-flight only). */
  cancelCronJobId?: string;
  /** Legacy RunStore run id to clear (automation only). */
  deleteRunId?: string;
}

const IN_FLIGHT_RUN_STATUSES = new Set([
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "blocked",
]);

export function planSessionDeletion(summary: SessionSummary | undefined): SessionDeletionPlan {
  // Fall back to the local UI id when the engine session id hasn't been bound
  // yet (session deleted before its first run completed).
  const deleteEngineId = summary?.engineSessionId ?? summary?.id ?? "";
  const plan: SessionDeletionPlan = { deleteEngineId };

  if (summary?.source === "automation") {
    const maybeRunning = summary.runStatus ? IN_FLIGHT_RUN_STATUSES.has(summary.runStatus) : false;
    if (maybeRunning && summary.cronJobId) {
      plan.cancelCronJobId = summary.cronJobId;
    }
    if (summary.runId) {
      plan.deleteRunId = summary.runId;
    }
  }
  return plan;
}
