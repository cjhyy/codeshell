import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../../renderer/test-utils/renderHook";
import { useRemoteSocket, type ResyncReason } from "./useRemoteSocket";

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

describe("useRemoteSocket resync", () => {
  test("send reports failure unless the same authenticated connection generation is open", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteSocket({}));
    const first = FakeWebSocket.instances[0]!;

    expect(hook.result.current.send({ type: "session.list" })).toBe(false);
    await act(async () => {
      first.open();
      await flushMicrotasks();
    });
    expect(hook.result.current.send({ type: "session.list" })).toBe(false);
    await act(async () => {
      first.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    const firstGeneration = hook.result.current.connectionGeneration;
    expect(firstGeneration).toBeGreaterThan(0);
    expect(hook.result.current.send({ type: "session.list" }, firstGeneration)).toBe(true);

    await act(async () => {
      first.close();
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });
    const second = FakeWebSocket.instances[1]!;
    await act(async () => {
      second.open();
      second.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });

    expect(hook.result.current.connectionGeneration).toBeGreaterThan(firstGeneration);
    expect(hook.result.current.send({ type: "session.list" }, firstGeneration)).toBe(false);
    expect(
      hook.result.current.send({ type: "session.list" }, hook.result.current.connectionGeneration),
    ).toBe(true);
    await hook.unmount();
  });

  test("visible/focus/pageshow resync an already-open authenticated socket", async () => {
    setupBrowser();
    const resyncs: ResyncReason[] = [];
    const hook = await renderHook(() =>
      useRemoteSocket({
        onResyncNeeded: (reason) => resyncs.push(reason),
      }),
    );

    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: "auth.device", deviceId: "device-1" });

    await act(async () => {
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("online");
    expect(resyncs).toEqual(["online"]);

    visibilityState = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
      await flushMicrotasks();
    });

    expect(resyncs).toEqual(["online", "visible", "focus", "pageshow"]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await hook.unmount();
  });
});
