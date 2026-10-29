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
    [{ isDestroyed: () => false, webContents: sender }] as any,
    () => null,
    {
      host: {
        available: () => true,
        list: async () => [job],
        cancel: async () => {
          cancelled++;
          return true;
        },
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

test("marking a task ended requires the exact attempt and a status no live process reports", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sender = { id: 1, mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  let listed: Record<string, unknown> = { ...job, status: "unknown", canCancel: false };
  const marks: unknown[] = [];
  registerBackgroundWorkIpc(
    { handle: (name: string, fn: any) => handlers.set(name, fn) } as any,
    [{ isDestroyed: () => false, webContents: sender }] as any,
    () => null,
    {
      host: { available: () => true, list: async () => [listed as any], cancel: async () => true },
      markInterrupted: (input) => {
        marks.push(input);
        return true;
      },
    },
  );
  const mark = handlers.get("backgroundWork:markInterrupted")!;
  await expect(mark({ sender, senderFrame: {} }, "owner", "job-1", 123)).rejects.toThrow(
    "application window",
  );
  expect(await mark(event, "different", "job-1", 123)).toEqual({ marked: false });
  expect(await mark(event, "owner", "job-1", 124)).toEqual({ marked: false });
  expect(marks).toEqual([]);
  expect(await mark(event, "owner", "job-1", 123)).toEqual({ marked: true });
  expect(marks).toEqual([{ sessionId: "owner", jobId: "job-1", expectedStartedAt: 123 }]);
  listed = { ...job, status: "running" };
  expect(await mark(event, "owner", "job-1", 123)).toEqual({ marked: false });
  expect(marks).toHaveLength(1);
});

test("takeover is refused for any active owner and explains orphaned or foreign owners", () => {
  let owner:
    | { jobId: string; sessionId: string; unknownReason?: "other-process" | "orphaned-process" }
    | undefined;
  const calls: unknown[][] = [];
  const find = (...args: [any, string]) => {
    calls.push(args);
    return owner;
  };
  assertExternalSessionIdle("external-1", "codex", find);
  assertExternalSessionIdle("external-1", "claude-code", find);
  expect(calls).toEqual([
    ["codex", "external-1"],
    ["claude", "external-1"],
  ]);
  owner = { jobId: "job-1", sessionId: "owner" };
  expect(() => assertExternalSessionIdle("external-1", "codex", find)).toThrow("background task");
  owner = { ...owner, unknownReason: "orphaned-process" };
  expect(() => assertExternalSessionIdle("external-1", "codex", find)).toThrow("still running");
  owner = { ...owner, unknownReason: "other-process" };
  expect(() => assertExternalSessionIdle("external-1", "codex", find)).toThrow(
    "another CodeShell process",
  );
  expect(() => assertExternalSessionIdle(42, "codex", find)).toThrow("Invalid");
  expect(() => assertExternalSessionIdle("external-1", "cursor", find)).toThrow("Invalid");
});
