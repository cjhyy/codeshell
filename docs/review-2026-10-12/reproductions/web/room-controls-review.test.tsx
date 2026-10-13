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

test("confirmed: active CLI-room Stop routes to native cancel instead of the room", async () => {
  setup();
  const { hook, socket } = await connect(true);
  await act(async () => {
    hook.result.current.app.openCcSession("cli-a", "/fixture", "bypassPermissions");
    socket.message({
      type: "room.list.ok",
      rooms: [{ ...room, permissionMode: "bypassPermissions" }],
    });
    socket.message({
      type: "ccRoom.opened",
      roomId: "cc-room",
      sessionId: "cli-a",
      status: "running",
    });
    await flushMicrotasks();
  });
  await act(async () => {
    socket.message({
      type: "ccRoom.transcriptSubscribed",
      roomId: "cc-room",
      sessionId: "cli-a",
      roomCursor: 0,
      messages: [],
    });
    socket.message({
      type: "room.message",
      roomId: "cc-room",
      msg: {
        seq: 1,
        from: "agent",
        type: "tool",
        tool: "Bash",
        toolId: "room-tool",
        summary: "long work",
      },
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.controller!.running).toBe(true);
  await act(async () => {
    hook.result.current.controller!.stop();
    await flushMicrotasks();
  });
  const frame = socket.sent.at(-1);
  expect(frame).toEqual({ type: "run.stop" });
  expect(frame.roomId).toBeUndefined();
  const { handleClientEvent } =
    await import("../../../../packages/desktop/src/main/mobile-remote/handle-client-event.ts");
  const { MobileExternalRuntimeCommands } =
    await import("../../../../packages/desktop/src/main/mobile-remote/external-runtime-commands.ts");
  const responses: any[] = [];
  const nativeCancels: any[] = [];
  let stoppedRoom = false;
  const commands = new MobileExternalRuntimeCommands({
    authenticated: () => true,
    authority: async () => ({ stamp: "native", cwd: "/fixture", assertCurrent() {} }),
    owner: () => 1,
    service: () => null,
    isExternal: () => false,
    exists: () => true,
    attachmentPath: async (path) => path,
  });
  await commands.observe({
    type: "session.select",
    sessionId: "native",
    deviceId: "device",
    viewerId: "viewer",
  });
  await commands.observe({
    type: "ccRoom.openSession",
    sessionId: "cli-a",
    cwd: "/fixture",
    mode: "bypassPermissions",
    deviceId: "device",
    viewerId: "viewer",
  });
  const context = {
    externalCommands: commands,
    getBridge: () => ({
      getLastRunContext: () => ({ sessionId: "native" }),
      injectWorkerMessage: (line: string) => nativeCancels.push(JSON.parse(line)),
    }),
    deviceState: () => ({ selectedSessionId: "native" }),
    remote: { sendToViewer: (_id: string, message: any) => responses.push(message) },
    roomManager: {
      close: () => {
        stoppedRoom = true;
      },
    },
  } as any;
  await handleClientEvent(context, { ...frame, deviceId: "device", viewerId: "viewer" });
  expect(stoppedRoom).toBe(false);
  expect(nativeCancels).toEqual([]);
  expect(responses).toContainEqual({
    type: "error",
    message: "External cancel authority unavailable",
  });
});
test("confirmed: active CLI-room permission selector reports default while CLI remains bypass", async () => {
  setup();
  const { hook, socket } = await connect(true);
  await act(async () => {
    hook.result.current.app.openCcSession("cli-a", "/fixture", "bypassPermissions");
    socket.message({
      type: "room.list.ok",
      rooms: [{ ...room, permissionMode: "bypassPermissions" }],
    });
    socket.message({
      type: "ccRoom.opened",
      roomId: "cc-room",
      sessionId: "cli-a",
      status: "running",
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.app.activeRoom?.permissionMode).toBe("bypassPermissions");
  expect(hook.result.current.app.permissionMode).toBe("default");
  await act(async () => {
    hook.result.current.app.setPermissionMode("acceptEdits");
    await flushMicrotasks();
  });
  await act(async () => {
    hook.result.current.app.setPermissionMode("default");
    await flushMicrotasks();
  });
  expect(socket.sent.filter((x) => x.type === "permission.setMode").at(-1)).toEqual({
    type: "permission.setMode",
    mode: "default",
  });
  await act(async () => {
    socket.message({
      type: "error",
      message: "External approval/model/Goal controls require the Desktop owner",
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.app.permissionMode).toBe("default");
  expect(hook.result.current.app.activeRoom?.permissionMode).toBe("bypassPermissions");
});
test("confirmed: an optional asynchronous question blocks unrelated followup messages after work completes", async () => {
  setup();
  const { hook, socket } = await connect(true);
  await act(async () => {
    socket.message({
      method: "agent/approvalRequest",
      params: {
        requestId: "optional",
        sessionId: "native",
        request: {
          toolName: "__ask_user__",
          args: { question: "optional preference?", asynchronous: true },
          description: "optional preference?",
        },
      },
    });
    socket.message({
      method: "agent/streamEvent",
      params: { sessionId: "native", event: { type: "turn_complete", reason: "completed" } },
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.app.chat.run).toBe("completed");
  expect(hook.result.current.app.approvals[0].asynchronous).toBe(true);
  await act(async () => {
    hook.result.current.controller!.setDraft("next independent task");
    await flushMicrotasks();
  });
  expect(hook.result.current.controller!.running).toBe(true);
  expect(hook.result.current.controller!.send()).toBe(false);
  expect(socket.sent.some((x) => x.type === "chat.send")).toBe(false);
});
