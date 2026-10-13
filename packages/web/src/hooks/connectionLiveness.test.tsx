import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ProtocolClient } from "../../app/protocol.js";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook.js";
import { useRemoteSocket } from "./useRemoteSocket.js";

class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: any[] = [];
  closeCalls = 0;
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  // Deliberately no close event: a half-open transport must not own recovery.
  close() {
    this.closeCalls++;
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

let cleanup: (() => void | Promise<void>) | undefined;
const restores: Array<() => void> = [];
let visibility = "visible";
/** Control only connection-scale timers. React's task/microtask scheduling and
 * ordinary request/Run deadlines retain their actual implementation. */
class Clock {
  now = 0;
  next = 0;
  jobs = new Map<number, { at: number; run: () => void }>();
  captured: Array<() => void> = [];
  constructor() {
    const nativeSet = globalThis.setTimeout;
    const nativeClear = globalThis.clearTimeout;
    property(globalThis, "setTimeout", {
      value: (run: () => void, ms: number, ...args: unknown[]) => {
        if (![5_000, 10_000, 15_000, 800].includes(ms) && !(ms >= 400 && ms <= 800))
          return nativeSet(run, ms, ...args);
        const id = --this.next;
        this.jobs.set(id, { at: this.now + ms, run });
        this.captured.push(run);
        return id;
      },
    });
    property(globalThis, "clearTimeout", {
      value: (id: ReturnType<typeof setTimeout>) => {
        if (typeof id === "number" && this.jobs.delete(id)) return;
        nativeClear(id);
      },
    });
  }
  advance(ms: number) {
    const through = this.now + ms;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > through) break;
      this.now = next[1].at;
      this.jobs.delete(next[0]);
      next[1].run();
    }
    this.now = through;
  }
}
function property(target: object, key: string, value: PropertyDescriptor) {
  const old = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...value });
  restores.push(() => {
    if (old) Object.defineProperty(target, key, old);
    else Reflect.deleteProperty(target, key);
  });
}
function browser() {
  ensureMiniDom();
  Socket.instances = [];
  visibility = "visible";
  property(globalThis, "WebSocket", { value: Socket, writable: true });
  property(window, "location", {
    value: { origin: "http://127.0.0.1:3210", pathname: "/mobile/", search: "" },
  });
  property(window, "history", { value: { replaceState() {} } });
  const values = new Map([
    ["cs.deviceId", "phone"],
    ["cs.deviceSecret", "synthetic-device-secret"],
    ["cs.deviceName", "Phone"],
  ]);
  property(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  property(document, "visibilityState", { get: () => visibility });
}
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  for (const restore of restores.splice(0).reverse()) restore();
});

test("Hub foreground probes a still-OPEN wire with a read-only request, never another Run", () => {
  browser();
  const client = new ProtocolClient("ws://127.0.0.1:3210/ws");
  cleanup = () => client.close();
  client.connect();
  const socket = Socket.instances[0];
  socket.open();
  void client.run({ sessionId: "owned-session", task: "synthetic hold" }).catch(() => {});
  window.dispatchEvent(new Event("focus"));
  expect(socket.sent.filter((frame) => frame.method === "agent/run")).toHaveLength(1);
  expect(socket.sent.filter((frame) => frame.method === "agent/query")).toHaveLength(1);
  expect(socket.sent.at(-1).params).toEqual({ type: "sessions" });
});

test.each(["retire", "close", "auth"])(
  "Hub %s invalidates a resolved read before its promise adopter runs",
  async (change) => {
    browser();
    const client = new ProtocolClient("ws://127.0.0.1:3210/ws");
    cleanup = () => client.close();
    client.connect();
    const socket = Socket.instances[0];
    socket.open();
    const generation = client.connectionGeneration;
    let adopted = false;
    const response = client.approvalSnapshot().then(() => {
      if (client.connectionGeneration === generation) adopted = true;
    });
    socket.receive({ id: socket.sent.at(-1).id, result: { approvals: [], leases: [] } });
    if (change === "close") client.close();
    else socket.onclose?.({ code: change === "auth" ? 4401 : 1000 });
    await response;
    expect(adopted).toBe(false);
    expect(client.connectionGeneration).not.toBe(generation);
    expect(Socket.instances).toHaveLength(1);
  },
);

