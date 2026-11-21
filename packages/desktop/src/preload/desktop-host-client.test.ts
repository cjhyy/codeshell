import { afterEach, expect, test } from "bun:test";
import { DesktopHostClient, routeLocalProviders } from "./desktop-host-client";
import type { DesktopHostStatus } from "./types";
import { DesktopHostErrors, type RpcRequest } from "../shared/desktop-host-protocol";

const capabilities = {
  protocolVersion: "2.0",
  host: { kind: "electron", version: "0.12.0" },
  methods: ["links/listLocalProviders"],
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function clientWithStatus(timeoutMs?: number) {
  const client = new DesktopHostClient(timeoutMs);
  const statuses: DesktopHostStatus[] = [];
  const unsubscribe = client.subscribe((status) => statuses.push(status));
  cleanups.push(unsubscribe, () => client.disconnect("unavailable"));
  return { client, statuses };
}

function nextRequest(port: MessagePort): Promise<RpcRequest> {
  return new Promise((resolve) => {
    port.addEventListener("message", ({ data }: MessageEvent<RpcRequest>) => resolve(data), {
      once: true,
    });
    port.start();
  });
}

async function attach(client: DesktopHostClient, result: unknown = capabilities) {
  const { port1, port2 } = new MessageChannel();
  cleanups.push(() => port2.close());
  const request = nextRequest(port2);
  const attached = client.attach(port1);
  const hello = await request;
  expect(hello).toEqual({
    id: expect.any(Number),
    jsonrpc: "2.0",
    method: "initialize",
    params: { protocolVersions: ["2.0"] },
  });
  port2.postMessage({ jsonrpc: "2.0", id: hello.id, result });
  await attached;
  return port2;
}

test("the first read waits for initialize and sends only the provider method", async () => {
  const { client, statuses } = clientWithStatus();
  const providers = client.listLocalProviders();
  const host = await attach(client);
  const request = await nextRequest(host);
  expect(request).toEqual({
    jsonrpc: "2.0",
    id: expect.any(Number),
    method: "links/listLocalProviders",
  });
  host.postMessage({ jsonrpc: "2.0", id: request.id, result: [{ id: "fixture" }] });
  expect(await providers).toEqual([{ id: "fixture" }]);
  expect(statuses).toEqual(["connecting", "ready"]);
});

test("losing a port rejects outstanding calls and does not replay them on the new port", async () => {
  const { client, statuses } = clientWithStatus();
  const oldHost = await attach(client);
  const oldRequest = nextRequest(oldHost);
  const before = client.listLocalProviders().catch((error: Error) => error);
  const sent = await oldRequest;
  client.disconnect("reconnecting");
  expect(await before).toMatchObject({ code: DesktopHostErrors.reconnecting });
  await expect(client.listLocalProviders()).rejects.toMatchObject({
    code: DesktopHostErrors.reconnecting,
  });
  oldHost.postMessage({ jsonrpc: "2.0", id: sent.id, result: [{ id: "stale" }] });
  const newHost = await attach(client);
  const newRequest = nextRequest(newHost);
  const after = client.listLocalProviders();
  const { id } = await newRequest;
  expect(id).not.toBe(sent.id);
  newHost.postMessage({ jsonrpc: "2.0", id, result: [{ id: "new" }] });
  expect(await after).toEqual([{ id: "new" }]);
  expect(statuses).toEqual(["connecting", "ready", "reconnecting", "ready"]);
});

test("incompatible capabilities disable the route until a new port initializes", async () => {
  const { client, statuses } = clientWithStatus();
  const early = client.listLocalProviders().catch((error: Error) => error);
  await attach(client, { ...capabilities, methods: [] });
  expect(await early).toMatchObject({ code: DesktopHostErrors.reconnecting });
  await expect(client.listLocalProviders()).rejects.toThrow("unavailable");
  await attach(client);
  expect(statuses).toEqual(["connecting", "unavailable", "reconnecting", "ready"]);
});

test("a missing port and an unresponsive host both have deadlines", async () => {
  const { client, statuses } = clientWithStatus(80);
  await expect(client.listLocalProviders()).rejects.toThrow("unavailable");
  await attach(client);
  await expect(client.listLocalProviders()).rejects.toThrow("timed out");
  expect(statuses).toEqual(["connecting", "unavailable", "reconnecting", "ready"]);
});

test("auxiliary windows and a rolled-back domain use the original IPC handler", async () => {
  const { client } = clientWithStatus();
  const ipc = async () => [];
  expect(routeLocalProviders(undefined, ipc)).toBe(ipc);
  expect(routeLocalProviders(client, ipc, "ipc")).toBe(ipc);
  client.disconnect("reconnecting");
  await expect(routeLocalProviders(client, ipc, "host")()).rejects.toThrow("reconnecting");
});

test("a new binding supersedes in-flight replies from the previous port", async () => {
  const { client } = clientWithStatus();
  const oldPort = await attach(client);
  const first = nextRequest(oldPort);
  const dropped = client.listLocalProviders().catch((error: Error) => error);
  await first;
  const current = await attach(client);
  expect(await dropped).toMatchObject({ code: DesktopHostErrors.revoked });
  const firstRequest = nextRequest(current);
  const a = client.listLocalProviders();
  const one = await firstRequest;
  const secondRequest = nextRequest(current);
  const b = client.listLocalProviders().catch((error: Error) => error);
  const two = await secondRequest;
  current.postMessage({
    jsonrpc: "2.0",
    id: two.id,
    error: { code: -32603, message: "Catalog unavailable" },
  });
  current.postMessage({ jsonrpc: "2.0", id: one.id, result: [{ id: "current" }] });
  expect(await b).toMatchObject({ code: -32603 });
  expect(await a).toEqual([{ id: "current" }]);
});

test("disk pages use the private port and read IPC only on unavailable transport", async () => {
  const { client } = clientWithStatus();
  const host = await attach(client, {
    ...capabilities,
    methods: [...capabilities.methods, "sessions/listDisk"],
  });
  const options = { limit: 3, parentSessionId: "parent" };
  const fallbackCalls: unknown[] = [];
  const fallback = async (opts: unknown) => {
    fallbackCalls.push(opts);
    return { sessions: [], nextCursor: "ipc" };
  };
  const sent = nextRequest(host);
  const read = client.listDiskSessions(options, fallback);
  const request = await sent;
  expect(request).toMatchObject({ method: "sessions/listDisk", params: options });
  host.postMessage({
    jsonrpc: "2.0",
    id: request.id,
    result: { sessions: [], nextCursor: "host" },
  });
  expect((await read).nextCursor).toBe("host");

  const pending = nextRequest(host);
  const revoked = client.listDiskSessions(options, fallback).catch((error: Error) => error);
  const { id } = await pending;
  host.postMessage({
    jsonrpc: "2.0",
    id,
    error: { code: DesktopHostErrors.revoked, message: "Revoked" },
  });
  expect(await revoked).toMatchObject({ code: DesktopHostErrors.revoked });
  expect(fallbackCalls).toEqual([]);

  const inflight = nextRequest(host);
  const fallbackRead = client.listDiskSessions(options, fallback);
  await inflight;
  client.disconnect("reconnecting");
  expect((await fallbackRead).nextCursor).toBe("ipc");
  expect(fallbackCalls).toEqual([options]);
});

test("task reads negotiate each capability and preserve the Host's authoritative errors", async () => {
  const { client } = clientWithStatus();
  const fromIpc: string[] = [];
  const listIpc = async () => {
    fromIpc.push("list");
    return { version: 1, records: [], errors: [] };
  };
  const getIpc = async () => {
    fromIpc.push("get");
    return null;
  };
  await client.listTasks(undefined, listIpc);
  const host = await attach(client, {
    ...capabilities,
    methods: [...capabilities.methods, "tasks/list"],
  });
  await client.getTask("session:one", getIpc);
  for (const code of [DesktopHostErrors.revoked, -32602, -32601]) {
    const sent = nextRequest(host);
    const result = client.listTasks({ visibility: "hidden" }, listIpc).catch((error) => error);
    const request = await sent;
    expect(request).toMatchObject({ method: "tasks/list", params: { visibility: "hidden" } });
    host.postMessage({
      jsonrpc: "2.0",
      id: request.id,
      error: { code, message: "Task read rejected" },
    });
    expect(await result).toMatchObject({ code });
  }
  const upgraded = await attach(client, {
    ...capabilities,
    methods: [...capabilities.methods, "tasks/get", "tasks/list"],
  });
  const sent = nextRequest(upgraded);
  const pending = client.getTask("session:one", getIpc);
  expect(await sent).toMatchObject({ method: "tasks/get", params: { taskKey: "session:one" } });
  client.disconnect("reconnecting");
  expect(await pending).toBeNull();
  expect(fromIpc).toEqual(["list", "get", "get"]);
});

test("a negotiated stream arrives on the port while its subscription snapshot is outstanding", async () => {
  const { client } = clientWithStatus();
  const host = await attach(client, {
    ...capabilities,
    methods: [...capabilities.methods, "agent/subscribe"],
  });
  const events: unknown[] = [];
  const off = client.onStreamEvent((env) => events.push(env));
  const next = nextRequest(host);
  const read = client.subscribeSession("s", 2, async () => {
    throw new Error("unexpected IPC");
  });
  const req = await next;
  expect(req).toMatchObject({ method: "agent/subscribe", params: { sessionId: "s", sinceSeq: 2 } });
  const live = {
    sessionId: "s",
    epoch: "stream-1",
    seq: 3,
    event: { type: "text_delta", text: "live" },
  };
  host.postMessage({ jsonrpc: "2.0", method: "agent/streamEvent", params: live });
  host.postMessage({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      epoch: "stream-1",
      nextSeq: 4,
      events: [{ seq: 3, event: live.event }],
      outputCursor: "opaque-journal-cursor",
    },
  });
  expect((await read).outputCursor).toBe("opaque-journal-cursor");
  expect(events).toEqual([live]);
  off();
  const barrier = nextRequest(host);
  const done = client.subscribeSession("s", 3, async () => {
    throw new Error("unexpected IPC");
  });
  const empty = await barrier;
  host.postMessage({ jsonrpc: "2.0", method: "agent/streamEvent", params: live });
  host.postMessage({ jsonrpc: "2.0", id: empty.id, result: { nextSeq: 4, events: [] } });
  await done;
  expect(events).toEqual([live]);
});

