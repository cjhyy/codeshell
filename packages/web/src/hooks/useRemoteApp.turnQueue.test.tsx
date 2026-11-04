import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MobileTurnQueueState } from "@cjhyy/code-shell-core";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { initialChatState } from "../lib/streamReducer";
import { useRemoteApp, type RemoteApp } from "./useRemoteApp";
import { useDesktopController } from "../../app/DesktopApp.js";
import { DesktopChatControls } from "../../app/DesktopControls.js";
import { TurnQueueList } from "../../app/TurnQueueList.js";
import type { WorkbenchTurnQueue } from "../../app/workbench-types.js";

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

let restore: (() => void) | undefined;

function define(target: object, key: PropertyKey, descriptor: PropertyDescriptor): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  return () => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  };
}

function setupBrowser(): void {
  ensureMiniDom();
  restore?.();
  FakeWebSocket.instances = [];
  const storage = new MemoryStorage();
  storage.setItem("cs.deviceId", "device-1");
  storage.setItem("cs.deviceSecret", "secret-1");
  storage.setItem("cs.deviceName", "Phone");
  const restores = [
    define(globalThis, "localStorage", { value: storage, writable: true }),
    define(globalThis, "WebSocket", { value: FakeWebSocket, writable: true }),
    define(window, "location", {
      value: { origin: "http://127.0.0.1:3000", search: "", pathname: "/mobile" },
      writable: true,
    }),
    define(window, "history", { value: { replaceState() {} }, writable: true }),
    define(window, "fetch", {
      value: async () => {
        throw new Error("No network expected");
      },
      writable: true,
    }),
  ];
  restore = () => {
    for (const item of restores.reverse()) item();
  };
}

afterEach(() => {
  restore?.();
  restore = undefined;
  FakeWebSocket.instances = [];
});

const target = { kind: "session", sessionId: "s-1" } as const;

async function connected(capabilities: Record<string, number> = { turnQueue: 1 }) {
  setupBrowser();
  const hook = await renderHook(() => useRemoteApp());
  const ws = FakeWebSocket.instances[0]!;
  await act(async () => {
    ws.open();
    ws.message({ type: "auth.ok", capabilities });
    await flushMicrotasks();
  });
  await act(async () => {
    hook.result.current.selectSession("s-1");
    ws.message({ type: "session.history.ok", sessionId: "s-1", events: [] });
    await flushMicrotasks();
  });
  const sent = () =>
    ws.sent.map((line) => JSON.parse(line) as Record<string, unknown> & { type: string });
  return { hook, ws, sent };
}

function state(entries: Array<Record<string, unknown>>, revision: number, epoch = "host-1") {
  return { type: "queue.state", target, epoch, revision, entries };
}

function entry(id: string, text: string, ownDevice = true) {
  return {
    id,
    clientMessageId: `cm-${id}`,
    text,
    attachments: [],
    status: "queued",
    createdAt: 1,
    ownDevice,
  };
}