test("paired Mobile foreground probes an authenticated OPEN wire without an approval write", async () => {
  browser();
  const hook = await renderHook(() => useRemoteSocket({}));
  cleanup = () => hook.unmount();
  const socket = Socket.instances[0];
  await act(async () => {
    socket.open();
    socket.receive({ type: "auth.ok", device: { id: "phone", name: "Phone" } });
    window.dispatchEvent(new Event("focus"));
    await flushMicrotasks();
  });
  expect(hook.result.current.status).toBe("online");
  expect(socket.sent.filter((frame) => frame.type === "session.list")).toHaveLength(1);
  expect(socket.sent.some((frame) => frame.type === "approval.respond")).toBe(false);
});

test("Hub missing probe ACK retires immediately without close, rejects uncertain Run, and redials once", async () => {
  browser();
  const clock = new Clock();
  const client = new ProtocolClient("ws://127.0.0.1:3210/ws");
  cleanup = () => client.close();
  const states: string[] = [];
  client.onStateChange((value) => states.push(value));
  client.connect();
  const first = Socket.instances[0];
  first.open();
  const run = client.run({ sessionId: "same-session", task: "hold" }).catch((e) => e);
  clock.advance(15_000);
  expect(first.sent.filter((m) => m.method === "agent/query")).toHaveLength(1);
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  expect(first.sent.filter((m) => m.method === "agent/query")).toHaveLength(1);
  clock.advance(5_000);
  expect(states.at(-1)).toBe("closed");
  expect(first.closeCalls).toBe(1);
  expect((await run).kind).toBe("transport");
  clock.advance(800);
  expect(Socket.instances).toHaveLength(2);
  expect(
    Socket.instances.flatMap((s) => s.sent).filter((m) => m.method === "agent/run"),
  ).toHaveLength(1);
  client.close();
  expect(clock.jobs.size).toBe(0);
});

test("Hub unsupported and permission error replies prove liveness; foreground checks are single-flight", () => {
  browser();
  const clock = new Clock();
  const client = new ProtocolClient("ws://127.0.0.1:3210/ws");
  cleanup = () => client.close();
  let resync = 0;
  client.onResync(() => resync++);
  client.connect();
  const socket = Socket.instances[0];
  socket.open();
  for (const code of [-32601, -32009]) {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    const probe = socket.sent.at(-1);
    socket.receive({ id: probe.id, error: { code, message: "synthetic denied" } });
    clock.advance(5_000);
    expect(socket.closeCalls).toBe(0);
  }
  expect(resync).toBe(2);
  expect(socket.sent).toHaveLength(2);
  client.close();
  expect(clock.jobs.size).toBe(0);
});

test("Hub late callbacks from a retired socket cannot clear a new deadline or adopt its state", () => {
  browser();
  const clock = new Clock();
  const client = new ProtocolClient("ws://127.0.0.1:3210/ws");
  cleanup = () => client.close();
  client.connect();
  const first = Socket.instances[0];
  first.open();
  const lateMessage = first.onmessage!;
  const lateClose = first.onclose!;
  window.dispatchEvent(new Event("focus"));
  clock.advance(5_000 + 800);
  const second = Socket.instances[1];
  second.open();
  window.dispatchEvent(new Event("focus"));
  lateMessage({ data: JSON.stringify({ id: first.sent.at(-1).id, result: {} }) });
  lateClose({ code: 4401 });
  clock.advance(5_000);
  expect(second.closeCalls).toBe(1);
  clock.advance(800);
  expect(Socket.instances).toHaveLength(3);
});

