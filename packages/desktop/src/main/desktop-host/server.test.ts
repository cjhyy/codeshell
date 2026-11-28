import { EventEmitter } from "node:events";
import { describe, expect, spyOn, test } from "bun:test";
import {
  DesktopHostErrors,
  type DesktopHostIdentity,
  type RpcNotification,
  type RpcResponse,
} from "../../shared/desktop-host-protocol.js";
import { hostSessionVisible } from "../../shared/disk-session-query.js";
import * as desktopLogger from "../desktop-logger.js";
import { outputMethods } from "./output-methods.js";
import { DesktopHostServer, desktopHostMethods, type DesktopHostMethod } from "./server.js";

class TestPort extends EventEmitter {
  messages: Array<RpcResponse | RpcNotification> = [];
  closed = false;
  started = false;

  start() {
    this.started = true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  postMessage(message: RpcResponse | RpcNotification) {
    this.messages.push(message);
    if ("result" in message) this.emit("result");
  }

  request(id: number, method: string, params?: Record<string, unknown>) {
    this.emit("message", {
      data: { jsonrpc: "2.0", id, method, ...(params && { params }) },
      ports: [],
    });
  }

  responses(id: number) {
    return this.messages.filter((msg): msg is RpcResponse => "id" in msg && msg.id === id);
  }
}

const sessionId = "session";
const revoked = DesktopHostErrors.revoked;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function frame(webContentsId: number, frameGeneration = 1): DesktopHostIdentity {
  return {
    webContentsId,
    frameGeneration,
    frameToken: `f-${webContentsId}-${frameGeneration}`,
    windowKind: "workbench",
  };
}

function connect(server: DesktopHostServer, identity: DesktopHostIdentity) {
  const port = new TestPort();
  server.bind(identity, port);
  port.request(0, "initialize", { protocolVersions: ["2.0"] });
  expect(port.responses(0)[0]).toHaveProperty("result.protocolVersion", "2.0");
  return port;
}

test.each(["port", "workbench"] as const)(
  "a full window reports both request paths on %s rejection",
  async (route) => {
    const log = spyOn(desktopLogger, "dlog").mockImplementation(() => {});
    const pending = Promise.withResolvers<void>();
    const methods = new Map<string, DesktopHostMethod>([
      ["sessions/listDisk", { run: () => pending.promise }],
      ["agent/subscribe", { sessionId: () => sessionId, run: () => pending.promise }],
      ["projects/trust", { run: () => "trusted" }],
    ]);
    const server = new DesktopHostServer("test", methods);
    const identity = frame(1);
    const port = connect(server, identity);
    server.setOwner(sessionId, 1);
    const read = () => server.readWorkbenchOutput(identity, { sessionId });
    try {
      for (let id = 1; id <= 127; id++) port.request(id, "sessions/listDisk");
      const compatibilityRead = read();
      expect(log).not.toHaveBeenCalled();
      if (route === "workbench") await expect(read()).rejects.toThrow("Too many pending");
      port.request(128, "projects/trust", { path: "/private/example" });
      expect(port.responses(128)[0].error?.code).toBe(-32001);
      port.request(129, "projects/trust");
      expect(log.mock.calls).toEqual([
        [
          "desktop-host",
          "desktop_host.request_limit",
          {
            webContentsId: 1,
            frameGeneration: 1,
            rejectedMethod: route === "port" ? "projects/trust" : "agent/subscribe",
            route,
            limit: 128,
            portRequests: 127,
            workbenchRequests: 1,
            byMethod: [
              { method: "sessions/listDisk", count: 127, oldestMs: expect.any(Number) },
              { method: "agent/subscribe", count: 1, oldestMs: expect.any(Number) },
            ],
          },
        ],
      ]);
      pending.resolve();
      await compatibilityRead;
      port.request(130, "projects/trust");
      await tick();
      expect(port.responses(130)[0].result).toBe("trusted");
    } finally {
      pending.resolve();
      log.mockRestore();
    }
  },
);

function fixture() {
  const effects: number[] = [];
  const resume: Array<() => void> = [];
  const method: DesktopHostMethod = {
    sessionId: (params) => (typeof params?.sessionId === "string" ? params.sessionId : ""),
    async run(context, params) {
      if (params?.pause) await new Promise<void>((resolve) => resume.push(resolve));
      context.assertCurrent();
      effects.push(context.identity.webContentsId);
      return context.identity.webContentsId;
    },
  };
  const server = new DesktopHostServer("0.12-test", new Map([["session/use", method]]));
  const a = connect(server, frame(1));
  const b = connect(server, frame(2));
  server.setOwner(sessionId, 1);
  return { server, a, b, effects, resume };
}

describe("Desktop Host grants", () => {
  test("only the bound port supplies identity; renderer requests cannot call Main or change owner", async () => {
    const { a, b, effects } = fixture();
    b.request(1, "session/use", { sessionId, identity: frame(1), webContentsId: 1 });
    b.request(2, "app/getVersion");
    b.request(3, "owner", { sessionId, webContentsId: 2 });
    b.request(4, "session/use", {});
    a.request(1, "session/use", { sessionId, identity: frame(2) });
    await tick();
    expect(b.responses(1)[0]?.error?.code).toBe(revoked);
    expect(b.responses(2)[0]?.error?.code).toBe(-32601);
    expect(b.responses(3)[0]?.error?.code).toBe(-32601);
    expect(b.responses(4)[0]?.error?.code).toBe(-32602);
    expect(a.responses(1)[0]?.result).toBe(1);
    expect(effects).toEqual([1]);
  });

  test("frame replacement cancels an old request and stale close/revoke cannot affect the new frame", async () => {
    const { server, a, effects, resume } = fixture();
    a.request(1, "session/use", { sessionId, pause: true });
    const next = connect(server, frame(1, 2));
    expect(a.closed).toBe(true);
    expect(a.responses(1)[0]?.error?.code).toBe(revoked);
    server.revoke(frame(1));
    server.revoke({ ...frame(1, 2), frameToken: "old-token" });
    a.emit("close");
    const stale = new TestPort();
    server.bind(frame(1), stale);
    expect(stale.closed).toBe(true);
    resume[0]();
    a.request(2, "session/use", { sessionId });
    next.request(1, "session/use", { sessionId });
    await tick();
    expect(next.responses(1)[0]?.result).toBe(1);
    expect(a.responses(1)).toHaveLength(1);
    expect(a.responses(2)).toHaveLength(0);
    expect(effects).toEqual([1]);
  });

  test("owner transfer retires already accepted calls and routes notifications to the new owner", async () => {
    const { server, a, b, effects, resume } = fixture();
    a.request(1, "session/use", { sessionId, pause: true });
    server.notifySession(sessionId, "session/changed", { snapshot: 1 });
    server.setOwner(sessionId, 2);
    expect(a.responses(1)[0]?.error?.code).toBe(revoked);
    server.notifySession(sessionId, "session/changed", { snapshot: 2 });
    a.request(2, "session/use", { sessionId });
    b.request(1, "session/use", { sessionId });
    resume[0]();
    await tick();
    expect(a.responses(1)).toHaveLength(1);
    expect(a.responses(2)[0]?.error?.code).toBe(revoked);
    expect(b.responses(1)[0]?.result).toBe(2);
    expect(a.messages.filter((m) => "method" in m)).toEqual([
      { jsonrpc: "2.0", method: "session/changed", params: { snapshot: 1 } },
    ]);
    expect(b.messages.filter((m) => "method" in m)).toEqual([
      { jsonrpc: "2.0", method: "session/changed", params: { snapshot: 2 } },
    ]);
    expect(effects).toEqual([2]);
  });

  test("returning to an earlier owner never revives requests or clears a reused id", async () => {
    const { server, a, b, effects, resume } = fixture();
    a.request(1, "session/use", { sessionId, pause: true });
    server.setOwner(sessionId, 2);
    b.request(1, "session/use", { sessionId, pause: true });
    server.setOwner(sessionId, 1);
    a.request(1, "session/use", { sessionId, pause: true });
    resume[0]();
    resume[1]();
    await tick();
    expect(effects).toEqual([]);
    expect(a.responses(1)).toHaveLength(1);
    expect(b.responses(1)[0]?.error?.code).toBe(revoked);
    server.setOwner(sessionId, 1);
    resume[2]();
    await tick();
    expect(a.responses(1).map((r) => r.error?.code ?? r.result)).toEqual([revoked, 1]);
    expect(effects).toEqual([1]);
  });

  test("a pending delete invalidates in-flight grants, new calls, and notifications, including after rollback", async () => {
    const { server, a, b, effects, resume } = fixture();
    a.request(1, "session/use", { sessionId, pause: true });
    server.setDeleting(sessionId, true);
    server.notifySession(sessionId, "session/changed", {});
    a.request(2, "session/use", { sessionId });
    server.setOwner(sessionId, 2);
    b.request(1, "session/use", { sessionId });
    server.setDeleting(sessionId, false);
    b.request(2, "session/use", { sessionId });
    resume[0]();
    await tick();
    expect(a.responses(1).map((r) => r.error?.code)).toEqual([revoked]);
    expect(a.responses(2)[0]?.error?.code).toBe(revoked);
    expect(b.responses(1)[0]?.error?.code).toBe(revoked);
    expect(b.responses(2)[0]?.result).toBe(2);
    expect(a.messages.some((m) => "method" in m)).toBe(false);
    server.setOwner(sessionId, null);
    b.request(3, "session/use", { sessionId });
    expect(b.responses(3)[0]?.error?.code).toBe(revoked);
    expect(effects).toEqual([2]);
  });

  test("the hosted read returns the existing catalog and rejects unrelated arguments", async () => {
    const { listDesktopLinkProviders } = await import("../link-provider-catalog.js");
    const server = new DesktopHostServer(
      "0.12-test",
      desktopHostMethods(async () => ({ sessions: [], nextCursor: null })),
    );
    const port = connect(server, frame(1));
    port.request(1, "links/listLocalProviders", { sessionId });
    const reply = new Promise<void>((resolve) => port.once("result", resolve));
    port.request(2, "links/listLocalProviders");
    await reply;
    expect(port.responses(1)[0]?.error?.code).toBe(-32602);
    expect(port.responses(2)[0]?.result).toEqual(await listDesktopLinkProviders());
  });

  test("the workbench list uses the same bounded visible rows as the old IPC", async () => {
    const queries: unknown[] = [];
    const server = new DesktopHostServer(
      "test",
      desktopHostMethods(async (options) => {
        queries.push(options);
        return { sessions: [], nextCursor: null };
      }),
    );
    const port = connect(server, frame(1));
    port.request(1, "sessions/listDisk", {
      limit: 500,
      sessionId: "open",
      cursor: "30",
      cwds: ["another"],
      baseDir: "other-root",
      includeArchived: true,
      includeSubagents: true,
    });
    port.request(2, "sessions/listDisk", { parentSessionId: "." });
    port.request(3, "host/listDiskSessions", { limit: 200 });
    await tick();
    expect(queries).toEqual([
      { limit: 200, cursor: "30", parentSessionId: undefined, sessionId: "open" },
    ]);
    expect(port.responses(1)[0]?.result).toEqual({ sessions: [], nextCursor: null });
    expect(port.responses(2)[0]?.error?.code).toBe(-32602);
    expect(port.responses(3)[0]?.error?.code).toBe(-32601);
  });

  test("initialization negotiates the protocol before discovery and rejects unexpected port transfer", () => {
    const server = new DesktopHostServer(
      "0.12-test",
      desktopHostMethods(async () => ({ sessions: [], nextCursor: null })),
    );
    const port = new TestPort();
    server.bind(frame(1), port);
    expect(port.started).toBe(true);
    port.request(1, "links/listLocalProviders");
    port.request(2, "initialize", { protocolVersions: ["1.0"] });
    expect(port.responses(1)[0]?.error?.code).toBe(-32600);
    expect(port.responses(2)[0]?.error?.code).toBe(-32602);
    port.request(3, "initialize", { protocolVersions: ["2.0"] });
    expect(port.responses(3)[0]?.result).toMatchObject({
      protocolVersion: "2.0",
      host: { kind: "electron", version: "0.12-test" },
      methods: ["links/listLocalProviders", "sessions/listDisk"],
      contracts: expect.any(Object),
    });
    const extraPort = new TestPort();
    port.emit("message", { data: {}, ports: [extraPort] });
    expect(extraPort.closed).toBe(true);
    expect(port.closed).toBe(true);
  });
});

test("replacing a document revokes its waiting writes without undoing a committed decision", () => {
  const server = new DesktopHostServer("test", new Map());
  const first = frame(3);
  connect(server, first);
  const pending = server.reserveDocumentCommit(first);
  const committed = server.reserveDocumentCommit(first);
  expect(Atomics.compareExchange(committed.permit, 0, 0, 1)).toBe(0);
  connect(server, frame(3, 2));
  expect(Atomics.load(pending.permit, 0)).toBe(-1);
  expect(Atomics.load(committed.permit, 0)).toBe(1);
  expect(() => server.reserveDocumentCommit(first)).toThrow();
  pending.release();
  committed.release();
});

test("approval snapshots are scoped to the document's current sessions and worker generation", async () => {
  const { HostApprovalState } = await import("./approval-state.js");
  let now = 1;
  const state = new HostApprovalState(
    (id, owner) => server.allows(id, owner),
    () => now,
  );
  const server: DesktopHostServer = new DesktopHostServer(
    "test",
    new Map([["agent/pendingApprovals", state.method]]),
  );
  const first = connect(server, frame(1)),
    second = connect(server, frame(2));
  server.setOwner("mine", 1);
  server.setOwner("theirs", 2);
  const observe = (method: string, params: Record<string, unknown>) => {
    const message = { jsonrpc: "2.0", method, params };
    state.observe({ message, line: JSON.stringify(message) });
  };
  const request = (sessionId: string) =>
    observe("agent/approvalRequest", {
      sessionId,
      requestId: "r",
      expiresAt: 10,
      request: { toolName: "Read" },
    });
  const read = async (
    port: TestPort,
    id: number,
    since?: { epoch: string; stateVersion: number },
  ) => {
    port.request(id, "agent/pendingApprovals", since ? { since } : {});
    await tick();
    return port.responses(id)[0]!.result as {
      epoch: string;
      stateVersion: number;
      pending?: { sessionId: string }[];
    };
  };
  request("mine");
  const { HostBusinessCalls } = await import("../../host/composition/business-calls.js");
  const native = new HostBusinessCalls(state.native);
  expect(await native.run("read", "approvals/replay", {scope:"window", owner:2})).toEqual([]);
  await expect(native.run("deny", "approvals/resolve", {owner:2, sessionId:"mine", requestId:"r"})).rejects.toThrow();
  expect(await native.run("phone", "approvals/find", {sessionId:"mine", requestId:"r"})).toMatchObject({sessionId:"mine", requestId:"r"});
  const initial = await read(first, 1);
  expect(initial.pending?.map((p) => p.sessionId)).toEqual(["mine"]);
  const cursor = { epoch: initial.epoch, stateVersion: initial.stateVersion };
  request("theirs");
  expect(await read(first, 2, cursor)).toEqual(cursor);
  expect((await read(second, 3)).pending?.map((p) => p.sessionId)).toEqual(["theirs"]);
  server.setOwner("mine", 2);
  expect((await read(first, 4, cursor)).pending).toEqual([]);
  const both = await read(second, 5);
  expect(both.pending).toHaveLength(2);
  observe("agent/approvalResolved", { sessionId: "mine", requestId: "r" });
  expect((await read(second, 6)).pending).toHaveLength(1);
  now = 11;
  expect((await read(second, 7)).pending).toEqual([]);
  state.reset(2);
  expect((await read(first, 8, cursor)).epoch).not.toBe(initial.epoch);
});

test("unowned disk-history reads are withdrawn on ownership changes even after returning to unowned", async () => {
  const { HostSessionAuthority, HostPortAuthority } = await import("./authority.js");
  const sessions = new HostSessionAuthority();
  const a = new HostPortAuthority(
    { webContentsId: 1, frameGeneration: 1, frameToken: "one", windowKind: "workbench" },
    sessions,
  );
  const b = new HostPortAuthority(
    { webContentsId: 2, frameGeneration: 1, frameToken: "two", windowKind: "workbench" },
    sessions,
  );
  const first = a.captureHistoryRead("past");
  expect(first.historical).toBe(true);
  sessions.setOwner("past", 2);
  expect(() => a.captureHistoryRead("past")).toThrow();
  const owned = b.captureHistoryRead("past");
  expect(owned.historical).toBe(false);
  sessions.setOwner("past", null);
  expect(() => first.assertCurrent()).toThrow();
  expect(() => owned.assertCurrent()).toThrow();
  const fresh = a.captureHistoryRead("past");
  first.release?.();
  expect(() => fresh.assertCurrent()).not.toThrow();
  sessions.setDeleting("past", true);
  expect(() => fresh.assertCurrent()).toThrow();
  expect(() => b.captureHistoryRead("past")).toThrow();
  sessions.setDeleting("past", false);
  expect(() => fresh.assertCurrent()).toThrow();
  fresh.release?.();
});

test("only trusted, live shared views receive root-owned output and they never gain a session mutation grant", async () => {
  const { server, a, b } = fixture();
  server.setStreamView(sessionId, true);
  server.notifySession(sessionId, "agent/streamEvent", { sessionId });
  expect(a.messages.at(-1)).toHaveProperty("method", "agent/streamEvent");
  expect(b.messages.at(-1)).toHaveProperty("method", "agent/streamEvent");
  b.request(73, "session/use", { sessionId });
  await tick();
  expect(b.responses(73)[0]?.error?.code).toBe(revoked);
  server.setDeleting(sessionId, true);
  const count = a.messages.length;
  server.notifySession(sessionId, "agent/streamEvent", { sessionId });
  expect(a.messages.length).toBe(count);
  server.setStreamView(sessionId, false);
  server.setDeleting(sessionId, false);
  server.setOwner(sessionId, 2);
  server.notifySession(sessionId, "agent/streamEvent", { sessionId });
  expect(a.messages.length).toBe(count);
  expect(b.messages.at(-1)).toHaveProperty("method", "agent/streamEvent");
});

test("a shared output stream does not expose session files or configuration to spectators", async () => {
  let reads = 0;
  const server = new DesktopHostServer(
    "test",
    new Map([
      [
        "files/list",
        {
          historyRead: "operation" as const,
          sessionId: () => sessionId,
          run() {
            return ++reads;
          },
        },
      ],
    ]),
  );
  const owner = connect(server, frame(1));
  const spectator = connect(server, frame(2));
  server.setStreamView(sessionId, true);
  spectator.request(1, "files/list", { sessionId });
  await tick();
  expect(spectator.responses(1)[0]?.error?.code).toBe(revoked);
  server.setOwner(sessionId, 1);
  spectator.request(2, "files/list", { sessionId });
  owner.request(3, "files/list", { sessionId });
  await tick();
  expect(spectator.responses(2)[0]?.error?.code).toBe(revoked);
  expect(owner.responses(3)[0]?.result).toBe(1);
  expect(reads).toBe(1);
});

test("disk-history recovery checks visibility after I/O and legacy IPC uses the same frame grant", async () => {
  const snapshot = { epoch: "test", events: [], nextSeq: 1, topLevelRunning: false };
  let visible = true;
  let resolveRead: (() => void) | undefined;
  let reads = 0;
  const methods = outputMethods(
    async () => {
      reads++;
      await new Promise<void>((resolve) => {
        resolveRead = resolve;
      });
      return snapshot;
    },
    async () => ({ sessions: visible ? [{ id: sessionId, mtime: 1 }] : [], nextCursor: null }),
  );
  const server = new DesktopHostServer("test", methods);
  const a = connect(server, frame(1));
  const b = connect(server, frame(2));
  a.request(1, "agent/subscribe", { sessionId });
  await tick();
  visible = false;
  resolveRead!();
  await tick();
  expect(a.responses(1)[0]?.error?.code).toBe(revoked);
  b.request(2, "agent/subscribe", { sessionId });
  await tick();
  expect(b.responses(2)[0]?.error?.code).toBe(revoked);
  expect(reads).toBe(1);
  server.setOwner(sessionId, 1);
  const legacy = server.readWorkbenchOutput(frame(1), { sessionId });
  server.setOwner(sessionId, 2);
  server.setOwner(sessionId, 1);
  resolveRead!();
  await expect(legacy).rejects.toThrow("revoked");
  await expect(server.readWorkbenchOutput(frame(2), { sessionId })).rejects.toThrow("revoked");
  await expect(server.readWorkbenchOutput(frame(1, 2), { sessionId })).rejects.toThrow("revoked");
});

test("disk-history reads admit an archived session the workbench opened from the archive", async () => {
  const snapshot = { epoch: "test", events: [], nextSeq: 1, topLevelRunning: false };
  const queries: Array<Record<string, unknown>> = [];
  const methods = outputMethods(
    async () => snapshot,
    async (options) => {
      queries.push({ ...options });
      // The catalog hides archived rows unless the caller opts in.
      return {
        sessions: options.includeArchived ? [{ id: sessionId, mtime: 1, archivedAt: 1 }] : [],
        nextCursor: null,
      };
    },
  );
  const server = new DesktopHostServer("test", methods);
  const a = connect(server, frame(1));
  a.request(1, "agent/subscribe", { sessionId });
  await tick();
  expect(a.responses(1)[0]?.error).toBeUndefined();
  expect(a.responses(1)[0]?.result).toEqual(snapshot);
  expect(queries.every((query) => query.includeArchived === true)).toBe(true);
});

test("host visibility counts archived sessions but not deleted or foreign rows", async () => {
  const rows: Record<string, { archivedAt?: number }> = { live: {}, archived: { archivedAt: 1 } };
  const list = async (options: { sessionId?: string; includeArchived?: boolean }) => {
    const row = options.sessionId ? rows[options.sessionId] : undefined;
    const shown = row && (row.archivedAt === undefined || options.includeArchived);
    return {
      sessions: shown ? [{ id: options.sessionId!, mtime: 1, ...row }] : [],
      nextCursor: null,
    };
  };
  expect(await hostSessionVisible(list as never, "live")).toBe(true);
  expect(await hostSessionVisible(list as never, "archived")).toBe(true);
  expect(await hostSessionVisible(list as never, "deleted")).toBe(false);
  // A catalog row for another id never stands in for the requested session.
  const wrong = async () => ({ sessions: [{ id: "other", mtime: 1 }], nextCursor: null });
  expect(await hostSessionVisible(wrong as never, "live")).toBe(false);
});
