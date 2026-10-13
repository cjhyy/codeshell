import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import {
  ensureMiniDom,
  flushMicrotasks,
  renderHook,
} from "../../../../packages/web/src/test-utils/renderHook.tsx";
import { useRemoteApp } from "../../../../packages/web/src/hooks/useRemoteApp.ts";
import { useDesktopController } from "../../../../packages/web/app/DesktopApp.tsx";

class MemoryStorage {
  values = new Map<string, string>([
    ["cs.deviceId", "device"],
    ["cs.deviceSecret", "secret"],
    ["cs.deviceName", "Fixture"],
  ]);
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
const cleanups: Array<() => void | Promise<void>> = [];
function property(target: object, name: string, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
  cleanups.push(() => {
    if (old) Object.defineProperty(target, name, old);
    else Reflect.deleteProperty(target, name);
  });
}
function setup() {
  ensureMiniDom();
  Socket.instances = [];
  property(globalThis, "WebSocket", Socket);
  property(globalThis, "localStorage", new MemoryStorage());
  property(window, "location", {
    origin: "http://fixture.invalid",
    search: "",
    pathname: "/mobile/",
  });
  property(window, "history", { replaceState() {} });
  property(globalThis, "fetch", async () => {
    throw new Error("Network disabled for review fixture");
  });
  property(window, "fetch", globalThis.fetch);
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function connect(useController = false) {
  const hook = await renderHook(() => {
    const app = useRemoteApp();
    const controller = useController ? useDesktopController(app, undefined, () => {}) : undefined;
    return { app, controller };
  });
  cleanups.push(() => hook.unmount());
  const socket = Socket.instances.at(-1)!;
  await act(async () => {
    socket.open();
    socket.message({ type: "auth.ok", device: { id: "device", name: "Fixture" } });
    await flushMicrotasks();
  });
  await act(async () => {
    hook.result.current.app.selectSession("native");
    await flushMicrotasks();
  });
  return { hook, socket };
}
const room = {
  id: "cc-room",
  cwd: "/fixture",
  name: "CLI A",
  open: true,
  kind: "claude-code",
  permissionMode: "default",
  createdAt: 1,
  lastActiveAt: 1,
};
test("confirmed: an unrequested device-scoped CLI-open response navigates another tab", async () => {
  setup();
  const a = await connect();
  const b = await connect();
  await act(async () => {
    a.hook.result.current.app.openCcSession("cli-a", "/fixture", "default");
    await flushMicrotasks();
  });
  expect(b.socket.sent.some((x) => x.type === "ccRoom.openSession")).toBe(false);
  await act(async () => {
    for (const socket of [a.socket, b.socket]) {
      socket.message({ type: "room.list.ok", rooms: [room] });
      socket.message({
        type: "ccRoom.opened",
        roomId: "cc-room",
        sessionId: "cli-a",
        status: "running",
      });
    }
    await flushMicrotasks();
  });
  expect(b.hook.result.current.app.activeRoom?.id).toBe("cc-room");
  expect(b.socket.sent).toContainEqual({ type: "room.history", roomId: "cc-room", sinceSeq: 0 });
});
test("confirmed: a delayed CLI-open response replaces an explicit later native selection", async () => {
  setup();
  const { hook, socket } = await connect();
  await act(async () => {
    hook.result.current.app.openCcSession("cli-a", "/fixture", "default");
    await flushMicrotasks();
  });
  await act(async () => {
    hook.result.current.app.selectSession("newer-native");
    await flushMicrotasks();
  });
  expect(hook.result.current.app.activeSessionId).toBe("newer-native");
  await act(async () => {
    socket.message({ type: "room.list.ok", rooms: [room] });
    socket.message({
      type: "ccRoom.opened",
      roomId: "cc-room",
      sessionId: "cli-a",
      status: "running",
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.app.activeRoom?.id).toBe("cc-room");
});
test("confirmed: lost ACK after completed work restores a resendable draft with a different intent ID", async () => {
  setup();
  const { hook, socket } = await connect(true);
  await act(async () => {
    hook.result.current.controller!.setDraft("execute task once");
    await flushMicrotasks();
  });
  await act(async () => {
    expect(hook.result.current.controller!.send()).toBe(true);
    await flushMicrotasks();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await flushMicrotasks();
  });
  const first = socket.sent.find((x) => x.type === "chat.send");
  expect(first).toBeDefined();
  await act(async () => {
    for (const event of [
      { type: "stream_request_start", turnNumber: 1 },
      { type: "text_delta", text: "completed work" },
      { type: "turn_complete", reason: "completed" },
    ])
      socket.message({ method: "agent/streamEvent", params: { sessionId: "native", event } });
    await flushMicrotasks();
  });
  expect(hook.result.current.app.chat.run).toBe("completed");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15030));
    await flushMicrotasks();
  });
  expect(hook.result.current.controller!.draft).toBe("execute task once");
  expect(hook.result.current.controller!.uncertain).toBe(false);
  await act(async () => {
    expect(hook.result.current.controller!.send()).toBe(true);
    await flushMicrotasks();
  });
  const sends = socket.sent.filter((x) => x.type === "chat.send");
  expect(sends).toHaveLength(2);
  expect(sends[1].clientMessageId).not.toBe(sends[0].clientMessageId);
  await act(async () => {
    socket.message({
      type: "chat.accepted",
      sessionId: "native",
      clientMessageId: sends[1].clientMessageId,
      cwd: null,
    });
    await flushMicrotasks();
  });
});
test("confirmed: definite synchronous approval rejection leaves its pending card absent", async () => {
  setup();
  const { hook, socket } = await connect();
  await act(async () => {
    socket.message({
      method: "agent/approvalRequest",
      params: {
        requestId: "approve-1",
        sessionId: "native",
        request: { toolName: "Bash", args: { command: "fixture" }, description: "Fixture request" },
      },
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.app.approvals).toHaveLength(1);
  await act(async () => {
    hook.result.current.app.respondApproval("approve-1", "approve");
    await flushMicrotasks();
  });
  await act(async () => {
    socket.message({ type: "error", approvalId: "approve-1", message: "worker did not respond" });
    await flushMicrotasks();
  });
  expect(hook.result.current.app.approvals).toHaveLength(0);
  expect(hook.result.current.app.notice).toBe("worker did not respond");
});