test("Hub hidden pages pause deadlines; queued old expiry cannot kill the resumed wire", () => {
  browser();
  const clock = new Clock();
  const client = new ProtocolClient("ws://127.0.0.1:3210/ws");
  cleanup = () => client.close();
  client.connect();
  const socket = Socket.instances[0];
  socket.open();
  window.dispatchEvent(new Event("focus"));
  const frozenExpiry = clock.captured.at(-1)!;
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  clock.advance(300_000);
  expect(socket.closeCalls).toBe(0);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  frozenExpiry();
  expect(socket.closeCalls).toBe(0);
  socket.receive({ id: socket.sent.at(-1).id, error: { code: -32601 } });
  clock.advance(5_000);
  expect(socket.closeCalls).toBe(0);
});

test.each([4401, 4403])(
  "Hub revocation %i and explicit close stop probes, timers and page listeners",
  (code) => {
    browser();
    const clock = new Clock();
    const client = new ProtocolClient("ws://127.0.0.1:3210/ws");
    cleanup = () => client.close();
    let lost = 0;
    client.onAuthLost(() => lost++);
    client.connect();
    const socket = Socket.instances[0];
    socket.open();
    socket.onclose?.({ code });
    window.dispatchEvent(new Event("focus"));
    clock.advance(100_000);
    expect(lost).toBe(1);
    expect(Socket.instances).toHaveLength(1);
    expect(clock.jobs.size).toBe(0);
  },
);

test("Hub a CONNECTING wire with no close event has a bounded handshake", () => {
  browser();
  const clock = new Clock();
  const client = new ProtocolClient("ws://127.0.0.1:3210/ws");
  cleanup = () => client.close();
  client.connect();
  clock.advance(10_000);
  expect(Socket.instances[0].closeCalls).toBe(1);
  clock.advance(800);
  expect(Socket.instances).toHaveLength(2);
});

test("Hub unrelated downlink traffic cannot acknowledge a missing upstream probe", () => {
  browser();
  const clock = new Clock();
  const client = new ProtocolClient("ws://127.0.0.1:3210/ws");
  cleanup = () => client.close();
  client.connect();
  const socket = Socket.instances[0];
  socket.open();
  window.dispatchEvent(new Event("focus"));
  for (let i = 0; i < 5; i++) {
    socket.receive({ method: "serve/sessionStatus", params: { running: true } });
    socket.receive({ id: "an-unrelated-request", error: { code: -32601 } });
    clock.advance(1_000);
  }
  expect(socket.closeCalls).toBe(1);
});

test("Hub explicit connect after authority loss reinstalls exactly one page listener set", () => {
  browser();
  const clock = new Clock();
  const client = new ProtocolClient("ws://127.0.0.1:3210/ws");
  cleanup = () => client.close();
  client.connect();
  Socket.instances[0].open();
  Socket.instances[0].onclose?.({ code: 4401 });
  client.connect();
  const socket = Socket.instances[1];
  socket.open();
  window.dispatchEvent(new Event("focus"));
  expect(socket.sent).toHaveLength(1);
  clock.advance(5_000);
  expect(socket.closeCalls).toBe(1);
});

test("paired Mobile missing ACK retires an OPEN wire; old generations and foreground storms cannot write twice", async () => {
  browser();
  const clock = new Clock();
  const hook = await renderHook(() => useRemoteSocket({}));
  cleanup = () => hook.unmount();
  const first = Socket.instances[0];
  await act(async () => {
    first.open();
    first.receive({ type: "auth.ok", device: { id: "phone" } });
    await flushMicrotasks();
  });
  const oldGeneration = hook.result.current.connectionGeneration;
  const lateMessage = first.onmessage;
  expect(
    hook.result.current.send({ type: "approval.respond", approvalId: "one", decision: "approve" }),
  ).toBe(true);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    clock.advance(5_000);
    await flushMicrotasks();
  });
  expect(hook.result.current.status).toBe("offline");
  expect(first.closeCalls).toBe(1);
  await act(async () => {
    clock.advance(800);
    Socket.instances[1].open();
    Socket.instances[1].receive({ type: "auth.ok", device: { id: "phone" } });
    lateMessage?.({ data: JSON.stringify({ type: "auth.ok", device: { id: "other" } }) });
    await flushMicrotasks();
  });
  expect(hook.result.current.connectionGeneration).toBe(oldGeneration + 1);
  expect(hook.result.current.send({ type: "session.list" }, oldGeneration)).toBe(false);
  expect(first.sent.filter((m) => m.type === "session.list")).toHaveLength(1);
  expect(
    Socket.instances.flatMap((s) => s.sent).filter((m) => m.type === "approval.respond"),
  ).toHaveLength(1);
  await hook.unmount();
  cleanup = undefined;
  expect(clock.jobs.size).toBe(0);
});

