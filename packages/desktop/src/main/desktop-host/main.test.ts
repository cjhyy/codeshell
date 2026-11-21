import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { MessageChannelMain, UtilityProcess, WebContents, WebFrameMain } from "electron";
import { DesktopHostIpc, type DesktopHostControl } from "../../shared/desktop-host-protocol.js";
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
