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

async function pairedController(
  outputJournal = false,
  options: { nativeModelSelection?: boolean; fetch?: typeof fetch } = {},
) {
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
  const fetch =
    options.fetch ??
    (async () => {
      throw new Error("paired send tests make no HTTP requests");
    });
  define(window, "fetch", fetch);
  if (options.fetch) define(globalThis, "fetch", options.fetch);
  const session = options.fetch
    ? { id: "paired", username: "owned", deviceName: "Phone" }
    : undefined;
  const hook = await renderHook(() => {
    const app = useRemoteApp();
    return {
      app,
      controller: useDesktopController(app, session, () => {}),
    };
  });
  const online = async () => {
    const ws = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      ws.open();
      ws.message({
        type: "auth.ok",
        device: { id: "device-1", name: "Phone" },
        capabilities: {
          ...(outputJournal ? { outputJournal: 1 } : {}),
          ...(options.nativeModelSelection ? { nativeModelSelection: 1 } : {}),
        },
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
        journalRequired: false,
      });
      await flushMicrotasks();
      const read = ws.sent.findLast((event) => event.type === "session.outputJournal")!;
      ws.message({
        ...read,
        page: { version: 1, status: "unavailable", frames: [], complete: false },
        snapshot: { epoch: "native-host", nextSeq: 1, unpaired: false },
      });
      await flushMicrotasks();
    });
    // The selected native Session has legacy history. Complete the actual
    // fallback before changing its model or issuing a new input.
    expect(ws.sent).toContainEqual({ type: "session.history", sessionId: "native" });
    expect(hook.result.current.app.loading.sessionHistory).toBe(true);
    expect(chatSends(ws)).toHaveLength(0);
    await act(async () => {
      ws.message({
        type: "session.history.ok",
        sessionId: "native",
        events: [
          { type: "session_started", sessionId: "native" },
          { type: "user_message", text: "earlier native task" },
          { type: "stream_request_start" },
          { type: "text_delta", text: "saved native answer" },
          { type: "turn_complete", reason: "completed" },
        ],
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
    expect(hook.result.current.app.loading.sessionHistory).toBe(false);
    expect(hook.result.current.app.outputHistoryFailed).toBe(false);
    expect(
      hook.result.current.app.chat.items.some(
        (item) => item.kind === "assistant" && item.text === "saved native answer",
      ),
    ).toBe(true);
    await act(async () => {
      (hook.result.current.controller.modelSelector as any).props.onChange("codex/fixture");
      hook.result.current.controller.setDraft("external task");
    });
    await act(async () => {
      expect(hook.result.current.controller.send()).toBe(true);
      await flushMicrotasks();
    });
    expect(chatSends(ws)).toHaveLength(1);
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

test("an accepted native choice survives actual worker persistence and a fresh phone connection", async () => {
  const { installFixtureNetworkGuard } = await import("../../../tests/helpers/network-fixture.js");
  const network = installFixtureNetworkGuard();
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "paired-native-model-"));
  let hook: Awaited<ReturnType<typeof pairedController>>["hook"] | undefined;
  let manager: { closeAllAsync(): Promise<void> } | undefined;
  let restoreProvider: (() => void) | undefined;
  try {
    // Guard before evaluating the real producer. Only the registered fixture client below
    // can return model output; no tool, provider credential or live socket is used.
    const { Engine } = await import("../../core/src/engine/engine.js");
    const { AgentServer } = await import("../../core/src/protocol/server.js");
    const { ChatSessionManager } = await import("../../core/src/protocol/chat-session-manager.js");
    const { createHubConfiguration } = await import("../../server/src/hub/configuration.js");
    const { listDiskSessions } = await import("../../server/src/sessions-service.js");
    const { dispatchMobileChatTurn } =
      await import("../../server/src/mobile-remote/mobile-chat-turn.js");
    const { prepareMobileNativeModel } =
      await import("../../desktop/src/main/mobile-remote/native-model.js");
    mkdirSync(join(dir, ".code-shell"));
    writeFileSync(
      join(dir, ".code-shell", "settings.json"),
      JSON.stringify({
        credentials: [{ id: "owned", catalogId: "openai", apiKey: "owned-fixture-not-a-secret" }],
        modelConnections: [
          {
            id: "phone-connection",
            credentialId: "owned",
            catalogId: "openai",
            tag: "text",
            model: "codex/owned-native-custom",
            baseUrl: "http://owned-model.invalid/v1",
          },
        ],
        defaults: { text: "phone-connection" },
      }),
    );
    const snapshot = createHubConfiguration({ cwd: dir }).snapshot();
    const requests: Array<{ url: string; model: unknown }> = [];
    const { LLMClientBase } = await import("../../core/src/llm/client-base.js");
    const { PROVIDER_REGISTRY, registerProvider } =
      await import("../../core/src/llm/client-factory.js");
    const previousProvider = PROVIDER_REGISTRY.get("openai");
    restoreProvider = () => {
      if (previousProvider) PROVIDER_REGISTRY.set("openai", previousProvider);
      else PROVIDER_REGISTRY.delete("openai");
    };
    class OwnedClient extends LLMClientBase {
      protected initClient() {}
      async createMessage(options: import("../../core/src/llm/types.js").CreateMessageOptions) {
        if (this.config.baseUrl !== "http://owned-model.invalid/v1")
          throw new Error("non-owned model configuration denied");
        if (options.requestVisible !== false)
          requests.push({ url: this.config.baseUrl, model: this.model });
        const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
        this.recordUsage(usage, options);
        return { text: "owned answer", toolCalls: [], stopReason: "stop" as const, usage };
      }
    }
    registerProvider("openai", OwnedClient);
    const engine = new Engine({
      llm: {
        provider: "openai",
        model: "initial",
        apiKey: "owned-fixture-not-a-secret",
        baseUrl: "http://owned-model.invalid/v1",
      },
      cwd: dir,
      origin: "desktop",
      sessionStorageDir: join(dir, "sessions"),
      settingsScope: "isolated",
      headless: true,
      enabledBuiltinTools: [],
      maxTurns: 2,
    });
    (engine as any).hooks.clear();
    manager = new ChatSessionManager({ runtime: {} as never, engineFactory: () => engine });
    const outbound: any[] = [];
    const listeners = new Set<(line: string) => void>();
    let deliver!: (message: unknown) => void;
    new AgentServer({
      chatManager: manager as InstanceType<typeof ChatSessionManager>,
      transport: {
        send(message) {
          outbound.push(message);
          for (const listener of listeners) listener(JSON.stringify(message));
        },
        onMessage(callback) {
          deliver = callback;
        },
        close() {},
      },
    });
    const bridge = {
      subscribeOutbound(listener: (line: string) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      injectWorkerMessage(line: string) {
        deliver(JSON.parse(line));
      },
    };
    deliver({
      jsonrpc: "2.0",
      id: "owned-initial-run",
      method: "agent/run",
      params: {
        sessionId: "native",
        cwd: dir,
        task: "owned previous input",
        clientMessageId: "owned-initial-input",
      },
    });
    const seedDeadline = Date.now() + 5000;
    while (
      !outbound.some((message) => message.id === "owned-initial-run") &&
      Date.now() < seedDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(outbound.find((message) => message.id === "owned-initial-run")?.result?.reason).toBe(
      "completed",
    );
    const statePath = join(dir, "sessions", "native", "state.json");
    expect(JSON.parse(readFileSync(statePath, "utf8")).model).toBe("initial");
    const initialRequestCount = requests.length;
    expect(initialRequestCount).toBe(1);
    const browserFetch = (async (input) => {
      const url = new URL(String(input), "http://127.0.0.1:3000");
      if (url.origin !== "http://127.0.0.1:3000" || url.pathname !== "/api/v1/configuration")
        throw new Error("non-owned browser request denied");
      return Response.json(snapshot);
    }) as typeof fetch;
    const paired = await pairedController(false, {
      nativeModelSelection: true,
      fetch: browserFetch,
    });
    hook = paired.hook;
    await act(async () => {
      paired.ws.message({ type: "session.history.ok", sessionId: "native", events: [] });
      hook!.result.current.controller.setDraft("owned native request");
      await flushMicrotasks();
    });
    const picker = () => (hook!.result.current.controller.modelSelector as any).props;
    await act(async () => picker().onChange("native:phone-connection"));
    expect(chatSends(paired.ws)).toHaveLength(0);
    expect(requests).toHaveLength(initialRequestCount);
    expect(hook.result.current.app.permissionMode).toBe("default");
    await act(async () => {
      expect(hook!.result.current.controller.send()).toBe(true);
      await flushMicrotasks();
    });
    const intent = chatSends(paired.ws).at(-1)!;
    expect(intent).toMatchObject({
      nativeConnectionId: "phone-connection",
      permissionMode: "default",
      sessionId: "native",
    });
    const selected = prepareMobileNativeModel("native", intent.nativeConnectionId, {
      cwd: dir,
      assertCurrent() {},
    } as never);
    const accepted = await dispatchMobileChatTurn({
      deviceId: "device-1",
      sessionId: "native",
      fallbackCwd: dir,
      text: intent.text,
      clientMessageId: intent.clientMessageId,
      permissionMode: intent.permissionMode,
      configuredModel: selected.configuredModel,
      runId: "owned-native-run",
      bridge,
      meta: { origin: "mobile", producer: "owned-native-model-fixture" },
      uploads: {
        claim: async () => {
          throw new Error("no attachments in fixture");
        },
        release: async () => {},
        finalize: async () => {},
      },
      resolveWorkspace: async () => {
        selected.assertCurrent();
        return dir;
      },
    });
    expect(accepted.ok).toBe(true);
    await act(async () => {
      paired.ws.message({
        type: "chat.accepted",
        sessionId: "native",
        clientMessageId: intent.clientMessageId,
        nativeConnectionId: intent.nativeConnectionId,
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.controller.draft).toBe("");
    // Acceptance alone does not claim an executed model. Wait for the real
    // Engine's final state and use the same fresh disk catalog as Main.
    const deadline = Date.now() + 5000;
    while (!outbound.some((message) => message.id === "owned-native-run") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (
      outbound.find((message) => message.id === "owned-native-run")?.result?.reason !== "completed"
    )
      console.error("owned native fixture", {
        requests,
        errors: outbound
          .filter((message) => /error/i.test(message.params?.event?.type ?? ""))
          .map((message) => ({
            type: message.params.event.type,
            error: message.params.event.error,
          })),
      });
    expect(outbound.find((message) => message.id === "owned-native-run")?.result).toMatchObject({
      reason: "completed",
    });
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect({
      provider: state.provider,
      model: state.model,
      modelConnectionId: state.modelConnectionId,
    }).toEqual({
      provider: "openai",
      model: "codex/owned-native-custom",
      modelConnectionId: "phone-connection",
    });
    expect(requests).toHaveLength(initialRequestCount + 1);
    expect(requests.at(-1)?.model).toBe(state.model);
    const beforeReconnect = requests.length;
    await act(async () => {
      paired.ws.close();
      await flushMicrotasks();
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
    });
    const fresh = await paired.online();
    const list = fresh.sent.findLast((frame) => frame.type === "session.list")!;
    const page = await listDiskSessions({ limit: 100 }, join(dir, "sessions"));
    expect(page.sessions).toHaveLength(1);
    await act(async () => {
      fresh.message({
        type: "session.list.ok",
        requestId: list.requestId,
        activeSessionId: "native",
        ...page,
      });
      await flushMicrotasks();
    });
    // Discovering this previously unbound Session's cwd causes the real
    // controller to request its authorized project page. Answer that distinct
    // request too, as Main would; an unscoped page is not a scoped cache hit.
    const scopedList = fresh.sent.findLast((frame) => frame.type === "session.list")!;
    expect(scopedList.requestId).not.toBe(list.requestId);
    expect(scopedList.cwds).toEqual([dir]);
    const scopedPage = await listDiskSessions(
      { limit: 100, cwds: scopedList.cwds },
      join(dir, "sessions"),
    );
    await act(async () => {
      fresh.message({
        type: "session.list.ok",
        requestId: scopedList.requestId,
        activeSessionId: "native",
        ...scopedPage,
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.app.sessions[0]).toMatchObject({
      provider: state.provider,
      model: state.model,
    });
    expect(picker().value).toBe("session:current-native");
    expect(picker().currentNativeLabel).toBe("openai · codex/owned-native-custom");
    expect(chatSends(fresh)).toHaveLength(0);
    expect(requests).toHaveLength(beforeReconnect);
  } finally {
    await hook?.unmount();
    await manager?.closeAllAsync();
    restoreProvider?.();
    for (const restore of restores.splice(0).reverse()) restore();
    network.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