test("paired Mobile background expiry, rejected read-only probe, logout and no-auth deadlines preserve lifetime", async () => {
  browser();
  const clock = new Clock();
  const hook = await renderHook(() => useRemoteSocket({}));
  cleanup = () => hook.unmount();
  const socket = Socket.instances[0];
  await act(async () => {
    socket.open();
    socket.receive({ type: "auth.ok", device: { id: "phone" } });
    window.dispatchEvent(new Event("focus"));
    await flushMicrotasks();
  });
  const frozenExpiry = clock.captured.at(-1)!;
  await act(async () => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    clock.advance(90_000);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    frozenExpiry();
    socket.receive({ type: "error", message: "read-only request unsupported" });
    clock.advance(5_000);
    await flushMicrotasks();
  });
  expect(hook.result.current.status).toBe("online");
  expect(socket.closeCalls).toBe(0);
  await act(async () => {
    hook.result.current.logout();
    window.dispatchEvent(new Event("focus"));
    clock.advance(100_000);
    await flushMicrotasks();
  });
  expect(hook.result.current.status).toBe("unpaired");
  expect(clock.jobs.size).toBe(0);
  expect(Socket.instances).toHaveLength(1);
});

test.each(["auth.failed", "pair.failed"])(
  "paired Mobile %s cannot restart from foreground",
  async (type) => {
    browser();
    const clock = new Clock();
    const hook = await renderHook(() => useRemoteSocket({}));
    cleanup = () => hook.unmount();
    const socket = Socket.instances[0];
    await act(async () => {
      socket.open();
      socket.receive({ type, message: "synthetic revoked" });
      window.dispatchEvent(new Event("focus"));
      clock.advance(100_000);
      await flushMicrotasks();
    });
    expect(hook.result.current.status).toBe("unpaired");
    expect(Socket.instances).toHaveLength(1);
    expect(clock.jobs.size).toBe(0);
  },
);

test("paired Mobile unrelated downstream worker/approval traffic cannot acknowledge a dropped read-only probe", async () => {
  browser();
  const clock = new Clock();
  const hook = await renderHook(() => useRemoteSocket({}));
  cleanup = () => hook.unmount();
  const socket = Socket.instances[0];
  await act(async () => {
    socket.open();
    socket.receive({ type: "auth.ok", device: { id: "phone" } });
    window.dispatchEvent(new Event("focus"));
    for (let i = 0; i < 5; i++) {
      socket.receive({ method: "agent/streamEvent", params: { event: { type: "text_delta" } } });
      socket.receive({ type: "error", approvalId: "other", message: "other decision failed" });
      clock.advance(1_000);
    }
    await flushMicrotasks();
  });
  expect(hook.result.current.status).toBe("offline");
  expect(socket.closeCalls).toBe(1);
});

test.each([true, false])(
  "paired Mobile slow connect leaves a full bounded auth phase (ACK=%s)",
  async (answer) => {
    browser();
    const clock = new Clock();
    const hook = await renderHook(() => useRemoteSocket({}));
    cleanup = () => hook.unmount();
    const socket = Socket.instances[0];
    await act(async () => {
      clock.advance(9_000);
      socket.open();
      clock.advance(9_000);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
      if (answer) socket.receive({ type: "auth.ok", device: { id: "phone" } });
      await flushMicrotasks();
    });
    expect(socket.closeCalls).toBe(0);
    expect(hook.result.current.status).toBe(answer ? "online" : "authenticating");
    await act(async () => {
      clock.advance(1_000);
      await flushMicrotasks();
    });
    expect(socket.closeCalls).toBe(answer ? 0 : 1);
    expect(hook.result.current.status).toBe(answer ? "online" : "offline");
  },
);
