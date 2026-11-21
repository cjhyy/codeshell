import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { MessageChannelMain, UtilityProcess, WebContents, WebFrameMain } from "electron";
import { DesktopHostIpc, type DesktopHostControl } from "../../shared/desktop-host-protocol.js";
import { DesktopHostWorkerClient } from "./main-worker.js";
import type { WorkerCommand, WorkerNotice } from "./worker-wire.js";
import { DesktopHostSupervisor } from "./main-supervisor.js";
import { HostWorkbenchPorts } from "./main-workbenches.js";

class TestChild extends EventEmitter {
  messages: unknown[] = [];
  killed = false;
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  kill() {
    this.killed = true;
    return true;
  }
}

function processFixture() {
  let now = 0;
  let timer: { run(): void; delay: number } | undefined;
  const statuses: string[] = [];
  const children: TestChild[] = [];
  const supervisor = new DesktopHostSupervisor(
    () => {
      const child = new TestChild();
      children.push(child);
      return child as unknown as UtilityProcess;
    },
    () => "0.12.0",
    (status) => statuses.push(status),
    () => {},
    (callback, delay) => {
      const registration = { run: callback, delay };
      timer = registration;
      return () => {
        if (timer === registration) timer = undefined;
      };
    },
    () => now,
  );
  const advance = () => {
    const next = timer!;
    timer = undefined;
    now += next.delay;
    next.run();
    return next.delay;
  };
  supervisor.start();
  return { supervisor, statuses, children, advance, timer: () => timer };
}

describe("Desktop Host process", () => {
  test("only answers the version reverse RPC, including before ready", () => {
    const { children } = processFixture();
    const child = children[0]!;
    child.emit("message", { jsonrpc: "2.0", id: 1, method: "app/getVersion" });
    child.emit("message", { jsonrpc: "2.0", id: 2, method: "other" });
    child.emit("message", {
      jsonrpc: "2.0",
      id: 3,
      method: "app/getVersion",
      params: { extra: true },
    });
    expect(child.messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: "0.12.0" },
      { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } },
      { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Invalid params" } },
    ]);
  });

  test("cancelling a scheduled run waits for the original Host to finish its Engine cleanup", async () => {
    const { supervisor, children } = processFixture();
    const child = children[0]!;
    child.emit("message", { type: "ready" });
    const abort = new AbortController();
    const result = supervisor.callBusiness(
      "automation/command",
      { method: "cancel", input: "cron" },
      abort.signal,
    );
    const request = child.messages.at(-1) as { id: string };
    let finished = false;
    const settled = result.catch(() => {
      finished = true;
    });
    abort.abort();
    await Promise.resolve();
    expect(child.messages.at(-1)).toEqual({ type: "withdraw-business", id: request.id });
    expect(finished).toBe(false);
    child.emit("message", {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603, message: "Cancelled" },
    });
    await settled;
    expect(finished).toBe(true);
  });

  test("replays current ownership and deletions before offering ports on every fresh host", () => {
    const { supervisor, children, statuses, advance } = processFixture();
    supervisor.setOwner("a", 4);
    supervisor.setDeleting("a", true);
    const first = children[0]!;
    expect(first.messages).toEqual([]);
    first.emit("message", { type: "ready" });
    expect(first.messages).toEqual([
      { type: "owner", sessionId: "a", webContentsId: 4 },
      { type: "deleting", sessionId: "a", deleting: true },
    ]);
    supervisor.setOwner("a", 6);
    supervisor.setOwner("a", 4);
    expect(first.messages.slice(-2)).toEqual([
      { type: "owner", sessionId: "a", webContentsId: 6 },
      { type: "owner", sessionId: "a", webContentsId: 4 },
    ]);
    first.emit("exit", 1);
    supervisor.setOwner("a", null);
    supervisor.setOwner("b", 6);
    supervisor.setDeleting("a", false);
    advance();
    first.emit("message", { type: "ready" });
    expect(statuses).toEqual(["ready", "reconnecting"]);
    const second = children[1]!;
    second.emit("message", { type: "ready" });
    second.emit("message", { type: "ready" });
    expect(second.messages).toEqual([{ type: "owner", sessionId: "b", webContentsId: 6 }]);
    expect(statuses).toEqual(["ready", "reconnecting", "ready"]);
  });

  test("retires a child that missed an authority update before accepting further messages", () => {
    const { supervisor, children, statuses } = processFixture();
    const child = children[0]!;
    child.emit("message", { type: "ready" });
    child.postMessage = () => {
      throw new Error("closed pipe");
    };
    supervisor.setOwner("a", 6);
    child.emit("message", { type: "ready" });
    expect(child.killed).toBe(true);
    expect(statuses).toEqual(["ready", "reconnecting"]);
    expect(supervisor.post({ type: "owner", sessionId: "a", webContentsId: null })).toBe(false);
  });

  test("recovers after a hung startup and limits restarts to three in a rolling minute", async () => {
    const { supervisor, children, statuses, advance, timer } = processFixture();
    expect(advance()).toBe(15_000);
    expect(children[0]!.killed).toBe(true);
    children[0]!.emit("exit", 1);
    for (const delay of [250, 500, 1000]) {
      expect(advance()).toBe(delay);
      children.at(-1)!.emit("exit", 1);
    }
    expect(statuses.at(-1)).toBe("unavailable");
    expect(children).toHaveLength(4);
    expect(advance()).toBe(58_500);
    expect(children).toHaveLength(5);
    const stopped = supervisor.dispose();
    const last = children.at(-1)!;
    expect(last.killed).toBe(true);
    last.emit("exit", 0);
    await stopped;
    expect(timer()).toBeUndefined();
    supervisor.start();
    expect(children).toHaveLength(5);
  });
});

