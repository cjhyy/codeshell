import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import {
  DesktopHostErrors,
  type DesktopHostIdentity,
  type RpcNotification,
  type RpcResponse,
} from "../../shared/desktop-host-protocol.js";
import { DesktopHostServer, type DesktopHostMethod } from "./server.js";

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
    const server = new DesktopHostServer("0.12-test");
    const port = connect(server, frame(1));
    port.request(1, "links/listLocalProviders", { sessionId });
    const reply = new Promise<void>((resolve) => port.once("result", resolve));
    port.request(2, "links/listLocalProviders");
    await reply;
    expect(port.responses(1)[0]?.error?.code).toBe(-32602);
    expect(port.responses(2)[0]?.result).toEqual(await listDesktopLinkProviders());
  });

  test("initialization negotiates the protocol before discovery and rejects unexpected port transfer", () => {
    const server = new DesktopHostServer("0.12-test");
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
      methods: ["links/listLocalProviders"],
      contracts: expect.any(Object),
    });
    const extraPort = new TestPort();
    port.emit("message", { data: {}, ports: [extraPort] });
    expect(extraPort.closed).toBe(true);
    expect(port.closed).toBe(true);
  });
});