describe("useRemoteApp Host turn queue", () => {
  test("a queued admission resolves the send without a bubble; the bubble appears when it runs", async () => {
    const { hook, ws, sent } = await connected();
    try {
      expect(hook.result.current.turnQueueSupported).toBe(true);
      expect(sent().filter((event) => event.type === "queue.sync")).toContainEqual({
        type: "queue.sync",
        target,
      });
      let pending!: Promise<boolean>;
      await act(async () => {
        pending = hook.result.current.sendChat({ text: "later", attachments: [] });
        await flushMicrotasks();
      });
      const send = sent().find((event) => event.type === "chat.send")!;
      expect(send).toMatchObject({ sessionId: "s-1", text: "later", queue: true });
      await act(async () => {
        ws.message({
          type: "chat.queued",
          target,
          clientMessageId: send.clientMessageId,
          entryId: "e-1",
          position: 0,
        });
        await flushMicrotasks();
      });
      expect(await pending).toBe(true);
      const users = () => hook.result.current.chat.items.filter((item) => item.kind === "user");
      expect(users()).toEqual([]);

      await act(async () => {
        ws.message(state([{ ...entry("e-1", "later"), clientMessageId: send.clientMessageId }], 4));
        await flushMicrotasks();
      });
      expect(hook.result.current.turnQueue?.entries.map((item) => item.text)).toEqual(["later"]);

      // A stale revision from the same Host lifetime cannot resurrect old state.
      await act(async () => {
        ws.message(state([], 3));
        await flushMicrotasks();
      });
      expect(hook.result.current.turnQueue?.entries).toHaveLength(1);

      await act(async () => {
        ws.message({
          type: "chat.accepted",
          sessionId: "s-1",
          clientMessageId: send.clientMessageId,
          attachments: [],
        });
        ws.message(state([], 5));
        await flushMicrotasks();
      });
      expect(users()).toMatchObject([{ text: "later", clientMessageId: send.clientMessageId }]);
      expect(hook.result.current.turnQueue?.entries).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test("controls name the exact visible conversation", async () => {
    const { hook, sent } = await connected();
    try {
      await act(async () => {
        hook.result.current.cancelQueuedTurn?.("e-1");
        hook.result.current.retryQueuedTurn?.("e-2");
        hook.result.current.resumeTurnQueue?.();
        hook.result.current.clearTurnQueue?.();
        await flushMicrotasks();
      });
      const controls = sent().filter(
        (event) => event.type.startsWith("queue.") && event.type !== "queue.sync",
      );
      expect(controls).toEqual([
        { type: "queue.cancel", target, entryId: "e-1" },
        { type: "queue.retry", target, entryId: "e-2" },
        { type: "queue.resume", target },
        { type: "queue.clear", target },
      ]);
    } finally {
      await hook.unmount();
    }
  });

  test("a restarted Host never claims a lost turn did not run; it asks to check history", async () => {
    // "dispatching": the physical input may have reached the CLI before the ack.
    for (const status of ["queued", "dispatching", "uncertain"]) {
      const { hook, ws } = await connected();
      try {
        await act(async () => {
          ws.message(
            state([{ ...entry("e-1", "mine"), status }, entry("e-2", "theirs", false)], 7),
          );
          await flushMicrotasks();
        });
        await act(async () => {
          ws.message(state([], 1, "host-2"));
          await flushMicrotasks();
        });
        expect(hook.result.current.turnQueue?.entries).toEqual([]);
        const notice = hook.result.current.notice ?? "";
        expect(notice).toContain("1 条排队消息的执行结果无法确认");
        expect(notice).toContain("核对会话历史");
        expect(notice).not.toContain("没有执行");
        expect(notice).not.toContain("重新发送");
      } finally {
        await hook.unmount();
      }
    }
  });

  test("a cached failure is stale after a restart: it may have been retried and run", async () => {
    const { hook, ws } = await connected();
    try {
      // Last snapshot this tab saw: rejected. The Host then retried it and the
      // CLI accepted it, but the tab was offline and the Host restarted.
      await act(async () => {
        ws.message(state([{ ...entry("e-1", "mine"), status: "failed" }], 7));
        await flushMicrotasks();
      });
      await act(async () => {
        ws.close();
        await flushMicrotasks();
      });
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await flushMicrotasks();
      });
      const restarted = FakeWebSocket.instances.at(-1)!;
      await act(async () => {
        restarted.open();
        restarted.message({ type: "auth.ok", capabilities: { turnQueue: 1 } });
        restarted.message(state([], 1, "host-2"));
        await flushMicrotasks();
      });
      const notice = hook.result.current.notice ?? "";
      expect(notice).toContain("1 条排队消息的执行结果无法确认");
      expect(notice).toContain("避免重复提交");
      expect(notice).not.toContain("没有执行");
      expect(notice).not.toContain("重新发送");
    } finally {
      await hook.unmount();
    }
  });

  test("a lost queued ack is settled by the Host's own list after reconnect", async () => {
    const { hook, ws } = await connected();
    let uncertain: string | undefined;
    try {
      let pending!: Promise<boolean>;
      await act(async () => {
        pending = hook.result.current.sendChat({
          text: "lost ack",
          attachments: [],
          onUncertain: (id) => {
            uncertain = id;
          },
        });
        await flushMicrotasks();
      });
      const send = ws.sent
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.type === "chat.send")!;
      await act(async () => {
        ws.close();
        await flushMicrotasks();
      });
      expect(await pending).toBe(false);
      expect(uncertain).toBe(send.clientMessageId as string);
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await flushMicrotasks();
      });
      const next = FakeWebSocket.instances.at(-1)!;
      await act(async () => {
        next.open();
        next.message({ type: "auth.ok", capabilities: { turnQueue: 1 } });
        next.message(
          state([{ ...entry("e-1", "lost ack"), clientMessageId: send.clientMessageId }], 3),
        );
        await flushMicrotasks();
      });
      // The admitted turn shows its bubble when it runs, exactly once.
      await act(async () => {
        next.message({
          type: "chat.accepted",
          sessionId: "s-1",
          clientMessageId: send.clientMessageId,
        });
        await flushMicrotasks();
      });
      const users = hook.result.current.chat.items.filter((item) => item.kind === "user");
      expect(users).toMatchObject([{ text: "lost ack", clientMessageId: send.clientMessageId }]);
    } finally {
      await hook.unmount();
    }
  });

  test("an older Host never receives a queue flag or queue controls", async () => {
    const { hook, sent } = await connected({});
    try {
      expect(hook.result.current.turnQueueSupported).toBe(false);
      await act(async () => {
        void hook.result.current.sendChat({ text: "legacy", attachments: [] });
        hook.result.current.cancelQueuedTurn?.("e-1");
        await flushMicrotasks();
      });
      const send = sent().find((event) => event.type === "chat.send")!;
      expect(send.queue).toBeUndefined();
      expect(sent().filter((event) => event.type.startsWith("queue."))).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });
});

