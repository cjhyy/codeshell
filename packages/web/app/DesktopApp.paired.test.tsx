import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../src/test-utils/renderHook.js";
import { useRemoteApp } from "../src/hooks/useRemoteApp.js";
import { useDesktopController } from "./DesktopApp.js";

// The real paired hook and Desktop controller over a scripted WebSocket.
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: Array<Record<string, any>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const restores: Array<() => void> = [];
function define(target: object, key: PropertyKey, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  FakeWebSocket.instances = [];
});

async function pairedController() {
  ensureMiniDom();
  FakeWebSocket.instances = [];
  const values = new Map([
    ["cs.deviceId", "device-1"],
    ["cs.deviceSecret", "secret-1"],
    ["cs.deviceName", "Phone"],
  ]);
  define(globalThis, "localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  define(globalThis, "WebSocket", FakeWebSocket);
  define(window, "location", {
    origin: "http://127.0.0.1:3000",
    search: "",
    pathname: "/mobile",
  });
  define(window, "history", { replaceState() {} });
  define(window, "fetch", async () => {
    throw new Error("paired send tests make no HTTP requests");
  });
  const hook = await renderHook(() => {
    const app = useRemoteApp();
    return { app, controller: useDesktopController(app, undefined, () => {}) };
  });
  const online = async () => {
    const ws = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    return ws;
  };
  const ws = await online();
  await act(async () => {
    hook.result.current.app.selectSession("native");
    await flushMicrotasks();
  });
  return { hook, ws, online };
}

const chatSends = (ws: FakeWebSocket) => ws.sent.filter((frame) => frame.type === "chat.send");

test("a retry after a lost acceptance reuses the original intent ID", async () => {
  const { hook, ws, online } = await pairedController();
  try {
    await act(async () => {
      hook.result.current.controller.setDraft("execute task once");
    });
    await act(async () => {
      expect(hook.result.current.controller.send()).toBe(true);
      await flushMicrotasks();
    });
    const first = chatSends(ws)[0]!;
    // The host may have queued the task; the connection drops before chat.accepted.
    await act(async () => {
      ws.close();
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(hook.result.current.controller.draft).toBe("execute task once");
    expect(hook.result.current.controller.uncertain).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const reconnected = await online();
    expect(reconnected).not.toBe(ws);
    await act(async () => {
      expect(hook.result.current.controller.send()).toBe(true);
      await flushMicrotasks();
    });
    expect(chatSends(reconnected)[0]!.clientMessageId).toBe(first.clientMessageId);
  } finally {
    await hook.unmount();
  }
});

test("a recovered record of the unconfirmed message clears its duplicate draft", async () => {
  const { hook, ws, online } = await pairedController();
  try {
    await act(async () => {
      hook.result.current.controller.setDraft("execute task once");
    });
    await act(async () => {
      hook.result.current.controller.send();
      await flushMicrotasks();
    });
    const first = chatSends(ws)[0]!;
    await act(async () => {
      ws.close();
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const reconnected = await online();
    await act(async () => {
      reconnected.message({
        method: "agent/streamEvent",
        params: {
          sessionId: "native",
          event: {
            type: "session_user_message",
            text: "execute task once",
            clientMessageId: first.clientMessageId,
          },
        },
      });
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(hook.result.current.controller.uncertain).toBe(false);
    expect(hook.result.current.controller.draft).toBe("");
  } finally {
    await hook.unmount();
  }
});

test("an explicit rejection keeps the task and a follow-up typed meanwhile", async () => {
  const { hook, ws } = await pairedController();
  try {
    await act(async () => {
      hook.result.current.controller.setDraft("Original long task");
    });
    await act(async () => {
      hook.result.current.controller.send();
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.controller.setDraft("Follow-up question");
    });
    const sent = chatSends(ws)[0]!;
    await act(async () => {
      ws.message({
        type: "error",
        message: "Configuration is being updated",
        clientMessageId: sent.clientMessageId,
      });
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(hook.result.current.controller.draft).toBe("Original long task\n\nFollow-up question");
    expect(hook.result.current.controller.uncertain).toBe(false);
    expect(hook.result.current.controller.error).toContain("之后输入的内容也已保留");
  } finally {
    await hook.unmount();
  }
});

test("background output before a new session is confirmed cannot take its draft", async () => {
  const { hook, ws } = await pairedController();
  try {
    await act(async () => {
      hook.result.current.controller.newSession();
      await flushMicrotasks();
    });
    const creation = ws.sent.find((frame) => frame.type === "session.create")!;
    await act(async () => {
      hook.result.current.controller.setDraft("task for the new session");
    });
    await act(async () => {
      ws.message({
        type: "session.stream",
        sessionId: "unrelated-background",
        seq: 1,
        event: { type: "text_delta", text: "other task output" },
      });
      ws.message({
        method: "agent/streamEvent",
        params: { sessionId: "unrelated-background", event: { type: "text_delta", text: "raw" } },
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.app.activeSessionId).toBeUndefined();
    expect(hook.result.current.controller.draft).toBe("task for the new session");
    await act(async () => {
      ws.message({
        type: "chat.accepted",
        clientRequestId: creation.clientRequestId,
        sessionId: "actually-created",
        cwd: null,
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.controller.activeId).toBe("actually-created");
    expect(hook.result.current.controller.draft).toBe("task for the new session");
    expect(hook.result.current.app.unreadSessionIds.has("unrelated-background")).toBe(true);
  } finally {
    await hook.unmount();
  }
});
