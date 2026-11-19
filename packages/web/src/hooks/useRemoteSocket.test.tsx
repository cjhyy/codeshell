import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { useRemoteSocket, type ResyncReason } from "./useRemoteSocket";
import { accountRelayRecoveryPage } from "../lib/accountRelayBootstrap";
import {
  AccountRelaySessionExpired,
  loadAccountRelayCredential,
  remoteDeviceCredential,
} from "../lib/accountRelaySession.js";

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
  test.each([60_000, 600_400, 630_000])(
    "account bootstrap tolerates bounded clock skew at %d ms while preserving its local lifetime cap",
    async (remaining) => {
      setupBrowser();
      const now = 1_800_000_000_000;
      const restoreNow = defineTestProperty(Date, "now", { value: () => now });
      globalThis.fetch = (async (url: string) => {
        expect(url).toBe("/api/v1/relay/session");
        return Response.json({
          active: true,
          deviceId: "account-browser",
          secretHash: "a".repeat(43),
          expiresAt: now + remaining,
        });
      }) as typeof fetch;
      try {
        const credential = await loadAccountRelayCredential(new AbortController().signal);
        expect(credential?.expiresAt).toBe(now + Math.min(remaining, 600_000));
        expect(localStorage.getItem("cs.deviceId")).toBe("device-1");
      } finally {
        restoreNow();
      }
    },
  );

  test.each([-1, 630_001])(
    "account bootstrap rejects expired or out-of-range grants at %d ms",
    async (remaining) => {
      setupBrowser();
      const now = 1_800_000_000_000;
      const restoreNow = defineTestProperty(Date, "now", { value: () => now });
      globalThis.fetch = (async () =>
        Response.json({
          active: true,
          deviceId: "account-browser",
          secretHash: "a".repeat(43),
          expiresAt: now + remaining,
        })) as typeof fetch;
      try {
        await expect(
          loadAccountRelayCredential(new AbortController().signal),
        ).rejects.toBeInstanceOf(AccountRelaySessionExpired);
      } finally {
        restoreNow();
      }
    },
  );

  test("an account browser uses an in-memory grant without replacing its legacy pairing", async () => {
    setupBrowser();
    window.location.origin = "https://computer.fixture.test";
    const calls: string[] = [];
    const credential = { deviceId: "account-browser", secretHash: "a".repeat(43) };
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url === "/__relay/session/resume")
        return Response.json({ error: "invalid_relay_authorization" }, { status: 401 });
      if (url.endsWith("/logout")) return Response.json({ ok: true });
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
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });
    expect(hook.result.current.accountAccessRequired).toBe(true);
    expect(hook.result.current.accountEntryUrl).toBe("https://account.test/app");
    await act(async () => {
      hook.result.current.logout();
      await flushMicrotasks();
    });
    expect(calls).toEqual([
      "/api/v1/relay/session",
      "/__relay/session/resume",
      "/api/v1/relay/session/logout",
      "/__relay/logout",
    ]);
    expect(localStorage.getItem("cs.deviceId")).toBe("device-1");
    await hook.unmount();
  });

  test.each([200, 401])(
    "a missing or expired account cookie requests Passkey again without durable-pairing fallback (%s)",
    async (status) => {
      setupBrowser();
      window.location.origin = "https://computer.fixture.test";
      globalThis.fetch = (async (url: string) =>
        url === "/__relay/session/resume"
          ? Response.json({ error: "invalid_relay_authorization" }, { status: 401 })
          : Response.json(
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

  test("an expired outer relay grant requires account authorization before constructing a socket", async () => {
    setupBrowser();
    window.location.origin = "https://computer.fixture.test";
    window.location.search = "?pairing=old-token";
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      expect(["/api/v1/relay/session", "/__relay/session/resume"]).toContain(url);
      calls.push(url);
      return Response.json({ error: "invalid_relay_authorization" }, { status: 401 });
    }) as typeof fetch;
    const hook = await renderHook(() => useRemoteSocket({}));
    try {
      expect(hook.result.current.status).toBe("offline");
      expect(hook.result.current.accessRequired).toBe(true);
      expect(hook.result.current.accountAccessRequired).toBe(true);
      // A cold page has no validated account destination; its existing navigation
      // fallback must ask the gateway, rather than inventing a URL from this error.
      expect(hook.result.current.accountEntryUrl).toBeUndefined();
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(hook.result.current.send({ type: "chat.send", text: "keep this draft" })).toBe(false);
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
      expect(calls).toEqual(["/api/v1/relay/session", "/__relay/session/resume"]);
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(localStorage.getItem("cs.deviceId")).toBe("device-1");
      expect(localStorage.getItem("cs.deviceSecret")).toBe("secret-1");
    } finally {
      await hook.unmount();
    }
  });

  test.each([
    { name: "older Host without a bootstrap endpoint", status: 404, error: undefined },
    { name: "unrelated unauthorized response", status: 401, error: "passcode_required" },
    {
      name: "matching error with a different status",
      status: 403,
      error: "invalid_relay_authorization",
    },
    { name: "matching error without rejection", status: 200, error: "invalid_relay_authorization" },
  ])("$name retains the existing legacy bootstrap behavior", async ({ status, error }) => {
    setupBrowser();
    window.location.origin = "https://computer.fixture.test";
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe("/api/v1/relay/session");
      return error === undefined
        ? new Response("not found", { status, headers: { "content-type": "text/plain" } })
        : Response.json({ error }, { status });
    }) as typeof fetch;
    const hook = await renderHook(() => useRemoteSocket({}));
    try {
      expect(hook.result.current.accessRequired).toBe(false);
      expect(hook.result.current.accountAccessRequired).toBe(false);
      expect(FakeWebSocket.instances).toHaveLength(1);
      const ws = FakeWebSocket.instances[0]!;
      await act(async () => {
        ws.open();
        await flushMicrotasks();
      });
      expect(ws.sent.map((line) => JSON.parse(line))).toEqual([
        { type: "auth.device", deviceId: "device-1", secretHash: "secret-1" },
      ]);
    } finally {
      await hook.unmount();
    }
  });

  test("proactive renewal is single-flight and replaces only the authenticated generation without replay", async () => {
    setupBrowser();
    window.location.origin = "https://computer.fixture.test";
    const now = 1_800_000_000_000;
    const restoreNow = defineTestProperty(Date, "now", { value: () => now });
    const nativeSet = globalThis.setTimeout;
    let renew: (() => void) | undefined;
    const restoreTimer = defineTestProperty(globalThis, "setTimeout", {
      value: (run: () => void, ms: number, ...args: unknown[]) => {
        if (ms === 270_000) {
          renew = run;
          return -1234;
        }
        return nativeSet(run, ms, ...args);
      },
    });
    let finishResume!: (value: Response) => void;
    let exchanged = false;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      calls.push(`${options?.method ?? "GET"} ${url}`);
      expect(options?.credentials).toBe("same-origin");
      expect(options?.redirect).toBe("error");
      if (url === "/__relay/session/resume") {
        expect(options?.body).toBe("{}");
        expect(options?.headers).toEqual({ "content-type": "application/json" });
        return new Promise<Response>((resolve) => {
          finishResume = resolve;
        });
      }
      expect(url).toBe("/api/v1/relay/session");
      if (options?.method === "POST") {
        expect(JSON.parse(String(options.body))).toEqual({ handoff: "h".repeat(43) });
        exchanged = true;
      }
      return Response.json({
        ...(options?.method === "POST" ? {} : { active: true }),
        deviceId: exchanged ? "renewed" : "initial",
        secretHash: "a".repeat(43),
        expiresAt: now + 300_000,
      });
    }) as typeof fetch;
    const resync: ResyncReason[] = [];
    const hook = await renderHook(() =>
      useRemoteSocket({ onResyncNeeded: (reason) => resync.push(reason) }),
    );
    try {
      const old = FakeWebSocket.instances[0]!;
      await act(async () => {
        old.open();
        old.message({ type: "auth.ok" });
        await flushMicrotasks();
      });
      const generation = hook.result.current.connectionGeneration;
      expect(hook.result.current.send({ type: "chat.send", text: "one request" }, generation)).toBe(
        true,
      );
      await act(async () => {
        renew!();
        for (const name of ["focus", "pageshow", "online"]) window.dispatchEvent(new Event(name));
        await flushMicrotasks();
      });
      expect(calls.filter((call) => call.includes("resume"))).toHaveLength(1);
      expect(hook.result.current.status).toBe("online");
      expect(old.readyState).toBe(FakeWebSocket.OPEN);
      await act(async () => {
        finishResume(Response.json({ handoff: "h".repeat(43), expiresAt: now + 300_000 }));
        await flushMicrotasks();
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(old.readyState).toBe(FakeWebSocket.CLOSED);
      const current = FakeWebSocket.instances[1]!;
      await act(async () => {
        current.open();
        current.message({ type: "auth.ok" });
        await flushMicrotasks();
      });
      expect(hook.result.current.accessRequired).toBe(false);
      expect(hook.result.current.connectionGeneration).toBe(generation + 1);
      expect(
        hook.result.current.send({ type: "chat.send", text: "stale action" }, generation),
      ).toBe(false);
      expect(
        FakeWebSocket.instances
          .flatMap((socket) => socket.sent.map((line) => JSON.parse(line)))
          .filter((event) => event.type === "chat.send"),
      ).toEqual([{ type: "chat.send", text: "one request" }]);
      expect(current.sent.map((line) => JSON.parse(line).type)).toEqual(["auth.device"]);
      expect(resync.filter((reason) => reason === "online")).toHaveLength(2);
      expect(localStorage.getItem("cs.deviceId")).toBe("device-1");
    } finally {
      await hook.unmount();
      restoreNow();
      restoreTimer();
    }
  });

  test("an offline resume keeps authorization pending and a later focus restores it", async () => {
    setupBrowser();
    window.location.origin = "https://computer.fixture.test";
    let online = false,
      exchanged = false;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      calls.push(url);
      if (url === "/__relay/session/resume")
        return online
          ? Response.json({ handoff: "h".repeat(43), expiresAt: Date.now() + 60_000 })
          : Response.json({ error: "computer_offline" }, { status: 503 });
      if (options?.method === "POST") exchanged = true;
      return exchanged
        ? Response.json({
            active: true,
            deviceId: "restored",
            secretHash: "a".repeat(43),
            expiresAt: Date.now() + 60_000,
          })
        : Response.json({ accountRelay: true, active: false });
    }) as typeof fetch;
    const hook = await renderHook(() => useRemoteSocket({}));
    try {
      expect(hook.result.current.accountAccessRequired).toBe(false);
      expect(FakeWebSocket.instances).toHaveLength(0);
      online = true;
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await flushMicrotasks();
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(calls.filter((call) => call === "/__relay/session/resume")).toHaveLength(2);
      expect(localStorage.getItem("cs.deviceSecret")).toBe("secret-1");
    } finally {
      await hook.unmount();
    }
  });

  test("an aborted old bootstrap cannot redeem a late handoff or change a new actor", async () => {
    setupBrowser();
    window.location.origin = "https://computer.fixture.test";
    let finish!: (value: Response) => void;
    let posts = 0;
    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      if (url === "/__relay/session/resume")
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      if (options?.method === "POST") posts++;
      return Response.json({ accountRelay: true, active: false });
    }) as typeof fetch;
    const old = await renderHook(() => useRemoteSocket({}));
    await old.unmount();
    globalThis.fetch = (async () =>
      Response.json({
        active: true,
        deviceId: "new-actor",
        secretHash: "b".repeat(43),
        expiresAt: Date.now() + 60_000,
      })) as typeof fetch;
    const current = await renderHook(() => useRemoteSocket({}));
    try {
      await act(async () => {
        finish(Response.json({ handoff: "h".repeat(43), expiresAt: Date.now() + 60_000 }));
        await flushMicrotasks();
      });
      expect(posts).toBe(0);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(remoteDeviceCredential().deviceId).toBe("new-actor");
    } finally {
      await current.unmount();
    }
  });

  test.each(["bad-token", "too-long", "cookie-not-saved"])(
    "invalid resume %s cannot admit a socket",
    async (mode) => {
      setupBrowser();
      window.location.origin = "https://computer.fixture.test";
      let posts = 0;
      globalThis.fetch = (async (url: string, options?: RequestInit) => {
        if (url === "/__relay/session/resume")
          return Response.json({
            handoff: mode === "bad-token" ? "invalid" : "h".repeat(43),
            expiresAt: Date.now() + (mode === "too-long" ? 631_000 : 60_000),
          });
        if (options?.method === "POST") {
          posts++;
          return Response.json({
            deviceId: "unsaved",
            secretHash: "a".repeat(43),
            expiresAt: Date.now() + 60_000,
          });
        }
        return Response.json({ active: false, accountRelay: true });
      }) as typeof fetch;
      const hook = await renderHook(() => useRemoteSocket({}));
      try {
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(posts).toBe(mode === "cookie-not-saved" ? 1 : 0);
        expect(hook.result.current.accessRequired).toBe(false);
      } finally {
        await hook.unmount();
      }
    },
  );

  test("logout ends the outer session even when the Host is offline and reports an unconfirmed logout", async () => {
    setupBrowser();
    window.location.origin = "https://computer.fixture.test";
    let failOuter = true;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url === "/api/v1/relay/session/logout") throw new Error("offline");
      if (url === "/__relay/logout")
        return Response.json({ ok: !failOuter }, { status: failOuter ? 503 : 200 });
      return Response.json({
        active: true,
        deviceId: "account",
        secretHash: "a".repeat(43),
        expiresAt: Date.now() + 60_000,
      });
    }) as typeof fetch;
    const hook = await renderHook(() => useRemoteSocket({}));
    try {
      await act(async () => {
        hook.result.current.logout();
        await flushMicrotasks();
      });
      expect(hook.result.current.logoutError).toContain("未能确认服务器退出");
      expect(calls.slice(-2)).toEqual(["/api/v1/relay/session/logout", "/__relay/logout"]);
      failOuter = false;
      await act(async () => {
        hook.result.current.logout();
        await flushMicrotasks();
      });
      expect(hook.result.current.logoutError).toBeUndefined();
      expect(localStorage.getItem("cs.deviceId")).toBe("device-1");
      expect(hook.result.current.send({ type: "chat.send", text: "unsent" })).toBe(false);
    } finally {
      await hook.unmount();
    }
  });

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

  test("reconnectNow skips the backoff wait after a drop and is a no-op while online", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteSocket({}));
    const first = FakeWebSocket.instances[0]!;
    await act(async () => {
      first.open();
      first.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("online");
    // Online: a manual retry must not tear down a healthy socket.
    await act(async () => {
      hook.result.current.reconnectNow();
      await flushMicrotasks();
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      first.onerror?.();
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("offline");
    // The backoff timer has not fired yet; only the manual retry opens a socket.
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => {
      hook.result.current.reconnectNow();
      await flushMicrotasks();
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(hook.result.current.status).toBe("connecting");

    const reconnect = hook.result.current.reconnectNow;
    await hook.unmount();
    reconnect();
    expect(FakeWebSocket.instances).toHaveLength(2);
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

test("account relay recovery page embeds one nonce-bound, parseable bootstrap script", () => {
  const page = accountRelayRecoveryPage('https://account.example/app"><x>');
  const scripts = [...page.html.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const [, nonce, source] = scripts[0]!;
  expect(page.policy).toContain(`script-src 'nonce-${nonce}'`);
  expect(page.policy).toContain("connect-src 'self'");
  expect(page.policy).toContain("form-action 'none'");
  // The Host serializes the shared bootstrap with Function#toString; it must
  // stay self-contained after compilation or the pre-SPA page silently breaks.
  expect(() => new Function(source!)).not.toThrow();
  expect(page.html).not.toContain('"><x>');
  expect(page.html).toContain("&quot;&gt;&lt;x&gt;");
  expect(accountRelayRecoveryPage("https://account.example/app").policy).not.toBe(page.policy);
});