function fakeFrame(frameToken: string) {
  const ports: unknown[] = [];
  const statuses: unknown[] = [];
  const frame = {
    frameToken,
    detached: false,
    postMessage: (channel: string, _data: unknown, resources: unknown[]) => {
      expect(channel).toBe(DesktopHostIpc.port);
      ports.push(...resources);
    },
    send: (channel: string, status: unknown) => {
      expect(channel).toBe(DesktopHostIpc.status);
      statuses.push(status);
    },
  };
  return { frame: frame as unknown as WebFrameMain, ports, statuses };
}

function fakeWindow(id: number, frame: WebFrameMain) {
  const contents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: frame,
    isDestroyed: () => false,
  });
  return { contents, sender: contents as unknown as WebContents };
}

test("a workbench opened during cold startup waits for the first Host before receiving a port", () => {
  const { frame, ports, statuses } = fakeFrame("cold-start");
  const { sender, contents } = fakeWindow(1, frame);
  const windows = new HostWorkbenchPorts(
    () => {},
    () => ({ port1: { close() {} }, port2: { close() {} } }) as unknown as MessageChannelMain,
    () => true,
  );
  windows.track(sender);
  contents.emit("did-navigate");
  windows.connect({ sender, senderFrame: frame });
  expect(statuses).toEqual([]);
  expect(ports).toHaveLength(0);
  windows.setStatus("ready");
  expect(statuses).toEqual([]);
  expect(ports).toHaveLength(1);

  windows.setStatus("reconnecting");
  expect(statuses).toEqual(["reconnecting"]);
  windows.setStatus("ready");
  expect(ports).toHaveLength(2);
});

