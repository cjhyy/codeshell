import { describe, test, expect } from "bun:test";
import { planSessionDeletion } from "./sessionDeletionPlan";
import type { SessionSummary } from "./transcripts";

/**
 * Deleting a session must always tear down its on-disk dir + background shells,
 * not just the renderer localStorage entry. Previously only automation sessions
 * reached the disk-delete IPC; ordinary chats leaked
 * ~/.code-shell/sessions/<id>/ and their background shells were never reaped.
 * planSessionDeletion pins the decision: every session gets a deleteEngineId;
 * automation additionally cancels the in-flight run and clears the run dir.
 */
function sess(extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: "ui-1", title: "t", createdAt: 0, updatedAt: 0, ...extra };
}

describe("planSessionDeletion", () => {
  test("ordinary chat: deletes the on-disk session (engine id, falls back to ui id)", () => {
    const plan = planSessionDeletion(sess({ engineSessionId: "eng-9" }));
    expect(plan.deleteEngineId).toBe("eng-9");
    expect(plan.cancelCronJobId).toBeUndefined();
    expect(plan.deleteRunId).toBeUndefined();
  });

  test("ordinary chat with no engineSessionId falls back to the ui id", () => {
    const plan = planSessionDeletion(sess({ id: "ui-2" }));
    expect(plan.deleteEngineId).toBe("ui-2");
  });

  test("automation running: cancels the owning cron job before delete", () => {
    const plan = planSessionDeletion(
      sess({ source: "automation", cronJobId: "cron-3", runStatus: "running", runId: "run-3", engineSessionId: "eng-3" }),
    );
    expect(plan.cancelCronJobId).toBe("cron-3");
    expect(plan.deleteEngineId).toBe("eng-3");
    expect(plan.deleteRunId).toBe("run-3");
  });

  test("automation already finished: no cancel, still deletes dir + run", () => {
    const plan = planSessionDeletion(
      sess({ source: "automation", cronJobId: "cron-4", runStatus: "completed", runId: "run-4" }),
    );
    expect(plan.cancelCronJobId).toBeUndefined();
    expect(plan.deleteRunId).toBe("run-4");
    expect(plan.deleteEngineId).toBe("ui-1");
  });

  test("automation with no cronJobId can't cancel (nothing to cancel)", () => {
    const plan = planSessionDeletion(
      sess({ source: "automation", runStatus: "running", runId: "run-5" }),
    );
    expect(plan.cancelCronJobId).toBeUndefined();
  });
});
