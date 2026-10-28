import { expect, test } from "bun:test";
import { assertExternalSessionIdle, registerBackgroundWorkIpc } from "./background-work-ipc.js";

const job = {
  kind: "job" as const,
  jobId: "job-1",
  sourceSession: { sessionId: "owner" },
  startedAt: 123,
  status: "running",
  description: "task",
  canCancel: true,
  externalSessionId: "external-1",
  cli: "codex" as const,
};

test("background listing and cancellation require application frame and exact job attempt", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sender = { id: 1, mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  let cancelled = 0;
  registerBackgroundWorkIpc(
    { handle: (name: string, fn: any) => handlers.set(name, fn) } as any,
    () => [{ isDestroyed: () => false, webContents: sender }] as any,
    {
      available: () => true,
      list: async () => [job],
      cancel: async () => {
        cancelled++;
        return true;
      },
    },
  );
  const list = handlers.get("backgroundWork:list")!;
  const cancel = handlers.get("backgroundWork:cancelJob")!;
  await expect(list({ sender, senderFrame: {} }, "owner")).rejects.toThrow("application window");
  expect((await list(event, "owner")).items[0].sourceSession.current).toBe(true);
  expect((await list(event, "different")).items).toEqual([]);
  expect(await cancel(event, "different", "job-1", 123)).toEqual({ cancelled: false });
  expect(await cancel(event, "owner", "job-1", 124)).toEqual({ cancelled: false });
  expect(cancelled).toBe(0);
  expect(await cancel(event, "owner", "job-1", 123)).toEqual({ cancelled: true });
  expect(cancelled).toBe(1);
});

test("takeover blocks live, cancelling and unknown jobs; same-id other CLI and terminal are distinct", async () => {
  let status = "running";
  const host = {
    available: () => true,
    list: async () => [{ ...job, status }],
    cancel: async () => true,
  };
  for (status of ["running", "cancelling", "unknown"])
    await expect(assertExternalSessionIdle(host, "external-1", "codex")).rejects.toThrow(
      "background task",
    );
  await assertExternalSessionIdle(host, "external-1", "claude-code");
  for (status of ["completed", "failed", "cancelled"])
    await assertExternalSessionIdle(host, "external-1", "codex");
  await expect(
    assertExternalSessionIdle(
      {
        ...host,
        list: async () => {
          throw new Error("worker unavailable");
        },
      },
      "external-1",
      "codex",
    ),
  ).rejects.toThrow("worker unavailable");
});
