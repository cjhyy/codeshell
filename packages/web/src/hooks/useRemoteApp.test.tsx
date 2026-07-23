import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { useRemoteApp } from "./useRemoteApp";

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

describe("useRemoteApp session unread", () => {
  test("非当前 session 的 seq 前进标未读,切到该 session 后清除", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;

    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({
        type: "session.list.ok",
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "当前会话",
            cwd: "/repo",
            updatedAt: 1,
            origin: "desktop",
          },
          {
            id: "s2",
            title: "后台会话",
            cwd: "/repo",
            updatedAt: 2,
            origin: "desktop",
          },
        ],
      });
      await flushMicrotasks();
    });

    await act(async () => {
      hook.result.current.selectSession("s1");
      await flushMicrotasks();
    });
    expect(hook.result.current.unreadSessionIds.has("s2")).toBe(false);

    await act(async () => {
      ws.message({
        type: "session.stream",
        sessionId: "s2",
        seq: 1,
        event: { type: "text_delta", text: "新内容" },
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.unreadSessionIds.has("s2")).toBe(true);
    expect(hook.result.current.chat.items.some((item) => item.kind === "assistant")).toBe(false);

    await act(async () => {
      ws.message({
        type: "session.stream",
        sessionId: "s1",
        seq: 1,
        event: { type: "stream_request_start", turnNumber: 1 },
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.unreadSessionIds.has("s1")).toBe(false);
    expect(hook.result.current.chat.items.some((item) => item.kind === "assistant")).toBe(true);

    await act(async () => {
      hook.result.current.selectSession("s2");
      await flushMicrotasks();
    });
    expect(hook.result.current.unreadSessionIds.has("s2")).toBe(false);

    await hook.unmount();
  });

  test("后台 session 的 unread seq 不污染 appliedSeqRef,打开后 snapshot 仍可补回且去重", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;

    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({
        type: "session.list.ok",
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "当前会话",
            cwd: "/repo",
            updatedAt: 1,
            origin: "desktop",
          },
          {
            id: "s2",
            title: "后台会话",
            cwd: "/repo",
            updatedAt: 2,
            origin: "desktop",
          },
        ],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectSession("s1");
      await flushMicrotasks();
    });

    await act(async () => {
      ws.message({
        type: "session.stream",
        sessionId: "s2",
        seq: 1,
        event: { type: "stream_request_start", turnNumber: 1 },
      });
      ws.message({
        type: "session.stream",
        sessionId: "s2",
        seq: 2,
        event: { type: "text_delta", text: "后台内容" },
      });
      await flushMicrotasks();
    });

    expect(hook.result.current.unreadSessionIds.has("s2")).toBe(true);
    expect(
      hook.result.current.chat.items.some((item) => "text" in item && item.text === "后台内容"),
    ).toBe(false);

    await act(async () => {
      hook.result.current.selectSession("s2");
      await flushMicrotasks();
    });
    expect(hook.result.current.unreadSessionIds.has("s2")).toBe(false);
    expect(hook.result.current.chat.items).toEqual([]);

    const snapshot = {
      type: "session.snapshot",
      sessionId: "s2",
      entries: [
        { seq: 1, event: { type: "stream_request_start", turnNumber: 1 } },
        { seq: 2, event: { type: "text_delta", text: "后台内容" } },
        { seq: 3, event: { type: "turn_complete", reason: "completed" } },
      ],
      nextSeq: 4,
    };

    await act(async () => {
      ws.message(snapshot);
      await flushMicrotasks();
    });

    const firstReplay = hook.result.current.chat.items.filter((item) => item.kind === "assistant");
    expect(firstReplay).toHaveLength(1);
    expect(firstReplay[0]).toMatchObject({ text: "后台内容", done: true });

    await act(async () => {
      ws.message(snapshot);
      await flushMicrotasks();
    });

    const secondReplay = hook.result.current.chat.items.filter((item) => item.kind === "assistant");
    expect(secondReplay).toHaveLength(1);
    expect(secondReplay[0]).toMatchObject({ text: "后台内容", done: true });

    await hook.unmount();
  });
});