test("approval resume uses its own epoch and version and retains only external approvals from Main", async () => {
  const { client } = clientWithStatus();
  const host = await attach(client, {
    ...capabilities,
    methods: [...capabilities.methods, "agent/pendingApprovals"],
  });
  const native = { requestId: "native", sessionId: "s", request: { toolName: "write" } };
  const external = { ...native, source: "external-runtime" as const, requestId: "external" };
  const legacy = async () => [external, { ...native, requestId: "stale-main-native" }] as any[];
  const respond = async (expectedParams: unknown, result: unknown) => {
    const next = nextRequest(host);
    const read = client.pendingApprovals(legacy);
    const req = await next;
    expect(req).toMatchObject({ method: "agent/pendingApprovals", params: expectedParams });
    host.postMessage({ jsonrpc: "2.0", id: req.id, result });
    return read;
  };
  expect(await respond({}, { epoch: "worker-1", stateVersion: 9, pending: [native] })).toEqual([
    native,
    external,
  ]);
  const since = { since: { epoch: "worker-1", stateVersion: 9 } };
  expect(await respond(since, { epoch: "worker-1", stateVersion: 9 })).toEqual([native, external]);
  await expect(respond(since, { epoch: "worker-2", stateVersion: 1 })).rejects.toThrow("snapshot");
  expect(await respond(since, { epoch: "worker-2", stateVersion: 1, pending: [] })).toEqual([
    external,
  ]);
});

