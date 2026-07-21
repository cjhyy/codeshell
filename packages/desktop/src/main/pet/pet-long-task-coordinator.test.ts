import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
} from "./pet-state-aggregator.js";
import { PetLongTaskCoordinator } from "./pet-long-task-coordinator.js";
import { PetLongTaskStore } from "./pet-long-task-store.js";
import { petDelegationSessionId } from "./pet-work-delegation-host.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function emptySnapshot(): DesktopPetProjectionSnapshot {
  return {
    version: 1,
    generation: 1,
    workerState: "active",
    sessions: [],
    pending: [],
    observedAt: 100,
    workMemorySegments: [],
  };
}

function fakeProjection(snapshot = emptySnapshot()) {
  const listeners = new Set<(event: DesktopPetProjectionEvent) => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: (event: DesktopPetProjectionEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event: DesktopPetProjectionEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

async function harness(snapshot = emptySnapshot()) {
  const root = await mkdtemp(join(tmpdir(), "pet-long-task-coordinator-"));
  roots.push(root);
  let now = 1_000;
  const store = new PetLongTaskStore(join(root, "tasks.json"), () => now);
  const projection = fakeProjection(snapshot);
  const launches: Array<Record<string, unknown>> = [];
  const workerRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const closed: Array<{ id: string; status: string }> = [];
  const coordinator = new PetLongTaskCoordinator({
    store,
    projection,
    worker: {
      hasLiveWorker: () => false,
      requestWorker: async (method, params) => {
        workerRequests.push({ method, params });
        return { ok: false as const, message: "no worker" };
      },
    },
    launcher: {
      start: async (delegation) => {
        launches.push(delegation as unknown as Record<string, unknown>);
        return {
          sessionId:
            delegation.targetSessionId ?? petDelegationSessionId(delegation.clientMessageId),
          cwd: delegation.workspacePath ?? "/safe/no-repo",
        };
      },
    },
    now: () => now,
    onTaskClosed: async (task) => {
      closed.push({ id: task.id, status: task.status });
    },
  });
  await coordinator.start();
  return {
    root,
    store,
    projection,
    coordinator,
    launches,
    workerRequests,
    closed,
    tick: (value: number) => {
      now = value;
    },
  };
}

describe("PetLongTaskCoordinator", () => {
  test("replays an unacknowledged terminal closure once after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "pet-long-task-coordinator-"));
    roots.push(root);
    const filePath = join(root, "tasks.json");
    const seed = new PetLongTaskStore(filePath, () => 1_000);
    await seed.load();
    const task = await seed.create({
      id: "pet-task-replay",
      originClientMessageId: "message-replay",
      objective: "Finish durably",
      workspacePath: "/work/app",
      sessionId: "session-replay",
      at: 1_000,
    });
    await seed.transition(task.id, {
      kind: "completed",
      at: 2_000,
      summary: "Finished before the process exited",
    });

    const closed: string[] = [];
    const coordinator = new PetLongTaskCoordinator({
      store: new PetLongTaskStore(filePath, () => 3_000),
      projection: fakeProjection(),
      worker: {
        hasLiveWorker: () => false,
        requestWorker: async () => ({ ok: false as const, message: "no worker" }),
      },
      launcher: {
        start: async () => ({ sessionId: "session-replay", cwd: "/work/app" }),
      },
      now: () => 3_000,
      onTaskClosed: async (closedTask) => {
        closed.push(closedTask.id);
      },
    });
    await coordinator.start();
    expect(closed).toEqual([task.id]);
    expect(coordinator.context().recent[0]?.taskId).toBe(task.id);
    coordinator.stop();

    const replayed: string[] = [];
    const afterAck = new PetLongTaskCoordinator({
      store: new PetLongTaskStore(filePath, () => 4_000),
      projection: fakeProjection(),
      worker: {
        hasLiveWorker: () => false,
        requestWorker: async () => ({ ok: false as const, message: "no worker" }),
      },
      launcher: {
        start: async () => ({ sessionId: "session-replay", cwd: "/work/app" }),
      },
      now: () => 4_000,
      onTaskClosed: async (closedTask) => {
        replayed.push(closedTask.id);
      },
    });
    await afterAck.start();
    expect(replayed).toEqual([]);
    afterAck.stop();
  });

  test("keeps launch running, checkpoints output, and closes only on real completion", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-1",
      task: "Implement and verify the feature",
      goalObjective: "Implement and verify the feature",
      workspacePath: "/work/app",
      completionTarget: {
        kind: "im-gateway",
        channel: "wechat",
        target: "owner-conversation",
      },
      continuationDepth: 1,
    });
    expect(h.store.get(launch.taskId)?.status).toBe("running");
    expect(h.store.get(launch.taskId)?.completionTarget).toEqual({
      kind: "im-gateway",
      channel: "wechat",
      target: "owner-conversation",
    });
    expect(h.store.get(launch.taskId)?.continuationDepth).toBe(1);
    expect(h.closed).toEqual([]);

    h.tick(2_000);
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "assistant_message",
      message: { role: "assistant", content: "Implementation done; running final checks." },
    });
    expect(h.store.get(launch.taskId)?.summary).toBe("Implementation done; running final checks.");

    h.tick(3_000);
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "goal_progress",
      status: "met",
      goalId: "goal-1",
      revision: 1,
    });
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "turn_complete",
      reason: "completed",
    });
    expect(h.store.get(launch.taskId)).toMatchObject({
      status: "completed",
      summary: "Implementation done; running final checks.",
    });
    expect(h.closed).toEqual([{ id: launch.taskId, status: "completed" }]);

    // Duplicate projection completion is fenced and does not duplicate closure memory.
    h.projection.emit({
      kind: "session-upsert",
      version: 2,
      generation: 1,
      observedAt: 3_100,
      session: {
        agentSessionId: launch.sessionId,
        runState: "terminal",
        queueDepth: 0,
        lastActivityAt: 3_100,
        pendingDecisionCount: 0,
        terminal: { status: "completed", at: 3_100 },
        freshness: { source: "live-event", observedAt: 3_100, workerState: "active" },
      },
    });
    await Promise.resolve();
    expect(h.closed).toHaveLength(1);
  });

  test("does not confuse a generic completed turn with a verified Goal outcome", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-unverified-stop",
      task: "Finish the objective, not merely one turn",
      goalObjective: "Finish the objective, not merely one turn",
      workspacePath: "/work/app",
    });
    h.tick(2_000);
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "turn_complete",
      reason: "completed",
    });
    expect(h.store.get(launch.taskId)).toMatchObject({
      status: "interrupted",
      waitingFor: "The work session stopped without a verified Goal-complete signal",
    });
    expect(h.closed).toEqual([]);
  });

  test("closes an ordinary Work Session without requiring a Goal", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-ordinary-completion",
      task: "Inspect the log and report the cause",
      workspacePath: "/work/app",
    });
    expect(h.store.get(launch.taskId)?.verificationMode).toBe("turn");

    h.tick(2_000);
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "assistant_message",
      message: { role: "assistant", content: "The cause is confirmed." },
    });
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "turn_complete",
      reason: "completed",
    });

    expect(h.store.get(launch.taskId)).toMatchObject({
      status: "completed",
      summary: "The cause is confirmed.",
    });
    expect(h.closed).toEqual([{ id: launch.taskId, status: "completed" }]);

    const cleared = await h.coordinator.clearCompleted();
    expect(cleared.tasks).toEqual([]);
    expect(h.store.get(launch.taskId)).toBeUndefined();
  });

  test("recovers a missed ordinary completion from the durable projection", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-recovered-turn-completion",
      task: "Inspect the durable result",
      workspacePath: "/work/app",
    });
    h.coordinator.stop();
    await h.store.flush();

    const closed: string[] = [];
    const recoveredStore = new PetLongTaskStore(join(h.root, "tasks.json"), () => 3_000);
    const recovered = new PetLongTaskCoordinator({
      store: recoveredStore,
      projection: fakeProjection({
        ...emptySnapshot(),
        observedAt: 2_000,
        sessions: [
          {
            agentSessionId: launch.sessionId,
            runState: "terminal",
            queueDepth: 0,
            lastActivityAt: 2_000,
            pendingDecisionCount: 0,
            terminal: { status: "completed", at: 2_000 },
            freshness: { source: "disk", observedAt: 2_000, workerState: "reclaimed" },
          },
        ],
      }),
      worker: {
        hasLiveWorker: () => false,
        requestWorker: async () => ({ ok: false as const, message: "no worker" }),
      },
      launcher: {
        start: async () => ({ sessionId: launch.sessionId, cwd: "/work/app" }),
      },
      now: () => 3_000,
      onTaskClosed: async (task) => {
        closed.push(task.id);
      },
    });

    await recovered.start();

    expect(recoveredStore.get(launch.taskId)).toMatchObject({
      status: "completed",
      closureRecordedAt: 3_000,
    });
    expect(closed).toEqual([launch.taskId]);
    recovered.stop();
  });

  test("waits for a background notification instead of closing the task", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-background-wait",
      task: "Delegate the implementation and report its result",
      workspacePath: "/work/app",
    });

    h.tick(2_000);
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "turn_complete",
      reason: "completed",
      completionKind: "background_wait",
    });

    expect(h.store.get(launch.taskId)).toMatchObject({
      status: "interrupted",
      waitingFor: "The work session yielded until its background result notification arrives",
    });
    expect(h.closed).toEqual([]);
  });

  test("does not report a run-limit stop as ordinary completion", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-limit-stop",
      task: "Finish within the run budget",
      workspacePath: "/work/app",
    });

    h.tick(2_000);
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "turn_complete",
      reason: "completed",
      completionKind: "limit_stop",
    });

    expect(h.store.get(launch.taskId)).toMatchObject({
      status: "interrupted",
      waitingFor: "The work session reached its run limit before a final response",
    });
    expect(h.closed).toEqual([]);
  });

  test("continues and reports completion after an explicit Goal clear", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-goal-clear",
      task: "Finish the delegated implementation",
      goalObjective: "Finish the delegated implementation",
      workspacePath: "/work/app",
    });

    h.tick(2_000);
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "goal_cleared",
      goalId: "goal-1",
      revision: 2,
    });
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "turn_complete",
      reason: "completed",
      completionKind: "goal_control_stop",
    });
    expect(h.store.get(launch.taskId)).toMatchObject({
      status: "interrupted",
      verificationMode: "turn",
    });

    h.tick(3_000);
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "stream_request_start",
      turnNumber: 2,
    });
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "assistant_message",
      message: { role: "assistant", content: "The delegated work finished successfully." },
    });
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "turn_complete",
      reason: "completed",
    });

    expect(h.store.get(launch.taskId)).toMatchObject({
      status: "completed",
      summary: "The delegated work finished successfully.",
    });
    expect(h.closed).toEqual([{ id: launch.taskId, status: "completed" }]);
  });

  test("records Goal exhaustion as a retryable failure, never success", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-exhausted",
      task: "Finish within the continuation budget",
      goalObjective: "Finish within the continuation budget",
      workspacePath: "/work/app",
    });
    h.tick(2_000);
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "goal_progress",
      status: "exhausted",
      goalId: "goal-1",
      revision: 1,
    });
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "turn_complete",
      reason: "completed",
    });
    expect(h.store.get(launch.taskId)).toMatchObject({
      status: "failed",
      lastError: "The Goal continuation limit was exhausted before completion",
    });
    expect(h.closed).toEqual([{ id: launch.taskId, status: "failed" }]);
  });

  test("projects pending decisions into waiting state and resumes after resolution", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-wait",
      task: "Deploy the app",
      workspacePath: "/work/app",
    });
    h.projection.emit({
      kind: "pending-upsert",
      version: 2,
      generation: 1,
      observedAt: 2_000,
      pending: {
        agentSessionId: launch.sessionId,
        requestId: "request-1",
        workerGeneration: 1,
        kind: "tool_approval",
        title: "Approve deployment",
        createdAt: 2_000,
        status: "pending",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.store.get(launch.taskId)).toMatchObject({
      status: "waiting",
      waitingFor: "Approve deployment",
    });
    h.projection.emit({
      kind: "pending-remove",
      version: 3,
      generation: 1,
      observedAt: 2_100,
      sessionId: launch.sessionId,
      requestId: "request-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.store.get(launch.taskId)?.status).toBe("running");
  });

  test("supports explicit pause and resume with the same durable session", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-control",
      task: "Finish a long migration",
      goalObjective: "Finish a long migration",
      workspacePath: "/work/app",
    });
    const paused = await h.coordinator.control({ taskId: launch.taskId, action: "pause" });
    expect(paused.ok && paused.task.status).toBe("paused");
    const resumed = await h.coordinator.control({ taskId: launch.taskId, action: "resume" });
    expect(resumed.ok && resumed.task.status).toBe("running");
    expect(h.launches.at(-1)).toMatchObject({
      targetSessionId: launch.sessionId,
      goalObjective: "Finish a long migration",
    });
  });

  test("retries a failed task in the same Session and can cancel the new attempt", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-retry-cancel",
      task: "Finish a recoverable migration",
      goalObjective: "Finish a recoverable migration",
      workspacePath: "/work/app",
    });
    h.tick(2_000);
    await h.coordinator.observeSessionEvent(launch.sessionId, {
      type: "error",
      error: "temporary worker failure",
    });
    expect(h.store.get(launch.taskId)).toMatchObject({ status: "failed", attempt: 1 });

    const retried = await h.coordinator.control({ taskId: launch.taskId, action: "retry" });
    expect(retried.ok && retried.task).toMatchObject({ status: "running", attempt: 2 });
    expect(h.launches.at(-1)).toMatchObject({
      targetSessionId: launch.sessionId,
      goalObjective: "Finish a recoverable migration",
    });

    const cancelled = await h.coordinator.control({ taskId: launch.taskId, action: "cancel" });
    expect(cancelled.ok && cancelled.task).toMatchObject({ status: "cancelled", attempt: 2 });
    expect(h.closed).toEqual([
      { id: launch.taskId, status: "failed" },
      { id: launch.taskId, status: "cancelled" },
    ]);
  });

  test("persists core Goal pause and wakes it in place when the worker is live", async () => {
    const root = await mkdtemp(join(tmpdir(), "pet-long-task-live-goal-"));
    roots.push(root);
    const store = new PetLongTaskStore(join(root, "tasks.json"), () => 1_000);
    const projection = fakeProjection();
    const methods: string[] = [];
    let revision = 1;
    let paused = false;
    let launchCount = 0;
    const coordinator = new PetLongTaskCoordinator({
      store,
      projection,
      worker: {
        hasLiveWorker: () => true,
        requestWorker: async (method, params) => {
          methods.push(method);
          if (method === "agent/goalGet") {
            return {
              ok: true,
              result: {
                ok: true,
                goal: "Finish the live goal",
                goalId: "goal-1",
                revision,
                paused,
              },
            };
          }
          if (method === "agent/goalUpdate") {
            paused = params.paused === true;
            revision += 1;
            return { ok: true, result: { ok: true, updated: true, revision, paused } };
          }
          return { ok: true, result: { ok: true } };
        },
      },
      launcher: {
        start: async (delegation) => {
          launchCount += 1;
          return {
            sessionId:
              delegation.targetSessionId ?? petDelegationSessionId(delegation.clientMessageId),
            cwd: delegation.workspacePath ?? "/safe/no-repo",
          };
        },
      },
      now: () => 1_000,
    });
    await coordinator.start();
    const launch = await coordinator.startDelegation({
      clientMessageId: "message-live-goal",
      task: "Finish the live goal",
      goalObjective: "Finish the live goal",
      workspacePath: "/work/app",
    });
    expect((await coordinator.control({ taskId: launch.taskId, action: "pause" })).ok).toBe(true);
    expect(paused).toBe(true);
    expect((await coordinator.control({ taskId: launch.taskId, action: "resume" })).ok).toBe(true);
    expect(paused).toBe(false);
    expect(launchCount).toBe(1);
    expect(methods).toEqual([
      "agent/goalGet",
      "agent/goalUpdate",
      "agent/cancel",
      "agent/goalGet",
      "agent/goalUpdate",
    ]);
  });

  test("marks a formerly running durable task interrupted after process recovery", async () => {
    const h = await harness();
    const launch = await h.coordinator.startDelegation({
      clientMessageId: "message-recovery",
      task: "Finish overnight work",
      workspacePath: "/work/app",
    });
    await h.store.flush();
    h.coordinator.stop();

    const recoveredStore = new PetLongTaskStore(join(h.root, "tasks.json"), () => 5_000);
    const recovered = new PetLongTaskCoordinator({
      store: recoveredStore,
      projection: fakeProjection({
        ...emptySnapshot(),
        workerState: "reclaimed",
        observedAt: 5_000,
      }),
      worker: {
        hasLiveWorker: () => false,
        requestWorker: async () => ({ ok: false, message: "no worker" }),
      },
      launcher: { start: async () => ({ sessionId: launch.sessionId, cwd: "/work/app" }) },
      now: () => 5_000,
    });
    await recovered.start();
    expect(recoveredStore.get(launch.taskId)).toMatchObject({
      status: "interrupted",
      nextAction: "Resume from the durable work session",
    });
  });
});