describe("useRemoteApp mobile image sends", () => {
  test("waits for a large-image ticket + PUT, then sends one image-only chat turn", async () => {
    setupBrowser();
    const puts: Array<{ url: string; size: number }> = [];
    const restoreFetch = defineTestProperty(window, "fetch", {
      value: async (url: string, init?: RequestInit) => {
        puts.push({ url, size: (init?.body as Blob).size });
        return new Response(null, { status: 201 });
      },
      writable: true,
    });
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;

    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });

    const file = new File([new Uint8Array(256 * 1024 + 1)], "large.png", {
      type: "image/png",
    });
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = hook.result.current.sendChat({
        text: "",
        attachments: [{ clientId: "img-1", file }],
      });
      await flushMicrotasks();
    });
    const begin = ws.sent
      .map((payload) => JSON.parse(payload))
      .find((event) => event.type === "attachment.upload.begin");
    expect(begin).toMatchObject({
      clientId: "img-1",
      name: "large.png",
      mime: "image/png",
      size: 256 * 1024 + 1,
    });

    await act(async () => {
      ws.message({
        type: "attachment.upload.ready",
        clientId: "img-1",
        uploadId: "upload-1",
        putUrl: "/api/mobile/uploads/ticket-1",
        expiresAt: Date.now() + 10_000,
      });
      await flushMicrotasks();
    });

    expect(puts).toEqual([{ url: "/api/mobile/uploads/ticket-1", size: 256 * 1024 + 1 }]);
    const chatSend = ws.sent
      .map((payload) => JSON.parse(payload))
      .find((event) => event.type === "chat.send");
    expect(chatSend).toMatchObject({
      text: "",
      attachments: [
        {
          transport: "upload",
          clientId: "img-1",
          uploadId: "upload-1",
          name: "large.png",
          mime: "image/png",
        },
      ],
    });
    expect(typeof chatSend.clientMessageId).toBe("string");
    let settled = false;
    void sent.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    await act(async () => {
      ws.message({
        type: "chat.accepted",
        clientMessageId: chatSend.clientMessageId,
        sessionId: "session-1",
        cwd: "/repo",
      });
      expect(await sent).toBe(true);
      await flushMicrotasks();
    });
    expect(hook.result.current.chat.items.at(-1)).toMatchObject({
      kind: "user",
      text: "",
      attachments: [{ name: "large.png", mime: "image/png" }],
    });

    await hook.unmount();
    restoreFetch();
  });

  test("keeps the draft result false when the socket drops during a large-image PUT", async () => {
    setupBrowser();
    let ws!: FakeWebSocket;
    const restoreFetch = defineTestProperty(window, "fetch", {
      value: async () => {
        ws.close();
        return new Response(null, { status: 201 });
      },
      writable: true,
    });
    const hook = await renderHook(() => useRemoteApp());
    ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });

    const file = new File([new Uint8Array(256 * 1024 + 1)], "large.png", {
      type: "image/png",
    });
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = hook.result.current.sendChat({
        text: "keep me",
        attachments: [{ clientId: "img-drop", file }],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({
        type: "attachment.upload.ready",
        clientId: "img-drop",
        uploadId: "upload-drop",
        putUrl: "/api/mobile/uploads/drop",
        expiresAt: Date.now() + 10_000,
      });
      expect(await sent).toBe(false);
      await flushMicrotasks();
    });

    expect(
      ws.sent.map((payload) => JSON.parse(payload)).some((event) => event.type === "chat.send"),
    ).toBe(false);
    expect(hook.result.current.chat.items.some((item) => item.kind === "user")).toBe(false);
    await hook.unmount();
    restoreFetch();
  });
});

