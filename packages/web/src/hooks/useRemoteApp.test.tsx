import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { useRemoteApp } from "./useRemoteApp";
import { useDesktopController } from "../../app/DesktopApp.js";

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

describe("useRemoteApp Main process epochs", () => {
  async function connectedSession(oldEpoch?: string, seedTool = false) {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const firstSocket = FakeWebSocket.instances[0]!;
    await act(async () => {
      firstSocket.open();
      firstSocket.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectSession("s1");
      await flushMicrotasks();
    });
    await act(async () => {
      for (const [seq, event] of [
        [1, { type: "stream_request_start", turnNumber: 1 }],
        [2, { type: "text_delta", text: "old answer" }],
        ...(seedTool
          ? ([
              [
                3,
                {
                  type: "tool_use_start",
                  toolCall: { id: "call-1", toolName: "Read", args: { path: "old.txt" } },
                },
              ],
            ] as const)
          : []),
        [100, { type: "session_title", title: "existing history" }],
      ] as const) {
        firstSocket.message({
          type: "session.stream",
          sessionId: "s1",
          seq,
          event,
          ...(oldEpoch ? { epoch: oldEpoch } : {}),
        });
      }
      await flushMicrotasks();
    });
    expect(hook.result.current.chat.items).toContainEqual(
      expect.objectContaining({ kind: "assistant", text: "old answer", done: false }),
    );
    await act(async () => {
      firstSocket.close();
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const ws = FakeWebSocket.instances[1]!;
    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    expect(ws.sent.map((line) => JSON.parse(line))).toContainEqual({
      type: "session.sync",
      sessionId: "s1",
      sinceSeq: 100,
      ...(oldEpoch ? { epoch: oldEpoch } : {}),
    });
    return { hook, ws, firstSocket };
  }

  const snapshot = {
    type: "session.snapshot",
    sessionId: "s1",
    epoch: "epoch-b",
    // A fresh Main can attach after generation began; its first observed
    // delta must still never join an unfinished old-domain assistant.
    entries: [
      { seq: 1, event: { type: "text_delta", text: "new prefix " } },
      { seq: 2, event: { type: "text_delta", text: "tail" } },
      { seq: 3, event: { type: "turn_complete", reason: "completed" } },
    ],
    nextSeq: 4,
  };

  for (const oldEpoch of ["epoch-a", undefined]) {
    for (const order of ["snapshot-first", "live-first"] as const) {
      test(`${oldEpoch ?? "legacy"} seq 100 -> epoch-b seq 1: ${order} preserves both replies`, async () => {
        const { hook, ws, firstSocket } = await connectedSession(oldEpoch);
        try {
          if (order === "live-first") {
            await act(async () => {
              ws.message({
                type: "session.stream",
                sessionId: "s1",
                epoch: "epoch-b",
                ...snapshot.entries[1],
              });
              await flushMicrotasks();
            });
            expect(ws.sent.map((line) => JSON.parse(line))).toContainEqual({
              type: "session.sync",
              sessionId: "s1",
              sinceSeq: 0,
              epoch: "epoch-b",
            });
            expect(
              hook.result.current.chat.items
                .filter((item) => item.kind === "assistant")
                .map((item) => item.text),
            ).toEqual(["old answer"]);
          }
          await act(async () => {
            ws.message(snapshot);
            for (const entry of snapshot.entries)
              ws.message({ type: "session.stream", sessionId: "s1", epoch: "epoch-b", ...entry });
            ws.message(snapshot);
            // Retired sockets cannot replace the current epoch/cursor.
            firstSocket.message({
              type: "session.stream",
              sessionId: "s1",
              epoch: "epoch-a",
              seq: 999,
              event: { type: "text_delta", text: "late old packet" },
            });
            await flushMicrotasks();
          });
          expect(
            hook.result.current.chat.items
              .filter((item) => item.kind === "assistant")
              .map((item) => ({ text: item.text, done: item.done })),
          ).toEqual([
            { text: "old answer", done: true },
            { text: "new prefix tail", done: true },
          ]);
          await act(async () => {
            window.dispatchEvent(new Event("focus"));
            await flushMicrotasks();
          });
          expect(
            ws.sent
              .map((line) => JSON.parse(line))
              .filter((event) => event.type === "session.sync")
              .at(-1),
          ).toEqual({ type: "session.sync", sessionId: "s1", sinceSeq: 3, epoch: "epoch-b" });
        } finally {
          await hook.unmount();
        }
      });
    }
  }

  test("a legacy filtered reply after learning an epoch requests a full prefix", async () => {
    const { hook, ws } = await connectedSession();
    try {
      await act(async () => {
        ws.message({ ...snapshot, entries: [] });
        await flushMicrotasks();
      });
      expect(ws.sent.map((line) => JSON.parse(line))).toContainEqual({
        type: "session.sync",
        sessionId: "s1",
        sinceSeq: 0,
        epoch: "epoch-b",
      });
      await act(async () => {
        ws.message(snapshot);
        // A later missing epoch packet keeps the learned epoch for resync.
        ws.message({
          type: "session.stream",
          sessionId: "s1",
          seq: 4,
          event: { type: "session_title", title: "new title" },
        });
        window.dispatchEvent(new Event("focus"));
        await flushMicrotasks();
      });
      expect(
        hook.result.current.chat.items
          .filter((item) => item.kind === "assistant")
          .map((item) => item.text),
      ).toEqual(["old answer", "new prefix tail"]);
      expect(
        ws.sent
          .map((line) => JSON.parse(line))
          .filter((event) => event.type === "session.sync")
          .at(-1),
      ).toEqual({ type: "session.sync", sessionId: "s1", sinceSeq: 4, epoch: "epoch-b" });
    } finally {
      await hook.unmount();
    }
  });

  test("an evicted new-epoch prefix stays unapplied and leaves old visible content intact", async () => {
    const { hook, ws } = await connectedSession("epoch-a");
    try {
      await act(async () => {
        ws.message({
          type: "session.stream",
          sessionId: "s1",
          epoch: "epoch-b",
          seq: 2001,
          event: { type: "text_delta", text: "missing prefix tail" },
        });
        ws.message({
          ...snapshot,
          entries: [{ seq: 2001, event: { type: "text_delta", text: "missing prefix tail" } }],
          nextSeq: 2002,
        });
        await flushMicrotasks();
      });
      expect(
        hook.result.current.chat.items
          .filter((item) => item.kind === "assistant")
          .map((item) => item.text),
      ).toEqual(["old answer"]);
      expect(hook.result.current.notice).toContain("开头尚未恢复");
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await flushMicrotasks();
      });
      expect(
        ws.sent
          .map((line) => JSON.parse(line))
          .filter((event) => event.type === "session.sync")
          .at(-1),
      ).toEqual({ type: "session.sync", sessionId: "s1", sinceSeq: 0, epoch: "epoch-b" });
    } finally {
      await hook.unmount();
    }
  });

  test("tool ids reused by a new Main cannot mutate retained old tool history", async () => {
    const { hook, ws } = await connectedSession("epoch-a", true);
    try {
      await act(async () => {
        ws.message({
          ...snapshot,
          entries: [
            {
              seq: 1,
              event: {
                type: "tool_use_start",
                toolCall: { id: "call-1", toolName: "Read", args: { path: "new.txt" } },
              },
            },
            {
              seq: 2,
              event: { type: "tool_result", result: { id: "call-1", result: "new result" } },
            },
          ],
          nextSeq: 3,
        });
        await flushMicrotasks();
      });
      const tools = hook.result.current.chat.items.filter((item) => item.kind === "tool");
      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({ args: { path: "old.txt" }, result: undefined });
      expect(tools[1]).toMatchObject({
        id: "call-1",
        args: { path: "new.txt" },
        result: "new result",
      });
    } finally {
      await hook.unmount();
    }
  });

  for (const savedReply of ["saved history", "new prefix tailmore"]) {
    test(`a background epoch change keeps unpaired durable history (${savedReply})`, async () => {
      const { hook, ws } = await connectedSession("epoch-a");
      try {
        await act(async () => {
          ws.message({
            type: "session.stream",
            sessionId: "s2",
            epoch: "epoch-a",
            seq: 100,
            event: { type: "text_delta", text: "background old" },
          });
          ws.message({
            type: "session.stream",
            sessionId: "s2",
            epoch: "epoch-b",
            seq: 2,
            event: { type: "text_delta", text: "tail" },
          });
          hook.result.current.selectSession("s2");
          await flushMicrotasks();
        });
        await act(async () => {
          ws.message({
            type: "session.stream",
            sessionId: "s2",
            epoch: "epoch-b",
            seq: 3,
            event: { type: "text_delta", text: "more" },
          });
          await flushMicrotasks();
        });
        expect(hook.result.current.chat.items).toEqual([]);
        await act(async () => {
          ws.message({
            type: "session.history.ok",
            sessionId: "s2",
            events: [
              { type: "text_delta", text: savedReply },
              { type: "turn_complete", reason: "completed" },
            ],
          });
          await flushMicrotasks();
        });
        await act(async () => {
          ws.message({
            ...snapshot,
            sessionId: "s2",
            entries: [
              ...snapshot.entries.slice(0, 2),
              { seq: 3, event: { type: "text_delta", text: "more" } },
              { seq: 4, event: { type: "turn_complete", reason: "completed" } },
            ],
            nextSeq: 5,
          });
          await flushMicrotasks();
        });
        expect(
          hook.result.current.chat.items
            .filter((item) => item.kind === "assistant")
            .map((item) => item.text),
        ).toEqual([savedReply]);
        expect(hook.result.current.notice).toContain("已恢复保存的聊天记录");
        await act(async () => {
          // A later Main may be the first to identify its epoch after this
          // durable read. Its log still has no association with that history.
          ws.message({
            ...snapshot,
            sessionId: "s2",
            epoch: "epoch-c",
            entries: [
              { seq: 1, event: { type: "text_delta", text: savedReply } },
              { seq: 2, event: { type: "turn_complete", reason: "completed" } },
            ],
            nextSeq: 3,
          });
          await flushMicrotasks();
        });
        expect(
          hook.result.current.chat.items.filter((item) => item.kind === "assistant"),
        ).toHaveLength(1);
        await act(async () => {
          ws.message({
            type: "session.stream",
            sessionId: "s2",
            epoch: "epoch-c",
            seq: 5,
            event: { type: "stream_request_start", agentId: "child" },
          });
          ws.message({
            type: "session.stream",
            sessionId: "s2",
            epoch: "epoch-c",
            seq: 6,
            event: { type: "text_delta", agentId: "child", text: "unpaired child tail" },
          });
          window.dispatchEvent(new Event("focus"));
          await flushMicrotasks();
        });
        expect(
          hook.result.current.chat.items.filter((item) => item.kind === "assistant"),
        ).toHaveLength(1);
        expect(ws.sent.map((line) => JSON.parse(line)).at(-1)).toEqual({
          type: "session.history",
          sessionId: "s2",
        });
        await act(async () => {
          ws.message({ type: "error", message: "History temporarily unavailable" });
          window.dispatchEvent(new Event("focus"));
          // A top-level start before the requested history returns is still
          // unpaired, because that asynchronous read may already include it.
          ws.message({
            type: "session.stream",
            sessionId: "s2",
            epoch: "epoch-c",
            seq: 7,
            event: { type: "stream_request_start" },
          });
          await flushMicrotasks();
        });
        expect(
          hook.result.current.chat.items.filter((item) => item.kind === "assistant"),
        ).toHaveLength(1);
        expect(
          ws.sent
            .map((line) => JSON.parse(line))
            .filter((event) => event.type === "session.history" && event.sessionId === "s2"),
        ).toHaveLength(3);
        const savedHistory = {
          type: "session.history.ok",
          sessionId: "s2",
          events: [
            { type: "text_delta", text: savedReply },
            { type: "turn_complete", reason: "completed" },
          ],
        };
        await act(async () => {
          ws.message(savedHistory);
          for (const [seq, event] of [
            [8, { type: "stream_request_start" }],
            [9, { type: "text_delta", text: "fresh reply" }],
            [10, { type: "turn_complete", reason: "completed" }],
          ] as const)
            ws.message({ type: "session.stream", sessionId: "s2", epoch: "epoch-c", seq, event });
          // A previously ignored snapshot and a late history retry cannot
          // reintroduce old replies or wipe the fresh turn after the boundary.
          ws.message({ ...snapshot, sessionId: "s2", epoch: "epoch-c" });
          ws.message(savedHistory);
          window.dispatchEvent(new Event("focus"));
          await flushMicrotasks();
        });
        expect(
          hook.result.current.chat.items
            .filter((item) => item.kind === "assistant")
            .map((item) => item.text),
        ).toEqual([savedReply, "fresh reply"]);
        expect(ws.sent.map((line) => JSON.parse(line)).at(-1)).toEqual({
          type: "session.sync",
          sessionId: "s2",
          sinceSeq: 10,
          epoch: "epoch-c",
        });
      } finally {
        await hook.unmount();
      }
    });
  }
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
    const restoreFetch = defineTestProperty(window, "fetch", {
      value: async () => {
        FakeWebSocket.instances[0]!.close();
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

describe("useRemoteApp project V2 session creation", () => {
  test("sends stable project/root ids and follows a make-primary projection by project id", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;

    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      ws.message({
        type: "room.projects.ok",
        projects: [
          {
            id: "project-1",
            path: "/primary-old",
            name: "multi-root",
            primaryRootId: "root-old",
            roots: [
              { id: "root-old", path: "/primary-old", name: "old", role: "primary" },
              { id: "root-new", path: "/primary-new", name: "new", role: "secondary" },
            ],
          },
        ],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.selectProject("project-1");
      hook.result.current.newSession({ projectId: "project-1", rootId: "root-new" });
      await flushMicrotasks();
    });
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "session.create",
      clientRequestId: expect.any(String),
      projectId: "project-1",
      rootId: "root-new",
    });
    expect(hook.result.current.activeProjectId).toBe("project-1");
    expect(hook.result.current.activeProjectCwd).toBe("/primary-old");

    await act(async () => {
      ws.message({
        type: "room.projects.ok",
        projects: [
          {
            id: "project-1",
            path: "/primary-new",
            name: "multi-root",
            primaryRootId: "root-new",
            roots: [
              { id: "root-old", path: "/primary-old", name: "old", role: "secondary" },
              { id: "root-new", path: "/primary-new", name: "new", role: "primary" },
            ],
          },
        ],
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.activeProjectId).toBe("project-1");
    expect(hook.result.current.activeProjectCwd).toBe("/primary-new");

    await hook.unmount();
  });

  test("uses an explicit V2 no-repo target", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      hook.result.current.newSession({ projectId: null });
      await flushMicrotasks();
    });
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "session.create",
      clientRequestId: expect.any(String),
      projectId: null,
    });
    await hook.unmount();
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

describe("useRemoteApp shared workbench integration", () => {
  test("host notifications use the existing socket and the latest observer without mutating chat", async () => {
    setupBrowser();
    const seen: string[] = [];
    let prefix = "first";
    const hook = await renderHook(() =>
      useRemoteApp({ onNotification: (method) => seen.push(`${prefix}:${method}`) }),
    );
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    prefix = "current";
    await hook.rerender();
    await act(async () => {
      ws.message({
        jsonrpc: "2.0",
        method: "serve/configurationChanged",
        params: { cwd: "/repo" },
      });
      await flushMicrotasks();
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(seen).toContain("current:serve/configurationChanged");
    expect(hook.result.current.chat.items).toHaveLength(0);
    await hook.unmount();
  });

  test("a delayed send acceptance cannot pull navigation back or append its user bubble to another session", async () => {
    setupBrowser();
    const restoreFetch = defineTestProperty(window, "fetch", {
      value: async () => {
        throw new Error("no attachments expected");
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
    let accepted!: Promise<boolean>;
    await act(async () => {
      accepted = hook.result.current.sendChat({ text: "old task", attachments: [] });
      await flushMicrotasks();
    });
    const sent = ws.sent
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "chat.send");
    expect(sent?.clientMessageId).toBeString();
    await act(async () => {
      hook.result.current.selectSession("new-selection");
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({
        type: "chat.accepted",
        sessionId: "old-session",
        clientMessageId: sent.clientMessageId,
        cwd: "/old",
      });
      await flushMicrotasks();
    });
    expect(await accepted).toBe(true);
    expect(hook.result.current.activeSessionId).toBe("new-selection");
    expect(hook.result.current.chat.items).toHaveLength(0);
    await hook.unmount();
    restoreFetch();
  });
});

describe("useRemoteApp correlated session creation", () => {
  test("late creation acknowledgement and its list refresh cannot replace an explicit session selection", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.newSession({ projectId: null });
      await flushMicrotasks();
    });
    const request = ws.sent
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "session.create");
    expect(request.clientRequestId).toBeString();
    await act(async () => {
      hook.result.current.selectSession("chosen");
      await flushMicrotasks();
    });
    await act(async () => {
      ws.message({
        type: "chat.accepted",
        clientRequestId: request.clientRequestId,
        sessionId: "late-created",
        cwd: "/late",
      });
      ws.message({ type: "session.list.ok", activeSessionId: "late-created", sessions: [] });
      await flushMicrotasks();
    });
    expect(hook.result.current.activeSessionId).toBe("chosen");
    expect(hook.result.current.chat.items).toHaveLength(0);
    await hook.unmount();
  });

  test("two creations only bind the newest correlated acknowledgement; legacy acknowledgement remains compatible", async () => {
    setupBrowser();
    const hook = await renderHook(() => useRemoteApp());
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.newSession({ projectId: null });
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.newSession({ projectId: null });
      await flushMicrotasks();
    });
    const requests = ws.sent
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "session.create");
    expect(requests[0].clientRequestId).not.toBe(requests[1].clientRequestId);
    await act(async () => {
      ws.message({
        type: "chat.accepted",
        clientRequestId: requests[1].clientRequestId,
        sessionId: "newest",
      });
      ws.message({
        type: "chat.accepted",
        clientRequestId: requests[0].clientRequestId,
        sessionId: "older",
      });
      ws.message({ type: "session.list.ok", activeSessionId: "older", sessions: [] });
      await flushMicrotasks();
    });
    expect(hook.result.current.activeSessionId).toBe("newest");
    await act(async () => {
      hook.result.current.newSession();
      ws.message({ type: "chat.accepted", sessionId: "legacy" });
      await flushMicrotasks();
    });
    expect(hook.result.current.activeSessionId).toBe("legacy");
    await hook.unmount();
  });
});

test("the actual Desktop hook/controller pair keeps drafts through create and send acceptance on one socket", async () => {
  setupBrowser();
  const restoreFetch = defineTestProperty(window, "fetch", {
    value: async () => {
      throw new Error("no image requests expected");
    },
    writable: true,
  });
  const onAuthLost = () => {};
  const hook = await renderHook(() => useDesktopController(useRemoteApp(), undefined, onAuthLost));
  const ws = FakeWebSocket.instances[0]!;
  await act(async () => {
    ws.open();
    ws.message({ type: "auth.ok", device: { id: "device-1", name: "Phone" } });
    await flushMicrotasks();
  });
  await act(async () => {
    hook.result.current.newSession();
    await flushMicrotasks();
  });
  const creation = ws.sent
    .map((line) => JSON.parse(line))
    .find((event) => event.type === "session.create");
  await act(async () => {
    hook.result.current.setDraft("typed before session exists");
  });
  await act(async () => {
    ws.message({
      type: "chat.accepted",
      clientRequestId: creation.clientRequestId,
      sessionId: "mobile-durable",
      cwd: null,
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.activeId).toBe("mobile-durable");
  expect(hook.result.current.draft).toBe("typed before session exists");
  await act(async () => {
    hook.result.current.send();
    await flushMicrotasks();
  });
  const message = ws.sent
    .map((line) => JSON.parse(line))
    .find((event) => event.type === "chat.send");
  expect(message.sessionId).toBe("mobile-durable");
  await act(async () => {
    hook.result.current.setDraft("next draft while accepting");
  });
  await act(async () => {
    ws.message({
      type: "chat.accepted",
      clientMessageId: message.clientMessageId,
      sessionId: "mobile-durable",
      cwd: null,
    });
    await flushMicrotasks();
  });
  expect(hook.result.current.draft).toBe("next draft while accepting");
  expect(hook.result.current.chat.items.filter((item) => item.kind === "user")).toHaveLength(1);
  expect(FakeWebSocket.instances).toHaveLength(1);
  await hook.unmount();
  restoreFetch();
});