const noop = () => {};
function remoteApp(patch: Partial<RemoteApp> = {}): RemoteApp {
  return {
    status: "online",
    conversationRevision: 0,
    deviceName: "Fixture",
    chat: initialChatState(),
    sessions: [],
    unreadSessionIds: new Set(),
    projects: [],
    approvals: [],
    permissionMode: "default",
    loading: {
      sessions: false,
      sessionHistory: false,
      rooms: false,
      projects: false,
      roomHistory: false,
      ccSessions: false,
    },
    logout: noop,
    sendChat: async () => true,
    stopRun: noop,
    selectSession: noop,
    newSession: noop,
    refreshSessions: noop,
    respondApproval: noop,
    setPermissionMode: noop,
    extendGoal: noop,
    clearGoal: noop,
    leaveRoom: noop,
    activeProjectCwd: null,
    activeProjectId: null,
    selectProject: noop,
    ccSessions: [],
    ccProbe: null,
    ccCliKind: "claude-code",
    setCcCliKind: noop,
    openCcSession: noop,
    respondCcApproval: noop,
    ...patch,
  };
}
function reactProps(node: unknown): Record<string, any> {
  const key = Object.keys(node as object).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as Record<string, any>)[key] : {};
}
function elementsByTag(node: any, tag: string): any[] {
  return [
    ...(node.tagName === tag ? [node] : []),
    ...(node.childNodes ?? []).flatMap((child: any) => elementsByTag(child, tag)),
  ];
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? "";
  return node.childNodes?.length ? node.childNodes.map(textOf).join("") : (node.textContent ?? "");
}
function queueState(
  target: MobileTurnQueueState["target"],
  entries: MobileTurnQueueState["entries"],
  epoch = "host-1",
): MobileTurnQueueState {
  return { target, epoch, revision: 1, entries };
}