describe("useRemoteApp approval replay", () => {
  test("replayed raw approval after selecting its session hydrates and resolves the card", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;
    const approvalLine = {
      jsonrpc: "2.0",
      method: "agent/approvalRequest",
      params: {
        sessionId: "s2",
        requestId: "ask-1",
        request: {
          toolName: "AskUserQuestion",
          description: "Pick deployment target",
          args: {
            options: ["Staging", "Production"],
            optionsOnly: true,
          },
          riskLevel: "low",
        },
      },
    };

    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({
        type: "session.list.ok",
        activeSessionId: "s1",
        sessions: [
          { id: "s1", title: "Current", cwd: "/repo", updatedAt: 1, origin: "desktop" },
          { id: "s2", title: "Pending approval", cwd: "/repo", updatedAt: 2, origin: "desktop" },
        ],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectSession("s1");
      await flushMicrotasks();
    });

    await act(async () => {
      ws.message(approvalLine);
      await flushMicrotasks();
    });
    expect(hook.result.current.approvals).toEqual([]);

    await act(async () => {
      hook.result.current.selectSession("s2");
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message(approvalLine);
      await flushMicrotasks();
    });

    expect(hook.result.current.approvals).toHaveLength(1);
    expect(hook.result.current.approvals[0]).toMatchObject({
      requestId: "ask-1",
      sessionId: "s2",
      toolName: "AskUserQuestion",
      description: "Pick deployment target",
      summary: "Pick deployment target",
      risk: "low",
      options: ["Staging", "Production"],
      optionsOnly: true,
    });

    await act(async () => {
      ws.message({
        jsonrpc: "2.0",
        method: "agent/approvalResolved",
        params: { sessionId: "s2", requestId: "ask-1", approved: true },
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.approvals).toEqual([]);

    await hook.unmount();
  });
});

describe("useRemoteApp cc transcript streaming", () => {
  test("marks an observing room read-only and refuses phone sends", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;

    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      ws.message({ type: "room.projects.ok", projects: [{ path: "/repo", name: "repo" }] });
      ws.message({
        type: "room.list.ok",
        rooms: [
          {
            id: "room-observe",
            name: "Observed CC",
            cwd: "/repo",
            kind: "codex",
            permissionMode: "default",
            createdAt: 1,
            lastActiveAt: 1,
            open: false,
            observing: true,
          },
        ],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectProject("/repo");
      hook.result.current.openCcSession("thread-observe", "/repo", "default");
      ws.message({
        type: "ccRoom.opened",
        roomId: "room-observe",
        sessionId: "thread-observe",
        status: "observing",
      });
      await flushMicrotasks();
    });

    expect(hook.result.current.activeRoom).toMatchObject({
      id: "room-observe",
      observing: true,
    });
    let sent = true;
    await act(async () => {
      sent = await hook.result.current.sendChat({ text: "must not disappear", attachments: [] });
      await flushMicrotasks();
    });
    expect(sent).toBe(false);
    expect(hook.result.current.notice).toContain("只读");
    expect(ws.sent.map((payload) => JSON.parse(payload))).not.toContainEqual(
      expect.objectContaining({ type: "room.send", roomId: "room-observe" }),
    );

    await hook.unmount();
  });

  test("subscribes after opening, applies snapshot+seq catchup, and unsubscribes on leave", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;

    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      ws.message({
        type: "room.projects.ok",
        projects: [{ path: "/repo", name: "repo" }],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectProject("/repo");
      hook.result.current.openCcSession("thread-1", "/repo", "default");
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({
        type: "ccRoom.opened",
        roomId: "room-1",
        sessionId: "thread-1",
        status: "running",
      });
      await flushMicrotasks();
    });

    const sentAfterOpen = ws.sent.map((payload) => JSON.parse(payload));
    expect(sentAfterOpen).toContainEqual({
      type: "ccRoom.subscribeTranscript",
      roomId: "room-1",
      cwd: "/repo",
      sessionId: "thread-1",
      limit: 150,
      kind: "claude-code",
    });

    await act(async () => {
      ws.message({
        type: "ccRoom.transcriptSubscribed",
        roomId: "room-1",
        sessionId: "thread-1",
        active: true,
        messages: [{ role: "user", text: "initial" }],
        hasMore: false,
        totalCount: 1,
        roomCursor: 5,
      });
      await flushMicrotasks();
    });
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "room.history",
      roomId: "room-1",
      sinceSeq: 5,
    });

    await act(async () => {
      ws.message({
        type: "room.history.ok",
        roomId: "room-1",
        messages: [{ seq: 6, from: "agent", type: "text", text: "streamed on phone" }],
        latestSeq: 6,
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.chat.items).toMatchObject([
      { kind: "user", text: "initial" },
      { kind: "assistant", text: "streamed on phone", done: true },
    ]);

    await act(async () => {
      hook.result.current.leaveRoom();
      await flushMicrotasks();
    });
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "ccRoom.unsubscribeTranscript",
      roomId: "room-1",
    });

    await hook.unmount();
  });

  test("re-subscribes the active transcript after the phone socket reconnects", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const firstSocket = FakeWebSocket.instances[0]!;

    await act(async () => {
      firstSocket.open();
      firstSocket.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      firstSocket.message({
        type: "room.projects.ok",
        projects: [{ path: "/repo", name: "repo" }],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectProject("/repo");
      hook.result.current.openCcSession("thread-1", "/repo", "default");
      await flushMicrotasks();
    });
    await act(async () => {
      firstSocket.message({
        type: "ccRoom.opened",
        roomId: "room-1",
        sessionId: "thread-1",
        status: "running",
      });
      await flushMicrotasks();
    });
    await act(async () => {
      firstSocket.message({
        type: "ccRoom.transcriptSubscribed",
        roomId: "room-1",
        sessionId: "thread-1",
        active: true,
        messages: [],
        hasMore: false,
        totalCount: 0,
        roomCursor: 5,
      });
      await flushMicrotasks();
    });

    await act(async () => {
      firstSocket.close();
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const reconnectedSocket = FakeWebSocket.instances[1]!;
    expect(reconnectedSocket).toBeDefined();

    await act(async () => {
      reconnectedSocket.open();
      reconnectedSocket.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });

    expect(reconnectedSocket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "ccRoom.subscribeTranscript",
      roomId: "room-1",
      cwd: "/repo",
      sessionId: "thread-1",
      limit: 150,
      kind: "claude-code",
    });

    await hook.unmount();
  });

  test("reconnect keeps the open room cwd after selecting another project", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const firstSocket = FakeWebSocket.instances[0]!;

    await act(async () => {
      firstSocket.open();
      firstSocket.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      firstSocket.message({
        type: "room.projects.ok",
        projects: [
          { path: "/repo-a", name: "repo-a" },
          { path: "/repo-b", name: "repo-b" },
        ],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectProject("/repo-a");
      hook.result.current.openCcSession("thread-a", "/repo-a", "default");
      await flushMicrotasks();
    });
    await act(async () => {
      firstSocket.message({
        type: "ccRoom.opened",
        roomId: "room-a",
        sessionId: "thread-a",
        status: "running",
      });
      firstSocket.message({
        type: "ccRoom.transcriptSubscribed",
        roomId: "room-a",
        sessionId: "thread-a",
        active: true,
        messages: [],
        hasMore: false,
        totalCount: 0,
        roomCursor: 1,
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectProject("/repo-b");
      await flushMicrotasks();
    });

    await act(async () => {
      firstSocket.close();
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const reconnectedSocket = FakeWebSocket.instances[1]!;
    await act(async () => {
      reconnectedSocket.open();
      reconnectedSocket.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });

    const transcriptSubscriptions = reconnectedSocket.sent
      .map((payload) => JSON.parse(payload))
      .filter((event) => event.type === "ccRoom.subscribeTranscript");
    expect(transcriptSubscriptions).toEqual([
      {
        type: "ccRoom.subscribeTranscript",
        roomId: "room-a",
        cwd: "/repo-a",
        sessionId: "thread-a",
        limit: 150,
        kind: "claude-code",
      },
    ]);

    await hook.unmount();
  });
});
