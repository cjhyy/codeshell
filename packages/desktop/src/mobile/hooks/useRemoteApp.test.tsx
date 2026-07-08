import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../../renderer/test-utils/renderHook";
import { useRemoteApp } from "./useRemoteApp";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

let visibilityState = "visible";
let restoreBrowserGlobals: (() => void) | undefined;

function defineTestProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  return () => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  };
}

function setupBrowser(): void {
  ensureMiniDom();
  restoreBrowserGlobals?.();
  FakeWebSocket.instances = [];
  const storage = new MemoryStorage();
  storage.setItem("cs.deviceId", "device-1");
  storage.setItem("cs.deviceSecret", "secret-1");
  storage.setItem("cs.deviceName", "Phone");

  const restores = [
    defineTestProperty(globalThis, "localStorage", { value: storage, writable: true }),
    defineTestProperty(globalThis, "WebSocket", { value: FakeWebSocket, writable: true }),
    defineTestProperty(window, "location", {
      value: { origin: "http://127.0.0.1:3000", search: "", pathname: "/mobile" },
      writable: true,
    }),
    defineTestProperty(window, "history", { value: { replaceState() {} }, writable: true }),
    defineTestProperty(document, "visibilityState", { get: () => visibilityState }),
  ];
  restoreBrowserGlobals = () => {
    for (const restore of restores.reverse()) restore();
  };
}

afterEach(() => {
  restoreBrowserGlobals?.();
  restoreBrowserGlobals = undefined;
  FakeWebSocket.instances = [];
  visibilityState = "visible";
});

describe("useRemoteApp session unread", () => {
  test("非当前 session 的 seq 前进标未读,切到该 session 后清除", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;

    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({
        type: "session.list.ok",
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "当前会话",
            cwd: "/repo",
            updatedAt: 1,
            origin: "desktop",
          },
          {
            id: "s2",
            title: "后台会话",
            cwd: "/repo",
            updatedAt: 2,
            origin: "desktop",
          },
        ],
      });
      await flushMicrotasks();
    });

    await act(async () => {
      hook.result.current.selectSession("s1");
      await flushMicrotasks();
    });
    expect(hook.result.current.unreadSessionIds.has("s2")).toBe(false);

    await act(async () => {
      ws.message({
        type: "session.stream",
        sessionId: "s2",
        seq: 1,
        event: { type: "text_delta", text: "新内容" },
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.unreadSessionIds.has("s2")).toBe(true);
    expect(hook.result.current.chat.items.some((item) => item.kind === "assistant")).toBe(false);

    await act(async () => {
      ws.message({
        type: "session.stream",
        sessionId: "s1",
        seq: 1,
        event: { type: "stream_request_start", turnNumber: 1 },
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.unreadSessionIds.has("s1")).toBe(false);
    expect(hook.result.current.chat.items.some((item) => item.kind === "assistant")).toBe(true);

    await act(async () => {
      hook.result.current.selectSession("s2");
      await flushMicrotasks();
    });
    expect(hook.result.current.unreadSessionIds.has("s2")).toBe(false);

    await hook.unmount();
  });

  test("后台 session 的 unread seq 不污染 appliedSeqRef,打开后 snapshot 仍可补回且去重", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;

    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({
        type: "session.list.ok",
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "当前会话",
            cwd: "/repo",
            updatedAt: 1,
            origin: "desktop",
          },
          {
            id: "s2",
            title: "后台会话",
            cwd: "/repo",
            updatedAt: 2,
            origin: "desktop",
          },
        ],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectSession("s1");
      await flushMicrotasks();
    });

    await act(async () => {
      ws.message({
        type: "session.stream",
        sessionId: "s2",
        seq: 1,
        event: { type: "stream_request_start", turnNumber: 1 },
      });
      ws.message({
        type: "session.stream",
        sessionId: "s2",
        seq: 2,
        event: { type: "text_delta", text: "后台内容" },
      });
      await flushMicrotasks();
    });

    expect(hook.result.current.unreadSessionIds.has("s2")).toBe(true);
    expect(
      hook.result.current.chat.items.some((item) => "text" in item && item.text === "后台内容"),
    ).toBe(false);

    await act(async () => {
      hook.result.current.selectSession("s2");
      await flushMicrotasks();
    });
    expect(hook.result.current.unreadSessionIds.has("s2")).toBe(false);
    expect(hook.result.current.chat.items).toEqual([]);

    const snapshot = {
      type: "session.snapshot",
      sessionId: "s2",
      entries: [
        { seq: 1, event: { type: "stream_request_start", turnNumber: 1 } },
        { seq: 2, event: { type: "text_delta", text: "后台内容" } },
        { seq: 3, event: { type: "turn_complete", reason: "completed" } },
      ],
      nextSeq: 4,
    };

    await act(async () => {
      ws.message(snapshot);
      await flushMicrotasks();
    });

    const firstReplay = hook.result.current.chat.items.filter((item) => item.kind === "assistant");
    expect(firstReplay).toHaveLength(1);
    expect(firstReplay[0]).toMatchObject({ text: "后台内容", done: true });

    await act(async () => {
      ws.message(snapshot);
      await flushMicrotasks();
    });

    const secondReplay = hook.result.current.chat.items.filter((item) => item.kind === "assistant");
    expect(secondReplay).toHaveLength(1);
    expect(secondReplay[0]).toMatchObject({ text: "后台内容", done: true });

    await hook.unmount();
  });
});

describe("useRemoteApp approval replay", () => {
  test("replayed raw approval after selecting its session hydrates and resolves the card", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;
    const approvalLine = {
      jsonrpc: "2.0",
      method: "agent/approvalRequest",
      params: {
        sessionId: "s2",
        requestId: "ask-1",
        request: {
          toolName: "AskUserQuestion",
          description: "Pick deployment target",
          args: {
            options: ["Staging", "Production"],
            optionsOnly: true,
          },
          riskLevel: "low",
        },
      },
    };

    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({
        type: "session.list.ok",
        activeSessionId: "s1",
        sessions: [
          { id: "s1", title: "Current", cwd: "/repo", updatedAt: 1, origin: "desktop" },
          { id: "s2", title: "Pending approval", cwd: "/repo", updatedAt: 2, origin: "desktop" },
        ],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectSession("s1");
      await flushMicrotasks();
    });

    await act(async () => {
      ws.message(approvalLine);
      await flushMicrotasks();
    });
    expect(hook.result.current.approvals).toEqual([]);

    await act(async () => {
      hook.result.current.selectSession("s2");
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message(approvalLine);
      await flushMicrotasks();
    });

    expect(hook.result.current.approvals).toHaveLength(1);
    expect(hook.result.current.approvals[0]).toMatchObject({
      requestId: "ask-1",
      sessionId: "s2",
      toolName: "AskUserQuestion",
      description: "Pick deployment target",
      summary: "Pick deployment target",
      risk: "low",
      options: ["Staging", "Production"],
      optionsOnly: true,
    });

    await act(async () => {
      ws.message({
        jsonrpc: "2.0",
        method: "agent/approvalResolved",
        params: { sessionId: "s2", requestId: "ask-1", approved: true },
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.approvals).toEqual([]);

    await hook.unmount();
  });
});
