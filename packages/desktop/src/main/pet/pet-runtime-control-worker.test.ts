import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import { ExternalRuntimeGoals } from "../external-runtime-goals.js";
import type { ExternalRuntimeService } from "../external-runtime-service.js";
import { PetLongTaskCoordinator } from "./pet-long-task-coordinator.js";
import { PetLongTaskStore } from "./pet-long-task-store.js";
import {
  createPetRuntimeControlWorker,
  type PetRuntimeControlWorker,
} from "./pet-runtime-control-worker.js";

const sessionId = "external-pet-control";
const requestOptions = { meta: { origin: "host" as const, producer: "fixture-pet-control" } };
type ControlService = Pick<
  ExternalRuntimeService,
  "hasSession" | "getGoal" | "updateGoal" | "deleteGoal" | "stop"
>;
let previousHome: string | undefined;
let testHome: string;
let goals: ExternalRuntimeGoals;

beforeEach(() => {
  previousHome = process.env.CODE_SHELL_HOME;
  testHome = mkdtempSync(join(tmpdir(), "codeshell-pet-runtime-controls-"));
  process.env.CODE_SHELL_HOME = testHome;
  new SessionManager().create("/tmp/project", "codex/test", "codex", sessionId, null, "desktop");
  goals = new ExternalRuntimeGoals(() => {});
  const run = goals.start(sessionId, "Finish the external task")!;
  goals.end(run);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

function harness() {
  let live = false;
  const nativeCalls: unknown[] = [];
  const updates: unknown[] = [];
  const stops: string[] = [];
  const deletes: unknown[] = [];
  const native: PetRuntimeControlWorker = {
    hasLiveWorker() {
      return false;
    },
    async requestWorker(...args) {
      nativeCalls.push(args);
      return { ok: false, message: "Native worker must not receive external controls" };
    },
  };
  const service: ControlService = {
    hasSession: () => live,
    getGoal: (id) => goals.get(id),
    updateGoal: async (id, patch) => {
      updates.push({ id, patch });
      return goals.update(id, patch);
    },
    deleteGoal: (id, expected) => {
      deletes.push({ id, expected });
      return goals.delete(id, expected);
    },
    stop: async (id) => {
      stops.push(id);
    },
  };
  const worker = createPetRuntimeControlWorker({
    worker: native,
    isExternal: (id) => id === sessionId,
    service: () => service,
  });
  return {
    worker,
    service,
    nativeCalls,
    updates,
    stops,
    deletes,
    setLive(value: boolean) {
      live = value;
    },
    request(method: string, params: Record<string, unknown> = {}) {
      return worker.requestWorker(method, { sessionId, ...params }, 5_000, requestOptions);
    },
  };
}

describe("Mimi runtime task controls", () => {
  test("preserves native worker receiver, parameters, timeout and metadata", async () => {
    const availability: unknown[][] = [];
    const calls: unknown[][] = [];
    const params = { sessionId: "native-session", paused: true };
    const native: PetRuntimeControlWorker = {
      hasLiveWorker(...args) {
        expect(this).toBe(native);
        availability.push(args);
        return true;
      },
      async requestWorker(...args) {
        expect(this).toBe(native);
        calls.push(args);
        return { ok: true, result: { native: true } };
      },
    };
    const worker = createPetRuntimeControlWorker({
      worker: native,
      isExternal: () => false,
      service: () => {
        throw new Error("Native calls must not read the external service");
      },
    });
    expect(worker.hasLiveWorker()).toBe(true);
    expect(worker.hasLiveWorker("native-session")).toBe(true);
    expect(availability).toEqual([[], ["native-session"]]);
    expect(await worker.requestWorker("agent/goalUpdate", params, 4321, requestOptions)).toEqual({
      ok: true,
      result: { native: true },
    });
    expect(calls).toEqual([["agent/goalUpdate", params, 4321, requestOptions]]);
    expect(calls[0]![1]).toBe(params);
    expect(calls[0]![3]).toBe(requestOptions);
  });

  test("routes cancel to external stop even without a native worker or warm runtime", async () => {
    const h = harness();
    expect(h.worker.hasLiveWorker()).toBe(false);
    expect(h.worker.hasLiveWorker(sessionId)).toBe(true);
    expect(await h.request("agent/cancel")).toEqual({ ok: true, result: { cancelled: true } });
    expect(h.stops).toEqual([sessionId]);
    expect(h.nativeCalls).toEqual([]);
  });

  test("reads, pauses, edits and clears the persisted external Goal", async () => {
    const h = harness();
    const initial = goals.get(sessionId);
    expect(await h.request("agent/goalGet")).toEqual({ ok: true, result: initial });
    const pause = {
      paused: true,
      expectedGoalId: initial.goalId,
      expectedRevision: initial.revision,
    };
    expect(await h.request("agent/goalUpdate", pause)).toMatchObject({
      ok: true,
      result: { updated: true, paused: true, revision: 2 },
    });
    expect(new ExternalRuntimeGoals(() => {}).get(sessionId)).toMatchObject({
      paused: true,
      revision: 2,
    });
    const edit = {
      objective: "  Verify the external task  ",
      expectedGoalId: initial.goalId,
      expectedRevision: 2,
    };
    expect(await h.request("agent/goalUpdate", edit)).toMatchObject({
      ok: true,
      result: { updated: true, goal: "Verify the external task", revision: 3 },
    });
    expect(h.updates).toEqual([
      { id: sessionId, patch: pause },
      { id: sessionId, patch: { ...edit, objective: "Verify the external task" } },
    ]);
    const expected = { expectedGoalId: initial.goalId, expectedRevision: 3 };
    expect(await h.request("agent/goalClear", expected)).toEqual({
      ok: true,
      result: { ok: true, cleared: true },
    });
    expect(h.deletes).toEqual([{ id: sessionId, expected }]);
    expect(new ExternalRuntimeGoals(() => {}).get(sessionId).goal).toBeNull();
    expect(h.nativeCalls).toEqual([]);
  });

  test("refuses stale Goal controls before calling the mutating service", async () => {
    const h = harness();
    const initial = goals.get(sessionId);
    goals.update(sessionId, {
      paused: true,
      expectedGoalId: initial.goalId!,
      expectedRevision: initial.revision!,
    });
    expect(
      await h.request("agent/goalUpdate", {
        objective: "Stale replacement",
        expectedGoalId: initial.goalId,
        expectedRevision: initial.revision,
      }),
    ).toMatchObject({ ok: true, result: { updated: false, revision: 2, paused: true } });
    expect(h.updates).toEqual([]);
    expect(goals.get(sessionId).goal).toBe("Finish the external task");
    expect(h.nativeCalls).toEqual([]);
  });

  test("passes the CAS fence through to persistence when the Goal changes after the read", async () => {
    const h = harness();
    const initial = goals.get(sessionId);
    h.service.updateGoal = async (id, patch) => {
      goals.update(id, {
        paused: true,
        expectedGoalId: initial.goalId!,
        expectedRevision: initial.revision!,
      });
      return goals.update(id, patch);
    };
    expect(
      await h.request("agent/goalUpdate", {
        objective: "Lost race",
        expectedGoalId: initial.goalId,
        expectedRevision: initial.revision,
      }),
    ).toMatchObject({ ok: true, result: { updated: false, revision: 2, paused: true } });
    expect(goals.get(sessionId).goal).toBe("Finish the external task");
    expect(h.nativeCalls).toEqual([]);
  });

  test("cold resume leaves the Goal paused for launcher recovery while warm resume updates it", async () => {
    const h = harness();
    const initial = goals.get(sessionId);
    goals.update(sessionId, {
      paused: true,
      expectedGoalId: initial.goalId!,
      expectedRevision: initial.revision!,
    });
    const resume = { paused: false, expectedGoalId: initial.goalId, expectedRevision: 2 };
    expect(await h.request("agent/goalUpdate", resume)).toMatchObject({
      ok: true,
      result: { updated: false, paused: true, revision: 2 },
    });
    expect(h.updates).toEqual([]);
    h.setLive(true);
    expect(await h.request("agent/goalUpdate", resume)).toMatchObject({
      ok: true,
      result: { updated: true, paused: false, revision: 3 },
    });
    expect(h.nativeCalls).toEqual([]);
  });

  test("unavailable services, unknown external methods and invalid updates never reach native", async () => {
    const h = harness();
    const unavailable = createPetRuntimeControlWorker({
      worker: h.worker,
      isExternal: () => true,
      service: () => null,
    });
    expect(unavailable.hasLiveWorker(sessionId)).toBe(false);
    expect(
      await unavailable.requestWorker("agent/cancel", { sessionId }, 1000, requestOptions),
    ).toMatchObject({ ok: false, message: expect.stringContaining("unavailable") });
    expect(await h.request("agent/unknownControl")).toMatchObject({
      ok: false,
      message: expect.stringContaining("does not support"),
    });
    const initial = goals.get(sessionId);
    for (const params of [
      { paused: true },
      { paused: "yes", expectedGoalId: initial.goalId, expectedRevision: 1 },
      { objective: "", expectedGoalId: initial.goalId, expectedRevision: 1 },
      { paused: true, expectedGoalId: initial.goalId, expectedRevision: 0 },
    ])
      expect(await h.request("agent/goalUpdate", params)).toMatchObject({ ok: false });
    expect(h.updates).toEqual([]);
    expect(h.nativeCalls).toEqual([]);
  });

  test("coordinator pauses and cancels external work and relaunches a cold Goal on resume", async () => {
    const h = harness();
    const store = new PetLongTaskStore(join(testHome, "pet-tasks.json"));
    const launches: Array<Record<string, unknown>> = [];
    const coordinator = new PetLongTaskCoordinator({
      store,
      worker: h.worker,
      projection: {
        getSnapshot: () => ({
          version: 1,
          generation: 1,
          workerState: "reclaimed",
          sessions: [],
          pending: [],
          observedAt: 1,
          workMemorySegments: [],
        }),
        subscribe: () => () => {},
      },
      launcher: {
        start: async (delegation) => {
          launches.push(delegation as unknown as Record<string, unknown>);
          return { sessionId, cwd: "/tmp/project" };
        },
      },
    });
    await coordinator.start();
    try {
      const launch = await coordinator.startDelegation({
        clientMessageId: "external-controls",
        targetSessionId: sessionId,
        task: "Finish the external task",
        goalObjective: "Finish the external task",
        workspacePath: "/tmp/project",
      });
      expect((await coordinator.control({ taskId: launch.taskId, action: "pause" })).ok).toBe(true);
      expect(goals.get(sessionId)).toMatchObject({ paused: true, revision: 2 });
      expect(h.stops).toEqual([sessionId]);
      expect((await coordinator.control({ taskId: launch.taskId, action: "resume" })).ok).toBe(
        true,
      );
      expect(launches).toHaveLength(2);
      expect(launches[1]).toMatchObject({
        targetSessionId: sessionId,
        redrive: true,
        goalObjective: "Finish the external task",
      });
      expect(h.updates).toHaveLength(1);
      expect((await coordinator.control({ taskId: launch.taskId, action: "cancel" })).ok).toBe(
        true,
      );
      expect(store.get(launch.taskId)?.status).toBe("cancelled");
      expect(h.stops).toEqual([sessionId, sessionId]);
      expect(goals.get(sessionId).goal).toBeNull();
      expect(h.nativeCalls).toEqual([]);
    } finally {
      coordinator.stop();
    }
  });
});