describe("Host turn queue in the remote composer", () => {
  test("the composer is released when the Host's list proves admission; nothing is resent", async () => {
    ensureMiniDom();
    const sends: Array<Parameters<RemoteApp["sendChat"]>[0]> = [];
    let app = remoteApp({
      activeSessionId: "s-1",
      turnQueueSupported: true,
      chat: { ...initialChatState(), run: "running" },
      sendChat: async (input) => {
        sends.push(input);
        if (sends.length === 1) {
          // chat.queued was lost with the connection.
          input.onUncertain?.("cm-lost");
          return false;
        }
        return true;
      },
    });
    const hook = await renderHook(() => useDesktopController(app, undefined, noop));
    try {
      await act(async () => {
        hook.result.current.setDraft("queued while busy");
      });
      await act(async () => {
        expect(hook.result.current.send()).toBe(true);
        await flushMicrotasks();
      });
      expect(hook.result.current.uncertain).toBe(true);
      expect(hook.result.current.draft).toBe("queued while busy");
      const target = { kind: "session", sessionId: "s-1" } as const;
      const admitted = {
        id: "e-1",
        clientMessageId: "cm-lost",
        text: "queued while busy",
        attachments: [],
        status: "queued" as const,
        createdAt: 1,
        ownDevice: true,
      };
      // An "uncertain" entry proves nothing new: the intent stays protected.
      app = { ...app, turnQueue: queueState(target, [{ ...admitted, status: "uncertain" }]) };
      await hook.rerender();
      expect(hook.result.current.uncertain).toBe(true);
      app = { ...app, turnQueue: queueState(target, [admitted]) };
      await hook.rerender();
      expect(hook.result.current.uncertain).toBe(false);
      expect(hook.result.current.draft).toBe("");
      // The user cancels it from the list; the composer sends new work normally.
      app = { ...app, turnQueue: queueState(target, []) };
      await hook.rerender();
      await act(async () => {
        hook.result.current.setDraft("next");
      });
      await act(async () => {
        expect(hook.result.current.send()).toBe(true);
        await flushMicrotasks();
      });
      expect(sends).toHaveLength(2);
      expect(sends[1]?.text).toBe("next");
      expect(sends[1]?.clientMessageId).toBeUndefined();
    } finally {
      await hook.unmount();
    }
  });

  test("clearing needs a fresh confirmation per conversation and Host lifetime", async () => {
    ensureMiniDom();
    const cleared: string[] = [];
    const entries = (prefix: string) =>
      [1, 2].map((index) => ({
        id: `${prefix}-${index}`,
        clientMessageId: `${prefix}-cm-${index}`,
        text: `${prefix} ${index}`,
        attachments: [],
        status: "queued" as const,
        createdAt: index,
        ownDevice: true,
      }));
    const queue = (state: MobileTurnQueueState, name: string): WorkbenchTurnQueue => ({
      canQueue: true,
      state,
      online: true,
      cancel: noop,
      retry: noop,
      resume: noop,
      clear: () => {
        cleared.push(name);
      },
    });
    const a = queueState({ kind: "session", sessionId: "a" }, entries("a"));
    const b = queueState({ kind: "session", sessionId: "b" }, entries("b"));
    const host = document.createElement("div");
    const root = createRoot(host);
    const button = () =>
      elementsByTag(host, "BUTTON").find((node) => /全部取消|确认清空/.test(textOf(node)))!;
    const press = async () =>
      act(async () => {
        reactProps(button()).onClick();
        await flushMicrotasks();
      });
    try {
      await act(async () => {
        root.render(<TurnQueueList queue={queue(a, "a")} />);
        await flushMicrotasks();
      });
      await press();
      expect(textOf(button())).toContain("确认清空");
      // Same mounted list, another conversation: the pending confirmation is void.
      await act(async () => {
        root.render(<TurnQueueList queue={queue(b, "b")} />);
        await flushMicrotasks();
      });
      expect(textOf(button())).toContain("全部取消");
      await press();
      expect(cleared).toEqual([]);
      // A Host restart (new epoch) also voids it.
      await act(async () => {
        root.render(<TurnQueueList queue={queue({ ...b, epoch: "host-2" }, "b")} />);
        await flushMicrotasks();
      });
      await press();
      expect(cleared).toEqual([]);
      await press();
      expect(cleared).toEqual(["b"]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("a CLI room with pending turns cannot switch permission mode", async () => {
    ensureMiniDom();
    const room = {
      id: "room-1",
      name: "CLI",
      cwd: "/repo",
      kind: "claude-code" as const,
      permissionMode: "default" as const,
      createdAt: 1,
      lastActiveAt: 1,
      open: true,
      observing: false,
      sessionId: "external-1",
    };
    const requested: string[] = [];
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          <DesktopChatControls
            app={remoteApp({
              activeRoomId: room.id,
              activeRoom: room,
              setCcRoomPermissionMode: (mode) => requested.push(mode),
              turnQueue: queueState({ kind: "room", roomId: room.id }, [
                {
                  id: "e-1",
                  clientMessageId: "cm-1",
                  text: "pending",
                  attachments: [],
                  status: "queued",
                  createdAt: 1,
                  ownDevice: true,
                  permissionMode: "default",
                },
              ]),
            })}
          />,
        );
        await flushMicrotasks();
      });
      const select = elementsByTag(host, "SELECT")[0]!;
      expect(reactProps(select).disabled).toBe(true);
      expect(textOf(host)).toContain("1 条排队消息按当前模式提交");
      await act(async () => {
        reactProps(select).onChange({ target: { value: "bypassPermissions" } });
        await flushMicrotasks();
      });
      expect(requested).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