test("an established agent grant cannot downgrade to Main when its Host connection is lost", async () => {
  const { client } = clientWithStatus();
  const host = await attach(client, {
    ...capabilities,
    methods: [...capabilities.methods, "agent/subscribe", "agent/pendingApprovals"],
  });
  let reads = 0;
  const legacy = async () => {
    reads++;
    return [];
  };
  const next = nextRequest(host);
  const inflight = client
    .subscribeSession("s", 0, async () => {
      reads++;
      return { events: [], nextSeq: 0 };
    })
    .catch((error) => error);
  await next;
  client.disconnect("reconnecting");
  expect(await inflight).toMatchObject({ code: DesktopHostErrors.reconnecting });
  await expect(client.pendingApprovals(legacy)).rejects.toMatchObject({
    code: DesktopHostErrors.reconnecting,
  });
  await expect(
    client.subscribeSession("s", 0, async () => {
      reads++;
      return { events: [], nextSeq: 0 };
    }),
  ).rejects.toMatchObject({ code: DesktopHostErrors.reconnecting });
  expect(reads).toBe(0);
});

test("negotiated commands use named methods and keep caller-local ids and worker error data", async () => {
  const { client } = clientWithStatus();
  const host = await attach(client, {
    ...capabilities,
    methods: [...capabilities.methods, "agent/cancel"],
  });
  const rpc = client.agentCommand("agent/cancel", { sessionId: "s1" }, 60, "caller-id", () => {
    throw new Error("unexpected fallback");
  });
  const request = await nextRequest(host);
  expect(request).toEqual({
    jsonrpc: "2.0",
    id: expect.any(Number),
    method: "agent/cancel",
    params: { sessionId: "s1" },
  });
  const error = { code: -32001, message: "worker detail", data: { sessionId: "s1" } };
  host.postMessage({ jsonrpc: "2.0", id: request.id, error });
  expect(await rpc).toEqual({ jsonrpc: "2.0", id: "caller-id", error });
});

