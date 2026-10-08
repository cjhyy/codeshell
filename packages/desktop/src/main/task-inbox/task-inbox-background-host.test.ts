import { expect, test } from "bun:test";
import { createTaskInboxBackgroundHost } from "./task-inbox-background-host.js";

const shell = {
  kind: "shell" as const,
  sourceSession: { sessionId: "session-owner" },
  canCancel: true,
  shell: {
    shellId: "shell-same-id",
    sessionId: "session-owner",
    command: "test",
    cwd: "/tmp",
    status: "running",
    startedAt: 123,
    exitCode: null,
  },
};

test("worker and main registry entries keep separate cancellation authority even with identical IDs", async () => {
  const workerCalls: Array<{ method: string; params: unknown; options: unknown }> = [];
  const mainCalls: unknown[] = [];
  const host = createTaskInboxBackgroundHost({
    readMain: () => [shell] as any,
    cancelMain: async (params) => {
      mainCalls.push(params);
      return true;
    },
    worker: () =>
      ({
        hasLiveWorker: () => true,
        requestWorker: async (
          method: string,
          params: unknown,
          _timeout: unknown,
          options: unknown,
        ) => {
          workerCalls.push({ method, params, options });
          return {
            ok: true,
            result: method === "agent/backgroundWork" ? { items: [shell] } : { cancelled: true },
          };
        },
      }) as any,
  });
  const records = await host.list();
  expect(records.map((row) => row.executionOrigin)).toEqual(["main", "worker"]);
  expect(await host.cancel(records[0])).toBe(true);
  expect(mainCalls).toEqual([
    { sessionId: "session-owner", kind: "shell", workId: "shell-same-id", expectedStartedAt: 123 },
  ]);
  expect(workerCalls).toHaveLength(1);
  expect(await host.cancel(records[1])).toBe(true);
  expect(workerCalls[1]).toMatchObject({
    method: "agent/backgroundWorkCancel",
    params: mainCalls[0],
    options: { meta: { origin: "host", producer: "task-inbox" } },
  });
  expect(await host.cancel(shell)).toBe(false);
});

test("main registry remains visible without a worker and worker read failure is surfaced for stale preservation", async () => {
  const host = createTaskInboxBackgroundHost({
    worker: () => null,
    readMain: () => [shell] as any,
  });
  expect(await host.list()).toMatchObject([
    { executionOrigin: "main", sourceSession: { sessionId: "session-owner" } },
  ]);
  const failing = createTaskInboxBackgroundHost({
    readMain: () => [shell] as any,
    worker: () =>
      ({
        hasLiveWorker: () => true,
        requestWorker: async () => ({ ok: false, message: "Worker disconnected" }),
      }) as any,
  });
  await expect(failing.list()).rejects.toThrow("Worker disconnected");
});
