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

const { useHubController } = await import("../../../../packages/web/app/useHubController.tsx");
test("confirmed: standalone Hub blocks independent sends for an optional asynchronous question on an idle session", async () => {
  setup();
  property(globalThis, "location", { protocol: "http:", host: "fixture.invalid" });
  property(window, "location", {
    origin: "http://fixture.invalid",
    href: "http://fixture.invalid/",
    search: "",
    pathname: "/",
  });
  const hook = await renderHook(() => useHubController({ hub: false }));
  cleanups.push(() => hook.unmount());
  const socket = Socket.instances[0];
  await act(async () => {
    socket.open();
    await flushMicrotasks();
  });
  const sessionId = hook.result.current.activeId;
  await act(async () => {
    socket.message({
      method: "agent/approvalRequest",
      params: {
        requestId: "optional",
        sessionId,
        request: {
          toolName: "__ask_user__",
          args: { question: "optional preference?", asynchronous: true },
          description: "optional preference?",
        },
      },
    });
    socket.message({
      method: "agent/streamEvent",
      params: { sessionId, event: { type: "turn_complete", reason: "completed" } },
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.chat.run).toBe("completed");
  expect(hook.result.current.approvals).toHaveLength(1);
  await act(async () => {
    hook.result.current.setDraft("next independent task");
    await flushMicrotasks();
  });
  expect(hook.result.current.running).toBe(true);
  expect(hook.result.current.send()).toBe(false);
  expect(socket.sent.some((x) => x.method === "agent/run")).toBe(false);
});
