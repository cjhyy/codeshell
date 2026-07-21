import { describe, expect, test } from "bun:test";
import {
  buildPetLongTaskContext,
  createPetLongTask,
  parsePetLongTask,
  petLongTaskResumePrompt,
  transitionPetLongTask,
} from "./long-task.js";

function created() {
  return createPetLongTask({
    id: "pet-task-1",
    originClientMessageId: "message-1",
    objective: "Ship the feature and verify it end to end",
    workspacePath: "/work/app",
    sessionId: "session-1",
    completionTarget: {
      kind: "im-gateway",
      channel: "wechat",
      target: "owner-conversation",
    },
    continuationDepth: 2,
    at: 100,
  });
}

describe("Pet long-task state machine", () => {
  test("persists a closure decision before its idempotent continuation launch", () => {
    const created = createPetLongTask({
      id: "task-closure",
      originClientMessageId: "message-closure",
      objective: "Finish the release",
      workspacePath: "/work/app",
      sessionId: "session-closure",
      at: 100,
    });
    const completed = transitionPetLongTask(created, {
      kind: "completed",
      at: 200,
      summary: "Implementation finished",
    });
    const decided = transitionPetLongTask(completed, {
      kind: "closure-decided",
      at: 210,
      key: "task-closure:1:completed",
      text: "Continuing with verification",
      continuation: {
        clientMessageId: "pet-continuation:task-closure:1:completed",
        objective: "Verify the release",
        workspacePath: "/work/app",
      },
    });
    const launched = transitionPetLongTask(decided, {
      kind: "continuation-started",
      at: 220,
      key: "task-closure:1:completed",
      sessionId: "session-next",
      taskId: "task-next",
    });

    expect(parsePetLongTask(JSON.parse(JSON.stringify(launched)))?.closureDecision).toEqual({
      key: "task-closure:1:completed",
      text: "Continuing with verification",
      decidedAt: 210,
      continuation: {
        clientMessageId: "pet-continuation:task-closure:1:completed",
        objective: "Verify the release",
        workspacePath: "/work/app",
      },
      launch: { sessionId: "session-next", taskId: "task-next", at: 220 },
    });
  });

  test("tracks real lifecycle instead of treating launch acceptance as completion", () => {
    const queued = created();
    const running = transitionPetLongTask(queued, { kind: "started", at: 200 });
    const waiting = transitionPetLongTask(running, {
      kind: "waiting",
      at: 300,
      waitingFor: "Approve Bash",
    });
    const resumed = transitionPetLongTask(waiting, {
      kind: "resumed",
      at: 400,
    });
    const completed = transitionPetLongTask(resumed, {
      kind: "completed",
      at: 500,
      summary: "Feature shipped and tests passed",
      artifacts: [{ kind: "file", label: "Build", reference: "dist/app.js" }],
    });

    expect(queued.status).toBe("queued");
    expect(queued.verificationMode).toBe("turn");
    expect(running.status).toBe("running");
    expect(waiting).toMatchObject({
      status: "waiting",
      phase: "waiting-user",
      waitingFor: "Approve Bash",
    });
    expect(completed).toMatchObject({
      status: "completed",
      completedAt: 500,
      summary: "Feature shipped and tests passed",
    });
    expect(completed.events.map((event) => event.kind)).toEqual([
      "created",
      "started",
      "waiting",
      "resumed",
      "completed",
    ]);
    expect(completed.artifacts).toContainEqual({
      kind: "file",
      label: "Build",
      reference: "dist/app.js",
    });
  });

  test("fences late worker completion after an explicit cancel", () => {
    const cancelled = transitionPetLongTask(created(), {
      kind: "cancelled",
      at: 200,
      reason: "User cancelled",
    });
    const late = transitionPetLongTask(cancelled, {
      kind: "completed",
      at: 300,
      summary: "stale worker completion",
    });
    expect(late).toBe(cancelled);
  });

  test("ignores stale progress so a final assistant checkpoint remains the completion summary", () => {
    const running = transitionPetLongTask(created(), { kind: "started", at: 200 });
    const checkpoint = transitionPetLongTask(running, {
      kind: "checkpoint",
      at: 500,
      summary: "Final result with the verified file path",
    });
    const staleProjection = transitionPetLongTask(checkpoint, {
      kind: "progress",
      at: 490,
      phase: "executing",
      summary: "模型处理中",
    });
    const completed = transitionPetLongTask(staleProjection, {
      kind: "completed",
      at: 600,
    });

    expect(staleProjection).toBe(checkpoint);
    expect(completed.summary).toBe("Final result with the verified file path");
  });

  test("retry reopens a failed task and preserves durable history", () => {
    const failed = transitionPetLongTask(created(), {
      kind: "failed",
      at: 200,
      error: "worker exited",
    });
    const recorded = transitionPetLongTask(failed, {
      kind: "closure-recorded",
      at: 250,
    });
    const retrying = transitionPetLongTask(recorded, {
      kind: "retrying",
      at: 300,
    });
    expect(retrying).toMatchObject({ status: "queued", phase: "planning", attempt: 2 });
    expect(retrying.closureRecordedAt).toBeUndefined();
    expect(retrying.events.at(-1)?.kind).toBe("retrying");
  });

  test("builds bounded manager context and resume prompt", () => {
    const active = transitionPetLongTask(created(), {
      kind: "checkpoint",
      at: 200,
      summary: "Implementation is half done",
      nextAction: "Run integration tests",
    });
    const completed = transitionPetLongTask(
      createPetLongTask({
        id: "pet-task-2",
        originClientMessageId: "message-2",
        objective: "Done task",
        workspacePath: null,
        sessionId: "session-2",
        at: 50,
      }),
      { kind: "completed", at: 150, summary: "Done" },
    );
    const context = buildPetLongTaskContext([completed, active]);
    expect(context.active[0]).toMatchObject({
      taskId: "pet-task-1",
      status: "queued",
      summary: "Implementation is half done",
      nextAction: "Run integration tests",
    });
    expect(context.recent[0]).toMatchObject({ taskId: "pet-task-2", status: "completed" });
    expect(petLongTaskResumePrompt(active)).toContain("Latest durable checkpoint");
  });

  test("drops invalid durable rows without throwing", () => {
    expect(parsePetLongTask({ nope: true })).toBeNull();
    const raw = JSON.parse(JSON.stringify(created()));
    raw.events.push({ id: "bad", sequence: 2, kind: "invented", at: 200 });
    const parsed = parsePetLongTask(raw);
    expect(parsed).toMatchObject({
      id: "pet-task-1",
      status: "queued",
      completionTarget: {
        kind: "im-gateway",
        channel: "wechat",
        target: "owner-conversation",
      },
      continuationDepth: 2,
    });
    expect(parsed?.events).toHaveLength(1);
  });

  test("preserves forced-Goal semantics for rows written before verificationMode", () => {
    const raw = JSON.parse(JSON.stringify(created()));
    delete raw.verificationMode;
    expect(parsePetLongTask(raw)?.verificationMode).toBe("goal");
  });
});
