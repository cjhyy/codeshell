import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../src/test-utils/renderHook.js";
import { useRemoteApp } from "../src/hooks/useRemoteApp.js";
import { useDesktopController } from "./DesktopApp.js";

// The real paired hook and Desktop controller over a scripted WebSocket.
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: Array<Record<string, any>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const restores: Array<() => void> = [];
function define(target: object, key: PropertyKey, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  FakeWebSocket.instances = [];
});

async function pairedController(outputJournal = false) {
  ensureMiniDom();
  FakeWebSocket.instances = [];
  const values = new Map([
    ["cs.deviceId", "device-1"],
    ["cs.deviceSecret", "secret-1"],
    ["cs.deviceName", "Phone"],
  ]);
  define(globalThis, "localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  define(globalThis, "WebSocket", FakeWebSocket);
  define(window, "location", {
    origin: "http://127.0.0.1:3000",
    search: "",
    pathname: "/mobile",
  });
  define(window, "history", { replaceState() {} });
  define(window, "fetch", async () => {
    throw new Error("paired send tests make no HTTP requests");
  });
  const hook = await renderHook(() => {
    const app = useRemoteApp();
    return { app, controller: useDesktopController(app, undefined, () => {}) };
  });
  const online = async () => {
    const ws = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      ws.open();
      ws.message({
        type: "auth.ok",
        device: { id: "device-1", name: "Phone" },
        ...(outputJournal ? { capabilities: { outputJournal: 1 } } : {}),
      });
      await flushMicrotasks();
    });
    return ws;
  };
  const ws = await online();
  await act(async () => {
    hook.result.current.app.selectSession("native");
    await flushMicrotasks();
  });
  return { hook, ws, online };
}

const chatSends = (ws: FakeWebSocket) => ws.sent.filter((frame) => frame.type === "chat.send");

