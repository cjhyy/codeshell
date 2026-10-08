import { expect, test } from "bun:test";
import { createTaskInboxApi } from "./task-inbox-api";

test("task inbox bridge forwards only typed messages and cleans up event subscription", async () => {
  const calls: unknown[][] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const ipc = {
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      return null;
    },
    on: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, listener);
      return ipc;
    },
    removeListener: (event: string, listener: (...args: any[]) => void) => {
      if (listeners.get(event) === listener) listeners.delete(event);
      return ipc;
    },
  };
  const api = createTaskInboxApi(ipc as any);
  await api.list({ source: "session", limit: 200 });
  await api.get("session:one");
  await api.act({ taskKey: "session:one", action: "cancel", expectedRevision: "r1" });
  expect(calls).toEqual([
    ["taskInbox:list", { source: "session", limit: 200 }],
    ["taskInbox:get", "session:one"],
    ["taskInbox:act", { taskKey: "session:one", action: "cancel", expectedRevision: "r1" }],
  ]);
  const versions: number[] = [];
  const off = api.onChanged((version) => versions.push(version));
  const emit = listeners.get("taskInbox:changed")!;
  emit({}, -1);
  emit({}, "5");
  emit({}, 2.2);
  emit({}, 5);
  expect(versions).toEqual([5]);
  off();
  expect(listeners.size).toBe(0);
});