test("only a connected, current, committed workbench main frame gets a port", () => {
  const first = fakeFrame("one");
  const guest = fakeFrame("guest");
  const { sender, contents } = fakeWindow(11, first.frame);
  const controls: DesktopHostControl[] = [];
  let trustedDocument = true;
  const windows = new HostWorkbenchPorts(
    () => {
      if (!trustedDocument) throw new Error("untrusted document");
    },
    () => ({ port1: { close() {} }, port2: { close() {} } }) as unknown as MessageChannelMain,
    (control) => {
      controls.push(control);
      return true;
    },
  );
  windows.track(sender);
  windows.setStatus("ready");
  const guestWindow = fakeWindow(12, guest.frame);
  windows.connect({ sender: guestWindow.sender, senderFrame: guest.frame });
  windows.connect({ sender, senderFrame: guest.frame });
  windows.connect({ sender, senderFrame: first.frame });
  expect(controls).toEqual([]);
  trustedDocument = false;
  contents.emit("did-navigate");
  expect(controls).toEqual([]);
  trustedDocument = true;
  windows.connect({ sender, senderFrame: first.frame });
  windows.connect({ sender, senderFrame: first.frame });
  expect(first.ports).toHaveLength(1);
  expect(controls[0]).toEqual({
    type: "bind",
    identity: { webContentsId: 11, frameToken: "one", frameGeneration: 1, windowKind: "workbench" },
  });
  contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  expect(controls).toHaveLength(1);
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  expect(controls[1]).toEqual({ ...controls[0], type: "revoke" });
  windows.connect({ sender, senderFrame: first.frame });
  const second = fakeFrame("two");
  contents.mainFrame = second.frame;
  contents.emit("did-navigate");
  expect(second.ports).toHaveLength(0);
  windows.connect({ sender, senderFrame: second.frame });
  expect(controls[2]).toEqual({
    type: "bind",
    identity: { webContentsId: 11, frameToken: "two", frameGeneration: 2, windowKind: "workbench" },
  });
  windows.setStatus("reconnecting");
  expect(second.statuses).toEqual(["reconnecting"]);
  expect(first.statuses).toEqual([]);
  windows.setStatus("ready");
  expect(second.ports).toHaveLength(2);
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  expect(controls.at(-1)).toEqual({ ...controls[2], type: "revoke" });
  contents.emit("did-stop-loading");
  expect(second.ports).toHaveLength(3);
  const renewed = controls.at(-1)!;
  expect(renewed).toEqual({
    type: "bind",
    identity: { webContentsId: 11, frameToken: "two", frameGeneration: 3, windowKind: "workbench" },
  });
  contents.emit("destroyed");
  expect(controls.at(-1)).toEqual({ ...renewed, type: "revoke" });
  windows.connect({ sender, senderFrame: second.frame });
  expect(second.ports).toHaveLength(3);
  expect(guest.ports).toHaveLength(0);
});

test("Main keeps the authorized catalog query intact and settles every read on exit", async () => {
  const { supervisor, children } = processFixture();
  const child = children[0]!;
  const query = { limit: 100, cwds: ["/phone/current"], cursor: "25" };
  await expect(supervisor.listDiskSessions(query)).rejects.toThrow("unavailable");
  child.emit("message", { type: "ready" });
  const first = supervisor.listDiskSessions(query);
  const sent = child.messages.at(-1) as { id: string };
  expect(sent).toEqual({
    id: expect.any(String),
    jsonrpc: "2.0",
    method: "host/listDiskSessions",
    params: query,
  });
  child.emit("message", {
    jsonrpc: "2.0",
    id: sent.id,
    result: { sessions: [], nextCursor: "26" },
  });
  expect(await first).toEqual({ sessions: [], nextCursor: "26" });
  const unfinished = supervisor
    .listDiskSessions({ limit: 100, includeSubagents: true })
    .catch((error: Error) => error);
  child.emit("exit", 1);
  expect(await unfinished).toBeInstanceOf(Error);
});

class WorkerTestPort extends EventEmitter {
  commands: WorkerCommand[] = [];
  start() {}
  close() {}
  postMessage(command: WorkerCommand) {
    this.commands.push(command);
  }
  notice(data: WorkerNotice) {
    this.emit("message", { data, ports: [] });
  }
}

test("a native reply and an outstanding call cannot cross a worker or Host replacement", async () => {
  const client = new DesktopHostWorkerClient({
    entryPath: "/owned/agent.mjs",
    buildEnv: () => ({}),
  });
  const startup = client.waitForFirstBinding();
  const first = new WorkerTestPort();
  client.bind(first);
  await startup;
  client.ensureWorker("/owned");
  const release = Promise.withResolvers<void>();
  const staleWrite = Promise.withResolvers<boolean>();
  client.subscribeLines(() => {
    void release.promise.then(() => staleWrite.resolve(client.sendLine("late reply")));
  });
  first.notice({ type: "line", generation: 1, line: "private prompt" });
  const call = client.request(
    "agent/query",
    {},
    { id: "one", timeoutMs: 30_000, meta: { origin: "host", producer: "owned test" } },
  );
  const second = new WorkerTestPort();
  client.bind(second);
  expect(await call).toEqual({ status: "workerExit" });
  client.ensureWorker("/owned");
  expect(client.workerGeneration()).toBe(2);
  release.resolve();
  expect(await staleWrite.promise).toBe(false);
  expect(second.commands.map((command) => command.type)).toEqual(["start"]);
  expect(client.sendLine("current")).toBe(true);
  expect(second.commands.at(-1)).toEqual({ type: "write", generation: 2, line: "current" });
});

