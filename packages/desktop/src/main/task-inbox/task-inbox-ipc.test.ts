import { describe, expect, test } from "bun:test";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  parseTaskInboxAction,
  parseTaskInboxListQuery,
  registerTaskInboxIpc,
  type TaskInboxIpcService,
} from "./task-inbox-ipc.js";
import type { TaskInboxSnapshot } from "./task-inbox-types.js";

function setup() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: unknown[] = [];
  const sender = {
    id: 42,
    mainFrame: {},
    isDestroyed: () => false,
    send: (...args: unknown[]) => sent.push(args),
  };
  let destroyed = false;
  const window = { webContents: sender, isDestroyed: () => destroyed } as unknown as BrowserWindow;
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent;
  let listener: ((snapshot: TaskInboxSnapshot) => void) | undefined;
  let reconciles = 0;
  const actions: unknown[] = [];
  const service: TaskInboxIpcService = {
    list: () => ({ version: 1, records: [], errors: [] }),
    get: () => undefined,
    reconcile: async () => {
      reconciles++;
      return { version: 1, records: [], errors: [] };
    },
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    act: async (...args) => {
      actions.push(args);
      return { status: "ok" };
    },
  };
  const ipc = {
    handle: (channel: string, handler: any) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const dispose = registerTaskInboxIpc(ipc, () => [window], service);
  return {
    handlers,
    event,
    sent,
    actions,
    dispose,
    reconciles: () => reconciles,
    destroy: () => {
      destroyed = true;
    },
    changed: () => listener?.({ version: 2, records: [], errors: [] }),
    subscribed: () => !!listener,
  };
}

describe("task inbox private IPC", () => {
  test("rejects guests, unknown senders and closed windows before reconciling", () => {
    const state = setup();
    const list = state.handlers.get("taskInbox:list")!;
    expect(() => list({ ...state.event, senderFrame: {} })).toThrow("application window");
    expect(() => list({ ...state.event, sender: {} })).toThrow("application window");
    state.destroy();
    expect(() => list(state.event)).toThrow("application window");
    expect(state.reconciles()).toBe(0);
    state.changed();
    expect(state.sent).toHaveLength(0);
  });

  test("reconnect reads reconcile first and events disclose only the version", async () => {
    const state = setup();
    expect(await state.handlers.get("taskInbox:list")!(state.event, { limit: 100 })).toEqual({
      version: 1,
      records: [],
      errors: [],
    });
    expect(state.reconciles()).toBe(1);
    expect(state.handlers.get("taskInbox:get")!(state.event, "session:s1")).toBeNull();
    state.changed();
    expect(state.sent).toEqual([["taskInbox:changed", 2]]);
    state.dispose();
    expect(state.handlers.size).toBe(0);
    expect(state.subscribed()).toBe(false);
  });

  test("only task key, revision, action and authenticated caller reach the router", async () => {
    const state = setup();
    const request = { taskKey: "session:s1", action: "cancel", expectedRevision: "r1" };
    await state.handlers.get("taskInbox:act")!(state.event, request);
    expect(state.actions).toEqual([[request, { webContentsId: 42 }]]);
    for (const extra of [{ sessionId: "victim" }, { cwd: "/tmp" }, { command: "sh" }]) {
      expect(() =>
        state.handlers.get("taskInbox:act")!(state.event, { ...request, ...extra }),
      ).toThrow("Invalid");
    }
    expect(state.actions).toHaveLength(1);
  });
});

test("query and action validation bound input and reject undeclared fields", () => {
  for (const input of [
    null,
    [],
    { source: "unknown" },
    { status: "completed" },
    { limit: 201 },
    { limit: 1.5 },
    { cursor: "\0" },
    { projectId: {} },
    { search: "a".repeat(513) },
    { cwd: "/tmp" },
  ]) {
    expect(() => parseTaskInboxListQuery(input)).toThrow();
  }
  expect(
    parseTaskInboxListQuery({ status: "waiting", source: "session", search: "", limit: 200 }),
  ).toEqual({ status: "waiting", source: "session", search: "", limit: 200 });
  for (const input of [
    {},
    { taskKey: "s", action: "delete", expectedRevision: "1" },
    { taskKey: "s", action: "cancel", expectedRevision: "" },
  ]) {
    expect(() => parseTaskInboxAction(input)).toThrow();
  }
});