test("long runs have no clock timeout and reject on disconnect without IPC retry", async () => {
  const { client } = clientWithStatus(10);
  const host = await attach(client, {
    ...capabilities,
    methods: [...capabilities.methods, "agent/run"],
  });
  const ipc = () => {
    throw new Error("unexpected fallback");
  };
  const first = client.agentCommand("agent/run", { task: "a" }, 0, "long", ipc);
  const request = await nextRequest(host);
  await new Promise((r) => setTimeout(r, 24));
  host.postMessage({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
  expect((await first).result).toEqual({ ok: true });
  const pending = client.agentCommand("agent/run", { task: "b" }, 0, "next", ipc);
  await nextRequest(host);
  client.disconnect("reconnecting");
  await expect(pending).rejects.toThrow("-32011");
  await expect(client.agentCommand("agent/run", {}, 0, "again", ipc)).rejects.toThrow("-32011");
});

test("old Hosts use existing IPC and a negotiated request honors its own deadline", async () => {
  const { client } = clientWithStatus();
  const ipc = async () => ({ jsonrpc: "2.0" as const, id: "legacy", result: "old host" });
  await attach(client);
  expect((await client.agentCommand("agent/configure", {}, 40, "id", ipc)).result).toBe("old host");
  await attach(client, { ...capabilities, methods: [...capabilities.methods, "agent/configure"] });
  await expect(client.agentCommand("agent/configure", {}, 5, "id", ipc)).rejects.toThrow(
    "timed out",
  );
});
