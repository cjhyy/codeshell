import { describe, expect, it, test } from "bun:test";
import { buildPetLongTaskContext, type PetLongTask } from "@cjhyy/code-shell-pet";

import { closureRequestIdentity } from "./pet-closure-receipt.js";
import { recordPetDelegationClosureBestEffort } from "./pet-delegation-closure.js";

describe("recordPetDelegationClosureBestEffort", () => {
  it("contains distillation failures so later closure effects can continue", async () => {
    const errors: unknown[] = [];
    const laterEffects: string[] = [];

    const recorded = await recordPetDelegationClosureBestEffort(
      {
        onDelegationClosed: async () => {
          throw new Error("memory store unavailable");
        },
      },
      { dedupeKey: "task:1:completed", objective: "finish", outcome: "completed" },
      (error) => errors.push(error),
    );
    laterEffects.push("closure-recorded", "chat", "gateway", "desktop-notification");

    expect(recorded).toBe(false);
    expect(errors).toHaveLength(1);
    expect(laterEffects).toEqual(["closure-recorded", "chat", "gateway", "desktop-notification"]);
  });
});

const SESSION = "s-work";

function task(patch: Partial<PetLongTask> & Pick<PetLongTask, "id">): PetLongTask {
  return {
    schemaVersion: 1,
    originClientMessageId: `origin:${patch.id}`,
    objective: `objective of ${patch.id}`,
    workspacePath: "/work/project",
    sessionId: SESSION,
    verificationMode: "final-response",
    status: "completed",
    phase: "finalizing",
    attempt: 1,
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    artifacts: [],
    events: [],
    ...patch,
  } as PetLongTask;
}

describe("closure receipt request identity", () => {
  test("a request that failed while queued is the latest request, and never ran", () => {
    // The earlier request to the Session finished; this one was queued after it.
    const earlier = task({
      id: "pet-task-earlier",
      createdAt: 100,
      updatedAt: 500,
      startedAt: 110,
    });
    const failed = task({
      id: "pet-task-queued",
      createdAt: 600,
      updatedAt: 900,
      status: "failed",
      lastError: "external runtime session was replaced before its queued turn",
    });
    const identity = closureRequestIdentity(failed, buildPetLongTaskContext([earlier, failed]));
    expect(identity).toEqual({
      createdAt: 600,
      started: false,
      request: { latestForSession: true, openForSession: [], newerForSession: [] },
    });
  });

  test("a later request to the same Session is named, so the two cannot be confused", () => {
    const old = task({
      id: "pet-task-old",
      createdAt: 100,
      status: "failed",
      startedAt: 120,
      events: [{ kind: "started" } as PetLongTask["events"][number]],
    });
    const next = task({
      id: "pet-task-next",
      createdAt: 700,
      updatedAt: 700,
      status: "queued",
      phase: "launching",
      objective: "合并并部署\n收尾",
    });
    const elsewhere = task({ id: "pet-task-other", createdAt: 800, sessionId: "s-other" });
    const identity = closureRequestIdentity(old, buildPetLongTaskContext([old, next, elsewhere]));
    expect(identity.started).toBe(true);
    expect(identity.request).toEqual({
      latestForSession: false,
      openForSession: [
        { taskId: "pet-task-next", status: "queued", createdAt: 700, objective: "合并并部署 收尾" },
      ],
      newerForSession: [
        { taskId: "pet-task-next", status: "queued", createdAt: 700, objective: "合并并部署 收尾" },
      ],
    });
  });

  test("without task context the receipt still says when the request was made and whether it ran", () => {
    expect(
      closureRequestIdentity(task({ id: "pet-task-alone", createdAt: 42 }), undefined),
    ).toEqual({
      createdAt: 42,
      started: false,
      request: { latestForSession: true, openForSession: [], newerForSession: [] },
    });
  });
});
