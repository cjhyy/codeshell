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

function setupBrowser(): void {
  ensureMiniDom();
  FakeWebSocket.instances = [];
  const storage = new MemoryStorage();
  storage.setItem("cs.deviceId", "device-1");
  storage.setItem("cs.deviceSecret", "secret-1");
  storage.setItem("cs.deviceName", "Phone");

  Object.assign(globalThis, {
    localStorage: storage,
    WebSocket: FakeWebSocket,
  });
  Object.assign(window, {
    location: { origin: "http://127.0.0.1:3000", search: "", pathname: "/mobile" },
    history: { replaceState() {} },
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
}

afterEach(() => {
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
