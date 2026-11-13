import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { useRemoteSocket, type ResyncReason } from "./useRemoteSocket";
import { remoteDeviceCredential } from "../lib/accountRelaySession.js";

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
  onclose: ((event?: { code: number }) => void) | null = null;
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
    defineTestProperty(globalThis, "fetch", {
      value: async () => Response.json({ active: false }),
      writable: true,
    }),
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
  test("an account browser uses an in-memory grant without replacing its legacy pairing", async () => {
    setupBrowser();
    window.location.origin = "https://computer.fixture.test";
    const calls: string[] = [];
    const credential = { deviceId: "account-browser", secretHash: "a".repeat(43) };
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return Response.json({
        active: true,
        ...credential,
        expiresAt: Date.now() + 60_000,
        accountEntryUrl: "https://account.test/app",
      });
    }) as typeof fetch;
    window.location.search = "?pairing=old-token";
    const hook = await renderHook(() => useRemoteSocket({}));
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });
    expect(ws.sent.map((line) => JSON.parse(line))).toEqual([
      { type: "auth.device", ...credential },
    ]);
    expect(remoteDeviceCredential()).toEqual(credential);
    expect(localStorage.getItem("cs.deviceId")).toBe("device-1");
    expect(localStorage.getItem("cs.deviceSecret")).toBe("secret-1");
    await act(async () => {
      ws.message({ type: "auth.ok", device: { id: credential.deviceId, name: "Account" } });
      ws.onclose?.({ code: 4407 });
      await flushMicrotasks();
    });
    expect(hook.result.current.accountAccessRequired).toBe(true);
    expect(hook.result.current.accountEntryUrl).toBe("https://account.test/app");
    await act(async () => {
      hook.result.current.logout();
      await flushMicrotasks();
    });
    expect(calls).toEqual(["/api/v1/relay/session", "/api/v1/relay/session/logout"]);
    expect(localStorage.getItem("cs.deviceId")).toBe("device-1");
    await hook.unmount();
  });

  test.each([200, 401])(
    "a missing or expired account cookie requests Passkey again without durable-pairing fallback (%s)",
    async (status) => {
      setupBrowser();
      window.location.origin = "https://computer.fixture.test";
      globalThis.fetch = (async () =>
        Response.json(
          { active: false, accountRelay: true, accountEntryUrl: "https://account.test/app" },
          { status },
        )) as typeof fetch;
      const hook = await renderHook(() => useRemoteSocket({}));
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(hook.result.current.accessRequired).toBe(true);
      expect(hook.result.current.accountAccessRequired).toBe(true);
      expect(localStorage.getItem("cs.deviceId")).toBe("device-1");
      await hook.unmount();
    },
  );

  test("a paired browser authenticates without consuming a bookmarked pairing link", async () => {
    setupBrowser();
    window.location.search = "?pairing=expired-test-token&view=panels";
    const replaced: string[] = [];
    window.history.replaceState = (_data, _unused, url) => replaced.push(String(url));
    const hook = await renderHook(() => useRemoteSocket({}));
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });
    expect(ws.sent.map((line) => JSON.parse(line).type)).toEqual(["auth.device"]);
    await act(async () => {
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("online");
    expect(replaced).toEqual(["/mobile?view=panels"]);
    expect(localStorage.getItem("cs.deviceId")).toBe("device-1");
    expect(ws.sent.some((line) => JSON.parse(line).type === "pair.complete")).toBe(false);
    await hook.unmount();
  });

  test("a fresh pairing link can replace a revoked stored device exactly once", async () => {
    setupBrowser();
    window.location.search = "?pairing=fresh-test-token";
    const hook = await renderHook(() => useRemoteSocket({}));
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      ws.message({ type: "auth.failed", message: "Device is not trusted" });
      await flushMicrotasks();
    });
    expect(ws.sent.map((line) => JSON.parse(line).type)).toEqual(["auth.device", "pair.complete"]);
    expect(hook.result.current.status).toBe("authenticating");
    expect(localStorage.getItem("cs.deviceId")).toBeNull();
    expect(hook.result.current.send({ type: "chat.send", text: "must remain unsent" })).toBe(false);
    await act(async () => {
      ws.message({ type: "pair.ok", device: { id: "replacement-device", name: "Phone" } });
      ws.message({ type: "auth.ok", device: { id: "replacement-device", name: "Phone" } });
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("online");
    expect(localStorage.getItem("cs.deviceId")).toBe("replacement-device");
    expect(ws.sent.map((line) => JSON.parse(line).type)).toEqual([
      "auth.device",
      "pair.complete",
      "auth.device",
    ]);
    await hook.unmount();
  });

  test("a new browser still needs a valid one-use pairing grant", async () => {
    setupBrowser();
    localStorage.removeItem("cs.deviceId");
    window.location.search = "?pairing=invalid-test-token";
    const hook = await renderHook(() => useRemoteSocket({}));
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      ws.message({ type: "pair.failed", message: "Pairing token expired or invalid" });
      await flushMicrotasks();
    });
    expect(ws.sent.map((line) => JSON.parse(line).type)).toEqual(["pair.complete"]);
    expect(hook.result.current.status).toBe("unpaired");
    expect(localStorage.getItem("cs.deviceId")).toBeNull();
    expect(hook.result.current.send({ type: "session.list" })).toBe(false);
    await hook.unmount();
  });

  test("passcode rotation offers HTTP verification without losing pairing or replaying writes", async () => {
    setupBrowser();
    const resyncs: ResyncReason[] = [];
    const hook = await renderHook(() =>
      useRemoteSocket({ onResyncNeeded: (reason) => resyncs.push(reason) }),
    );
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    const generation = hook.result.current.connectionGeneration;
    await act(async () => {
      ws.readyState = FakeWebSocket.CLOSED;
      ws.onclose?.({ code: 4407 });
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("offline");
    expect(hook.result.current.accessRequired).toBe(true);
    expect(localStorage.getItem("cs.deviceId")).toBe("device-1");
    expect(localStorage.getItem("cs.deviceSecret")).toBe("secret-1");
    expect(hook.result.current.send({ type: "chat.send", text: "pending draft" }, generation)).toBe(
      false,
    );
    expect(
      hook.result.current.send({
        type: "approval.respond",
        approvalId: "pending",
        decision: "approve",
      }),
    ).toBe(false);
    await act(async () => {
      for (const name of ["online", "focus", "pageshow"]) window.dispatchEvent(new Event(name));
      document.dispatchEvent(new Event("visibilitychange"));
      await flushMicrotasks();
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.sent.map((line) => JSON.parse(line).type)).toEqual(["auth.device"]);
    expect(resyncs).toEqual(["online"]);
    await hook.unmount();
  });

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
