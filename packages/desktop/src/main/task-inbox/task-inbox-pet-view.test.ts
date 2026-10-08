import { expect, test } from "bun:test";
import { PetDispatchService } from "../pet/pet-dispatch-service.js";
import { taskInboxPetView } from "./task-inbox-pet-view.js";
import type { TaskInboxRecordV1, TaskInboxSnapshot } from "./task-inbox-types.js";

const record: TaskInboxRecordV1 = {
  schemaVersion: 1,
  taskKey: "session:work-a",
  source: "session",
  sourceId: "work-a",
  title: "Build task",
  status: "waiting",
  sessionId: "work-a",
  summary: "Needs input",
  artifacts: [{ kind: "internal", label: "secret", uri: "file:///private/task.log" }],
  capabilities: ["open", "cancel"],
  createdAt: 1,
  updatedAt: 2,
  sourceRevision: "r1",
};
const snapshot: TaskInboxSnapshot = { version: 3, records: [record], errors: [] };

test("Mimi discloses the same task keys while omitting private controller fields", () => {
  const view = taskInboxPetView(snapshot);
  expect(view.tasks.map((task) => task.taskKey)).toEqual(
    snapshot.records.map((task) => task.taskKey),
  );
  expect(view.tasks[0]).toMatchObject({
    title: record.title,
    status: record.status,
    sessionId: record.sessionId,
  });
  expect(view.tasks[0]).not.toHaveProperty("artifacts");
  expect(view.tasks[0]).not.toHaveProperty("capabilities");
  expect(view.tasks[0]).not.toHaveProperty("sourceRevision");
  const bounded = taskInboxPetView({
    ...snapshot,
    records: Array.from({ length: 120 }, (_, i) => ({ ...record, taskKey: `session:s${i}` })),
  });
  expect(bounded.tasks).toHaveLength(100);
  expect(bounded).toMatchObject({ total: 120, truncated: true });
});

function service(provider?: () => ReturnType<typeof taskInboxPetView>) {
  const calls: Record<string, unknown>[] = [];
  const instance = new PetDispatchService({
    metadata: { ensure: async () => ({ petSessionId: "pet-task-inbox" }) },
    aggregator: {
      getSnapshot: () => ({
        version: 1,
        generation: 1,
        observedAt: 2,
        workerState: "active",
        sessions: [],
        pending: [],
        workMemorySegments: [],
      }),
      resolveNavigation: async () => ({ status: "not-found" }),
    },
    taskInbox: provider,
    longTasks: { context: () => ({ active: [{ taskId: "ledger-fallback" }] }) },
    worker: {
      requestWorker: async (_method, params) => {
        calls.push(params);
        return { ok: true, result: { text: "ok" } };
      },
    },
    hostCwd: "/safe",
  });
  return { instance, calls };
}

test("Mimi status, pending query and manager prompt share the task-center view", async () => {
  const view = taskInboxPetView(snapshot);
  const { instance, calls } = service(() => view);
  expect(await instance.dispatch({ type: "get_global_status" })).toMatchObject({ taskInbox: view });
  expect(await instance.dispatch({ type: "list_pending" })).toMatchObject({ taskInbox: view });
  await instance.dispatch({
    type: "chat",
    message: "有哪些任务？",
    clientMessageId: "task-inbox-query",
  });
  const request = calls.find((call) => typeof call.petRuntimeContext === "string")!;
  expect(request).toBeDefined();
  const world = JSON.parse(request.petRuntimeContext as string);
  expect(world.taskInbox).toEqual(view);
  expect(world.longTasks.active[0].taskId).toBe("ledger-fallback");
});

test("projection failure falls back to the existing ledger without blocking Mimi", async () => {
  const { instance, calls } = service(() => {
    throw new Error("projection unavailable");
  });
  const status = await instance.dispatch({ type: "get_global_status" });
  expect(status.ok).toBe(true);
  expect(status).not.toHaveProperty("taskInbox");
  await instance.dispatch({
    type: "chat",
    message: "status",
    clientMessageId: "task-inbox-fallback",
  });
  const request = calls.find((call) => typeof call.petRuntimeContext === "string")!;
  expect(JSON.parse(request.petRuntimeContext as string).longTasks.active[0].taskId).toBe(
    "ledger-fallback",
  );
});