test("Host worker expiry and replacement suppress writes still waiting for credentials", async () => {
  const queued: (() => boolean)[] = [];
  const client = new DesktopHostWorkerClient({
    entryPath: "/internal/worker",
    dispatchInput: (_generation, _line, send) => {
      queued.push(send);
      return true;
    },
  });
  const port = new WorkerTestPort();
  client.bind(port);
  client.ensureWorker("/internal");
  const req = client.request(
    "agent/run",
    {},
    { id: "fixture", timeoutMs: 10, failFast: true, meta: { origin: "host", producer: "test" } },
  );
  expect(await req).toEqual({ status: "timeout" });
  expect(queued.shift()!()).toBe(false);
  client.sendLine("prior generation");
  const next = new WorkerTestPort();
  client.bind(next);
  client.ensureWorker("/internal");
  expect(queued.shift()!()).toBe(false);
  expect(port.commands.map((c) => c.type)).toEqual(["start"]);
  expect(next.commands.map((c) => c.type)).toEqual(["start"]);
});

test("committed settings refresh once even if the original document withdraws", async () => {
  const { supervisor, children } = processFixture();
  const child = children[0]!;
  child.emit("message", { type: "ready" });
  const flags = {
    panelApps: false,
    git: true,
    pet: false,
    externalVisibility: false,
    pluginCommands: false,
  };
  const changes = [] as (typeof flags)[];
  const completion = Promise.withResolvers<void>();
  supervisor.settingsCommitted = async (change) => {
    changes.push(change);
    await completion.promise;
  };
  const signal = new AbortController();
  const request = supervisor.callBusiness(
    "settings/patch",
    { scope: "user", patch: { git: {} } },
    signal.signal,
  );
  const sent = child.messages.at(-1) as { id: string };
  signal.abort();
  await expect(request).rejects.toThrow("document changed");
  child.emit("message", { type: "settings-committed", requestId: sent.id, effects: flags });
  child.emit("message", { jsonrpc: "2.0", id: sent.id, result: null });
  await Promise.resolve();
  expect(changes).toEqual([flags]);
  completion.resolve();
});

test("private operation key preparation reads the fixed ledger and discards a late reply after Host restart", async () => {
  const { children, supervisor, advance } = processFixture();
  const entered = Promise.withResolvers<void>(),
    unlocked = Promise.withResolvers<void>();
  const first = children[0]!;
  const request = {
    jsonrpc: "2.0",
    method: "app/operationLedgerKey",
    id: "host:run-key:1",
    params: { create: false },
  };
  const key = { wrapped: "enc:synthetic:test", secret: "1".repeat(64) };
  supervisor.prepareRunKey = async (wrapped, create) => {
    expect(wrapped).toBe(key.wrapped);
    expect(create).toBe(false);
    entered.resolve();
    await unlocked.promise;
    return key;
  };
  first.emit("message", { type: "ready" });
  first.emit("message", { ...request, params: { create: false, wrapped: "caller-selected" } });
  expect(first.messages.at(-1)).toMatchObject({ error: { code: -32601 } });
  first.emit("message", request);
  const read = first.messages.at(-1) as { method: string; id: string; params: object };
  expect(read).toMatchObject({ method: "host/readOperationWrappedKey", params: {} });
  first.emit("message", { jsonrpc: "2.0", id: read.id, result: key.wrapped });
  await entered.promise;
  first.emit("exit", 1);
  advance();
  children[1]!.emit("message", { type: "ready" });
  unlocked.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  for (const child of children) expect(JSON.stringify(child.messages)).not.toContain(key.secret);
});

test("native recovery authorization expires on owner or deletion ABA and Host exit", () => {
  const { supervisor, children } = processFixture();
  children[0]!.emit("message", { type: "ready" });
  const pending = supervisor.watchOperationOwner("fixture", 4);
  supervisor.setOwner("fixture", 4);
  supervisor.setOwner("fixture", null);
  expect(pending.signal.aborted).toBe(true);
  supervisor.setOwner("fixture", 4);
  expect(() => supervisor.watchOperationOwner("fixture", 5)).toThrow();
  const next = supervisor.watchOperationOwner("fixture", 4);
  supervisor.setDeleting("fixture", true);
  supervisor.setDeleting("fixture", false);
  expect(next.signal.aborted).toBe(true);
  const last = supervisor.watchOperationOwner("fixture", 4);
  children[0]!.emit("exit", 1);
  expect(last.signal.aborted).toBe(true);
});