test("a retry after a lost acceptance reuses the original intent ID", async () => {
  const { hook, ws, online } = await pairedController();
  try {
    await act(async () => {
      hook.result.current.controller.setDraft("execute task once");
    });
    await act(async () => {
      expect(hook.result.current.controller.send()).toBe(true);
      await flushMicrotasks();
    });
    const first = chatSends(ws)[0]!;
    // The host may have queued the task; the connection drops before chat.accepted.
    await act(async () => {
      ws.close();
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(hook.result.current.controller.draft).toBe("execute task once");
    expect(hook.result.current.controller.uncertain).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const reconnected = await online();
    expect(reconnected).not.toBe(ws);
    await act(async () => {
      expect(hook.result.current.controller.send()).toBe(true);
      await flushMicrotasks();
    });
    expect(chatSends(reconnected)[0]!.clientMessageId).toBe(first.clientMessageId);
  } finally {
    await hook.unmount();
  }
});

test("a recovered record of the unconfirmed message clears its duplicate draft", async () => {
  const { hook, ws, online } = await pairedController();
  try {
    await act(async () => {
      hook.result.current.controller.setDraft("execute task once");
    });
    await act(async () => {
      hook.result.current.controller.send();
      await flushMicrotasks();
    });
    const first = chatSends(ws)[0]!;
    await act(async () => {
      ws.close();
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const reconnected = await online();
    await act(async () => {
      reconnected.message({
        method: "agent/streamEvent",
        params: {
          sessionId: "native",
          event: {
            type: "session_user_message",
            text: "execute task once",
            clientMessageId: first.clientMessageId,
          },
        },
      });
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(hook.result.current.controller.uncertain).toBe(false);
    expect(hook.result.current.controller.draft).toBe("");
  } finally {
    await hook.unmount();
  }
});

test("an explicit rejection keeps the task and a follow-up typed meanwhile", async () => {
  const { hook, ws } = await pairedController();
  try {
    await act(async () => {
      hook.result.current.controller.setDraft("Original long task");
    });
    await act(async () => {
      hook.result.current.controller.send();
      await flushMicrotasks();
    });
    await act(async () => {
      hook.result.current.controller.setDraft("Follow-up question");
    });
    const sent = chatSends(ws)[0]!;
    await act(async () => {
      ws.message({
        type: "error",
        message: "Configuration is being updated",
        clientMessageId: sent.clientMessageId,
      });
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(hook.result.current.controller.draft).toBe("Original long task\n\nFollow-up question");
    expect(hook.result.current.controller.uncertain).toBe(false);
    expect(hook.result.current.controller.error).toContain("之后输入的内容也已保留");
  } finally {
    await hook.unmount();
  }
});

test("background output before a new session is confirmed cannot take its draft", async () => {
  const { hook, ws } = await pairedController();
  try {
    await act(async () => {
      hook.result.current.controller.newSession();
      await flushMicrotasks();
    });
    const creation = ws.sent.find((frame) => frame.type === "session.create")!;
    await act(async () => {
      hook.result.current.controller.setDraft("task for the new session");
    });
    await act(async () => {
      ws.message({
        type: "session.stream",
        sessionId: "unrelated-background",
        seq: 1,
        event: { type: "text_delta", text: "other task output" },
      });
      ws.message({
        method: "agent/streamEvent",
        params: { sessionId: "unrelated-background", event: { type: "text_delta", text: "raw" } },
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.app.activeSessionId).toBeUndefined();
    expect(hook.result.current.controller.draft).toBe("task for the new session");
    await act(async () => {
      ws.message({
        type: "chat.accepted",
        clientRequestId: creation.clientRequestId,
        sessionId: "actually-created",
        cwd: null,
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.controller.activeId).toBe("actually-created");
    expect(hook.result.current.controller.draft).toBe("task for the new session");
    expect(hook.result.current.app.unreadSessionIds.has("unrelated-background")).toBe(true);
  } finally {
    await hook.unmount();
  }
});

test("creating a session while offline changes nothing instead of losing the request", async () => {
  const { hook, ws, online } = await pairedController();
  try {
    await act(async () => {
      ws.close();
      await flushMicrotasks();
    });
    expect(hook.result.current.app.status).toBe("offline");
    await act(async () => {
      hook.result.current.controller.newSession();
      await flushMicrotasks();
    });
    expect(hook.result.current.app.activeSessionId).toBe("native");
    expect(hook.result.current.controller.activeId).toBe("native");
    expect(hook.result.current.controller.error).toContain("重新连接");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const reconnected = await online();
    expect(ws.sent.some((frame) => frame.type === "session.create")).toBe(false);
    expect(reconnected.sent.some((frame) => frame.type === "session.create")).toBe(false);
  } finally {
    await hook.unmount();
  }
});

test("a disconnect cancels a started image upload so text can be sent after reconnecting", async () => {
  const { hook, ws, online } = await pairedController();
  const puts: Array<{ url: string; signal?: AbortSignal | null }> = [];
  define(window, "fetch", (url: string, init?: RequestInit) => {
    puts.push({ url, signal: init?.signal });
    // A stalled network: the request settles only if it is aborted.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  });
  try {
    await act(async () => {
      hook.result.current.controller.setDraft("photo task");
      hook.result.current.controller.addFiles([
        new File([new Uint8Array(300 * 1024)], "large.png", { type: "image/png" }),
      ] as unknown as FileList);
    });
    await act(async () => {
      expect(hook.result.current.controller.send()).toBe(true);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const begin = ws.sent.find((frame) => frame.type === "attachment.upload.begin")!;
    await act(async () => {
      ws.message({
        type: "attachment.upload.ready",
        clientId: begin.clientId,
        uploadId: "upload-1",
        putUrl: "/api/mobile/uploads/upload-1",
        expiresAt: Date.now() + 300_000,
      });
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(puts).toHaveLength(1);
    await act(async () => {
      ws.close();
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(puts[0]!.signal?.aborted).toBe(true);
    expect(hook.result.current.controller.uploadBusy).toBe(false);
    expect(hook.result.current.controller.draft).toBe("photo task");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const reconnected = await online();
    await act(async () => {
      for (const file of hook.result.current.controller.files)
        hook.result.current.controller.removeFile(file.id);
      hook.result.current.controller.setDraft("independent text");
    });
    await act(async () => {
      expect(hook.result.current.controller.send()).toBe(true);
      await flushMicrotasks();
    });
    expect(chatSends(reconnected)[0]!.text).toBe("independent text");
  } finally {
    await hook.unmount();
  }
});

test("paired external selection sends its model and subscribes to output after acceptance", async () => {
  const { hook, ws } = await pairedController(true);
  try {
    expect(ws.sent.some((event) => event.type === "runtime.models")).toBe(true);
    await act(async () => {
      const selection = ws.sent.findLast((event) => event.type === "session.select")!;
      ws.message({
        type: "session.recovery.ready",
        sessionId: "native",
        recoveryId: selection.recoveryId,
        ok: true,
        journalRequired: true,
      });
      await flushMicrotasks();
      const read = ws.sent.findLast((event) => event.type === "session.outputJournal")!;
      ws.message({
        ...read,
        page: { version: 1, status: "unavailable", frames: [], complete: false },
      });
      ws.message({
        type: "runtime.models.ok",
        models: [
          {
            key: "codex/fixture",
            label: "Codex Fixture",
            provider: "codex",
            kind: "codex",
            maxContextTokens: 1000,
          },
        ],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      (hook.result.current.controller.modelSelector as any).props.onChange("codex/fixture");
      hook.result.current.controller.setDraft("external task");
    });
    await act(async () => {
      hook.result.current.controller.send();
      await flushMicrotasks();
    });
    const sent = chatSends(ws).at(-1)!;
    expect(sent.modelKey).toBe("codex/fixture");
    const before = ws.sent.length;
    await act(async () => {
      ws.message({
        type: "chat.accepted",
        sessionId: "native",
        clientMessageId: sent.clientMessageId,
        modelKey: "codex/fixture",
      });
      await flushMicrotasks();
    });
    expect(
      ws.sent
        .slice(before)
        .some(
          (event) =>
            event.type === "session.select" && event.sessionId === "native" && event.recoveryId,
        ),
    ).toBe(true);
  } finally {
    await hook.unmount();
  }
});
