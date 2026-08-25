import { describe, expect, test } from "bun:test";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
} from "./pet-state-aggregator";
import { registerPetIpc } from "./pet-ipc";

function snapshot(): DesktopPetProjectionSnapshot {
  return {
    version: 4,
    generation: 2,
    workerState: "active",
    observedAt: 10,
    sessions: [],
    pending: [],
  };
}

describe("registerPetIpc", () => {
  test("exposes validated memory CRUD and broadcasts persisted snapshots", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
    let memoryListener: (() => void) | undefined;
    let entries = [
      { id: "mem-1", text: "before", source: "user" as const, createdAt: 1, updatedAt: 1 },
    ];
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      memories: {
        list: async () => entries,
        remember: async (text) => {
          const entry = {
            id: "mem-2",
            text,
            source: "user" as const,
            createdAt: 2,
            updatedAt: 2,
          };
          entries = [entry, ...entries];
          return entry;
        },
        update: async (id, text) => {
          const previous = entries.find((entry) => entry.id === id)!;
          const updated = { ...previous, text, updatedAt: 3 };
          entries = entries.map((entry) => (entry.id === id ? updated : entry));
          return updated;
        },
        forget: async (id) => {
          const removed = entries.find((entry) => entry.id === id)!;
          entries = entries.filter((entry) => entry.id !== id);
          return removed;
        },
        subscribe: (listener) => {
          memoryListener = listener;
          return () => {};
        },
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push([channel, payload]) },
        },
      ],
    });

    expect(await handlers.get("pet:memories-get")?.({})).toEqual(entries);
    expect(await handlers.get("pet:memory-add")?.({}, "new memory")).toMatchObject({
      id: "mem-2",
      text: "new memory",
    });
    expect(
      await handlers.get("pet:memory-update")?.({}, { id: "mem-1", text: "after" }),
    ).toMatchObject({
      id: "mem-1",
      text: "after",
    });
    expect(await handlers.get("pet:memory-remove")?.({}, "mem-2")).toMatchObject({ id: "mem-2" });
    expect(() => handlers.get("pet:memories-get")?.({}, true)).toThrow("does not accept arguments");
    expect(() => handlers.get("pet:memory-add")?.({}, { text: "bad" })).toThrow(
      "invalid Pet memory text",
    );
    expect(() => handlers.get("pet:memory-update")?.({}, { id: "mem-1" })).toThrow(
      "invalid Pet memory update",
    );
    expect(() => handlers.get("pet:memory-remove")?.({}, 42)).toThrow("invalid Pet memory id");

    memoryListener?.();
    await Promise.resolve();
    expect(sent).toEqual([["pet:memories-changed", entries]]);
  });

  test("exposes validated durable long-task snapshots, controls, and updates", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
    let taskListener:
      | ((snapshot: { revision: number; observedAt: number; tasks: [] }) => void)
      | undefined;
    let controlled: unknown;
    let clearedTaskId: string | undefined;
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      longTasks: {
        getSnapshot: () => ({ revision: 3, observedAt: 30, tasks: [] }),
        control: async (request) => {
          controlled = request;
          return { ok: false, code: "not-found", message: "gone" };
        },
        clearTerminal: async () => ({ revision: 4, observedAt: 40, tasks: [] }),
        clearTask: async (taskId) => {
          clearedTaskId = taskId;
          return { revision: 5, observedAt: 50, tasks: [] };
        },
        subscribe: (listener) => {
          taskListener = listener as typeof taskListener;
          return () => {};
        },
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push([channel, payload]) },
        },
      ],
    });

    expect(await handlers.get("pet:long-tasks-get")?.({})).toEqual({
      revision: 3,
      observedAt: 30,
      tasks: [],
    });
    expect(
      await handlers.get("pet:long-task-control")?.(
        {},
        { taskId: "pet-task-0123456789abcdef01234567", action: "pause" },
      ),
    ).toMatchObject({ ok: false, code: "not-found" });
    expect(controlled).toEqual({
      taskId: "pet-task-0123456789abcdef01234567",
      action: "pause",
    });
    expect(await handlers.get("pet:long-tasks-clear-terminal")?.({})).toEqual({
      revision: 4,
      observedAt: 40,
      tasks: [],
    });
    expect(() => handlers.get("pet:long-tasks-clear-terminal")?.({}, { all: true })).toThrow(
      "does not accept arguments",
    );
    expect(
      await handlers.get("pet:long-task-clear")?.(
        {},
        { taskId: "pet-task-0123456789abcdef01234567" },
      ),
    ).toEqual({ revision: 5, observedAt: 50, tasks: [] });
    expect(clearedTaskId).toBe("pet-task-0123456789abcdef01234567");
    expect(() => handlers.get("pet:long-task-clear")?.({}, { taskId: "../../bad" })).toThrow(
      "invalid Pet long-task cleanup",
    );
    expect(() =>
      handlers.get("pet:long-task-control")?.({}, { taskId: "../../bad", action: "cancel" }),
    ).toThrow("invalid Pet long-task control");
    taskListener?.({ revision: 4, observedAt: 40, tasks: [] });
    expect(sent).toEqual([["pet:long-tasks-changed", { revision: 4, observedAt: 40, tasks: [] }]]);
  });

  test("exposes only the bounded snapshot schema and rejects command payloads", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = {
      handle: (channel: string, next: (event: unknown, ...args: unknown[]) => unknown) =>
        handlers.set(channel, next),
      removeHandler: () => {},
    };
    registerPetIpc({
      ipcMain: ipc,
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      windows: () => [],
    });

    const result = (await handlers.get("pet:get-snapshot")?.({})) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      "generation",
      "observedAt",
      "pending",
      "sessions",
      "version",
      "workerState",
    ]);
    expect(JSON.stringify(result)).not.toContain("coreSessionId");
    expect(() => handlers.get("pet:get-snapshot")?.({}, { command: "rawTranscript" })).toThrow(
      "does not accept arguments",
    );
  });

  test("broadcasts each ordered event once per live window and disposes cleanly", () => {
    let listener: ((event: DesktopPetProjectionEvent) => void) | undefined;
    let removed = false;
    let unsubscribed = false;
    const sent: Array<[string, unknown]> = [];
    const dispose = registerPetIpc({
      ipcMain: {
        handle: () => {},
        removeHandler: () => (removed = true),
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: (next) => {
          listener = next;
          return () => (unsubscribed = true);
        },
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, value) => sent.push([channel, value]) },
        },
        { isDestroyed: () => true, webContents: { send: () => sent.push(["bad", null]) } },
      ],
    });
    const event: DesktopPetProjectionEvent = {
      kind: "reset",
      version: 5,
      generation: 2,
      observedAt: 11,
    };

    listener?.(event);
    expect(sent).toEqual([["pet:projection-event", event]]);
    dispose();
    expect({ removed, unsubscribed }).toEqual({ removed: true, unsubscribed: true });
  });

  test("broadcasts a Pet user message to every window before running the manager turn", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
    let received: unknown;
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      dispatcher: {
        dispatch: async (command) => {
          received = command;
          return { ok: true, type: "chat", petSessionId: "pet-one", result: {} };
        },
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push([channel, payload]) },
        },
      ],
    });

    expect(
      await handlers.get("pet:dispatch")?.(
        {},
        { type: "chat", message: "  organize this  ", clientMessageId: "client-one" },
      ),
    ).toMatchObject({ ok: true, type: "chat" });
    expect(received).toEqual({
      type: "chat",
      message: "  organize this  ",
      clientMessageId: "client-one",
    });
    expect(sent).toEqual([
      [
        "pet:chat-event",
        expect.objectContaining({
          kind: "user-submitted",
          clientMessageId: "client-one",
          message: "organize this",
        }),
      ],
    ]);
    expect(() => handlers.get("pet:dispatch")?.({}, { type: "chat", message: "   " })).toThrow(
      "invalid pet command",
    );
  });

  test("persists /clear as a host-handled control turn", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const receiptInputs: unknown[] = [];
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      dispatcher: {
        dispatch: async () => ({
          ok: true,
          type: "chat",
          petSessionId: "pet-one",
          result: { reason: "context_cleared" },
          authoritativeReply: "上下文已清空。有什么新活要干？",
          contextCleared: true,
        }),
      },
      hostActionReceipt: {
        record: async (input) => {
          receiptInputs.push(input);
          return { message: "上下文已清空。有什么新活要干？", replaceAssistant: true };
        },
      },
      windows: () => [],
    });

    await handlers.get("pet:dispatch")?.(
      {},
      { type: "chat", message: " /clear ", clientMessageId: "clear-one" },
    );

    expect(receiptInputs).toEqual([
      expect.objectContaining({
        petSessionId: "pet-one",
        clientMessageId: "clear-one",
        userMessage: "/clear",
        baseMessage: "上下文已清空。有什么新活要干？",
        replaceAssistant: true,
      }),
    ]);
  });

  test("broadcasts a structured Session receipt after delegated work starts", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      dispatcher: {
        dispatch: async () => ({
          ok: true,
          type: "chat",
          petSessionId: "pet-one",
          result: {},
          delegation: {
            clientMessageId: "client-one",
            task: "continue downloading",
            workspacePath: "/work/project",
            sessionId: "work-session",
            reusedSession: false,
          },
        }),
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push([channel, payload]) },
        },
      ],
    });

    await handlers.get("pet:dispatch")?.(
      {},
      { type: "chat", message: "continue", clientMessageId: "client-one" },
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual([
      "pet:chat-event",
      expect.objectContaining({ kind: "user-submitted", clientMessageId: "client-one" }),
    ]);
    expect(sent[1]).toEqual([
      "pet:chat-event",
      expect.objectContaining({
        kind: "delegation-started",
        originClientMessageId: "client-one",
        delegations: [expect.objectContaining({ sessionId: "work-session" })],
      }),
    ]);
  });

  test("replaces Mimi's stale post-tool text with the host-confirmed delegation launch", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
    let recorded: unknown;
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      dispatcher: {
        dispatch: async () => ({
          ok: true,
          type: "chat",
          petSessionId: "pet-one",
          result: { text: "任务已启动，正在处理。" },
          authoritativeReply: "任务已启动，正在处理。",
          delegation: {
            clientMessageId: "client-one",
            task: "download video",
            workspacePath: "/work/project",
            sessionId: "work-session",
            reusedSession: false,
          },
        }),
      },
      hostActionReceipt: {
        record: async (input) => {
          recorded = input;
          return {
            message: "任务已启动，正在处理。",
            replaceAssistant: true,
          };
        },
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push([channel, payload]) },
        },
      ],
    });

    await handlers.get("pet:dispatch")?.(
      {},
      { type: "chat", message: "download", clientMessageId: "client-one" },
    );

    expect(recorded).toMatchObject({
      petSessionId: "pet-one",
      clientMessageId: "client-one",
      executions: [],
      baseMessage: "任务已启动，正在处理。",
      replaceAssistant: true,
    });
    expect(sent.at(-1)).toEqual([
      "pet:chat-event",
      expect.objectContaining({
        kind: "host-action-completed",
        clientMessageId: "client-one",
        message: "任务已启动，正在处理。",
        replaceAssistant: true,
      }),
    ]);
  });

  test("persists and broadcasts the authoritative host-action receipt after chat", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
    let recorded: unknown;
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      dispatcher: {
        dispatch: async () => ({
          ok: true,
          type: "chat",
          petSessionId: "pet-one",
          result: {},
          hostActions: [
            {
              kind: "followUpMutation",
              payload: { action: "complete", followUpId: "followup-one" },
              ok: true,
              result: { title: "发布准备" },
            },
          ],
        }),
      },
      hostActionReceipt: {
        record: async (input) => {
          recorded = input;
          return { message: "跟进项已处理。" };
        },
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push([channel, payload]) },
        },
      ],
    });

    await handlers.get("pet:dispatch")?.(
      {},
      { type: "chat", message: "完成它", clientMessageId: "client-one" },
    );

    expect(recorded).toMatchObject({
      petSessionId: "pet-one",
      clientMessageId: "client-one",
      executions: [expect.objectContaining({ kind: "followUpMutation", ok: true })],
    });
    expect(sent.at(-1)).toEqual([
      "pet:chat-event",
      expect.objectContaining({
        kind: "host-action-completed",
        clientMessageId: "client-one",
        message: "跟进项已处理。",
      }),
    ]);
  });

  test("marks outbound delivery receipts as replacements for Mimi's untrusted claim", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      dispatcher: {
        dispatch: async () => ({
          ok: true,
          type: "chat",
          petSessionId: "pet-one",
          result: {},
          hostActions: [
            {
              kind: "outboundMessage",
              payload: { targetId: "owner-one", text: "测试" },
              ok: false,
              error: "微信发送准备失败",
            },
          ],
        }),
      },
      hostActionReceipt: {
        record: async () => ({
          message: "主动消息操作失败：微信发送准备失败",
          replaceAssistant: true,
        }),
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push([channel, payload]) },
        },
      ],
    });

    await handlers.get("pet:dispatch")?.(
      {},
      { type: "chat", message: "发测试消息", clientMessageId: "client-send" },
    );

    expect(sent.at(-1)).toEqual([
      "pet:chat-event",
      expect.objectContaining({
        kind: "host-action-completed",
        clientMessageId: "client-send",
        message: "主动消息操作失败：微信发送准备失败",
        replaceAssistant: true,
      }),
    ]);
  });

  test("exposes recoverable Session archive over its own validated IPC call", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    let archivedSessionId: string | undefined;
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      sessionArchive: {
        archive: async (sessionId) => {
          archivedSessionId = sessionId;
          return { ok: true };
        },
      },
      windows: () => [],
    });

    expect(await handlers.get("pet:session-archive")?.({}, "session-one")).toEqual({ ok: true });
    expect(archivedSessionId).toBe("session-one");
    expect(() => handlers.get("pet:session-archive")?.({}, "../session")).toThrow(
      "invalid Pet session archive request",
    );
  });

  test("rejects legacy digital-human routing keys at the Pet IPC boundary", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const received: unknown[] = [];
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      dispatcher: {
        dispatch: async (command) => {
          received.push(command);
          return { ok: true, type: "chat", petSessionId: "pet-one", result: {} };
        },
      },
      windows: () => [],
    });
    const dispatch = handlers.get("pet:dispatch")!;

    expect(() =>
      dispatch({}, { type: "chat", message: "research", digitalHumanId: "researcher" }),
    ).toThrow("invalid pet command");
    expect(() =>
      dispatch({}, { type: "chat", message: "ship it", digitalHumanTeamId: "delivery-team" }),
    ).toThrow("invalid pet command");
    expect(received).toEqual([]);
  });

  test("passes a bounded Pet model selection through the IPC boundary", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    let received: unknown;
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      dispatcher: {
        dispatch: async (command) => {
          received = command;
          return { ok: true, type: "chat", petSessionId: "pet-one", result: {} };
        },
      },
      windows: () => [],
    });
    const dispatch = handlers.get("pet:dispatch")!;

    await dispatch({}, { type: "chat", message: "hello", model: "fast-model" });
    expect(received).toMatchObject({ type: "chat", message: "hello", model: "fast-model" });
    expect(() => dispatch({}, { type: "chat", message: "hello", model: "bad\nmodel" })).toThrow(
      "invalid pet command",
    );
    expect(() => dispatch({}, { type: "chat", message: "hello", model: " padded " })).toThrow(
      "invalid pet command",
    );
    expect(() =>
      dispatch({}, { type: "chat", message: "hello", model: "codex/gpt-5.6-sol" }),
    ).toThrow("invalid pet command");
  });

  test("accepts only a structured navigation request and delegates revalidation", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    let received: unknown;
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async (request) => {
          received = request;
          return { status: "not-found" };
        },
      },
      windows: () => [],
    });
    const request = {
      agentSessionId: "session-a",
      snapshotVersion: 4,
      generation: 2,
      requestId: "req-a",
      routeGeneration: 9,
    };

    expect(await handlers.get("pet:open-session")?.({}, request)).toEqual({
      status: "not-found",
    });
    expect(received).toEqual(request);
    expect(() => handlers.get("pet:open-session")?.({}, { ...request, approve: true })).toThrow(
      "invalid navigation request",
    );
  });

  test("registers immediately but waits for async Pet indexes before serving a snapshot", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let snapshotReads = 0;
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: () => {
          snapshotReads += 1;
          return snapshot();
        },
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      windows: () => [],
      ready,
    });

    const pending = handlers.get("pet:get-snapshot")?.({}) as Promise<unknown>;
    expect(snapshotReads).toBe(0);
    resolveReady?.();
    expect(await pending).toEqual(snapshot());
    expect(snapshotReads).toBe(1);
  });

  test("serves the latest assistant result for a validated session id only", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const removed: string[] = [];
    const readIds: string[] = [];
    const dispose = registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => removed.push(channel as string),
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      latestResult: {
        read: async (sessionId) => {
          readIds.push(sessionId);
          return { text: "done: shipped", truncated: false, timestamp: 42 };
        },
      },
      windows: () => [],
    });
    const handler = handlers.get("pet:session-latest-result")!;

    expect(await handler({}, "session-a_1")).toEqual({
      text: "done: shipped",
      truncated: false,
      timestamp: 42,
    });
    expect(readIds).toEqual(["session-a_1"]);
    expect(() => handler({})).toThrow("invalid session id");
    expect(() => handler({}, "session-a", "extra")).toThrow("invalid session id");
    expect(() => handler({}, 42)).toThrow("invalid session id");
    expect(() => handler({}, "../x")).toThrow("invalid session id");
    expect(() => handler({}, "")).toThrow("invalid session id");
    expect(() => handler({}, "a".repeat(129))).toThrow("invalid session id");
    expect(readIds).toEqual(["session-a_1"]);

    dispose();
    expect(removed).toContain("pet:session-latest-result");
  });

  test("does not register the latest-result handler when the option is absent", () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const removed: string[] = [];
    const dispose = registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => removed.push(channel as string),
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      windows: () => [],
    });

    expect(handlers.has("pet:session-latest-result")).toBe(false);
    dispose();
    expect(removed).not.toContain("pet:session-latest-result");
  });

  test("collects closure summaries and rejects any argument", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const removed: string[] = [];
    let collectCalls = 0;
    const dispose = registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => removed.push(channel as string),
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      summaries: {
        collect: async () => {
          collectCalls += 1;
          return [
            {
              followUpId: "followup-session-a",
              sessionId: "session-a",
              title: "Finished work",
              workspace: "codeshell",
              terminalAt: 42,
              text: "shipped the fix; want me to also add tests?",
            },
          ];
        },
      },
      windows: () => [],
    });
    const handler = handlers.get("pet:summaries-get")!;

    expect(await handler({})).toEqual([
      {
        followUpId: "followup-session-a",
        sessionId: "session-a",
        title: "Finished work",
        workspace: "codeshell",
        terminalAt: 42,
        text: "shipped the fix; want me to also add tests?",
      },
    ]);
    expect(collectCalls).toBe(1);
    expect(() => handler({}, true)).toThrow("does not accept arguments");
    expect(collectCalls).toBe(1);

    dispose();
    expect(removed).toContain("pet:summaries-get");
  });

  test("does not register the summaries handler when the option is absent", () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const removed: string[] = [];
    const dispose = registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => removed.push(channel as string),
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      windows: () => [],
    });

    expect(handlers.has("pet:summaries-get")).toBe(false);
    dispose();
    expect(removed).not.toContain("pet:summaries-get");
  });

  test("mutates work inbox dismissal state in main and broadcasts the authoritative revision", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
    const persistedRevisions: number[] = [];
    let state = { revision: 4, dismissedIds: ["completed:session-a"] };
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      workInbox: {
        getSnapshot: () => state,
        add: (ids) =>
          (state = {
            revision: state.revision + 1,
            dismissedIds: [...new Set([...state.dismissedIds, ...ids])],
          }),
        clear: () => (state = { revision: state.revision + 1, dismissedIds: [] }),
        flush: async () => void persistedRevisions.push(state.revision),
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push([channel, payload]) },
        },
      ],
    });

    expect(await handlers.get("pet:work-inbox-dismissed-get")?.({})).toEqual(state);
    expect(
      await handlers.get("pet:work-inbox-dismissed-update")?.(
        {},
        { action: "add", ids: ["other:session-b"] },
      ),
    ).toEqual({
      revision: 5,
      dismissedIds: ["completed:session-a", "other:session-b"],
    });
    expect(
      await handlers.get("pet:work-inbox-dismissed-update")?.({}, { action: "clear" }),
    ).toEqual({ revision: 6, dismissedIds: [] });
    expect(sent).toEqual([
      [
        "pet:work-inbox-dismissed-changed",
        { revision: 5, dismissedIds: ["completed:session-a", "other:session-b"] },
      ],
      ["pet:work-inbox-dismissed-changed", { revision: 6, dismissedIds: [] }],
    ]);
    expect(persistedRevisions).toEqual([5, 6]);
    expect(() =>
      handlers.get("pet:work-inbox-dismissed-update")?.({}, { action: "add", ids: ["unscoped"] }),
    ).toThrow("invalid work inbox update");
    expect(() =>
      handlers.get("pet:work-inbox-dismissed-update")?.(
        {},
        { action: "clear", ids: ["completed:session-a"] },
      ),
    ).toThrow("invalid work inbox update");
  });

  test("prefers transactional work-inbox mutations when the host provides them", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const calls: string[] = [];
    let state = { revision: 0, dismissedIds: [] as string[] };
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      workInbox: {
        getSnapshot: () => state,
        add: () => {
          calls.push("legacy-add");
          return state;
        },
        clear: () => {
          calls.push("legacy-clear");
          return state;
        },
        flush: async () => void calls.push("legacy-flush"),
        addDurably: async (ids) => {
          calls.push("durable-add");
          return (state = { revision: 1, dismissedIds: [...ids] });
        },
        clearDurably: async () => {
          calls.push("durable-clear");
          return (state = { revision: 2, dismissedIds: [] });
        },
      },
      windows: () => [],
    });

    await handlers.get("pet:work-inbox-dismissed-update")?.(
      {},
      { action: "add", ids: ["follow-up:followup-a"] },
    );
    await handlers.get("pet:work-inbox-dismissed-update")?.({}, { action: "clear" });

    expect(calls).toEqual(["durable-add", "durable-clear"]);
  });

  test("broadcasts follow-up dismissals made outside IPC, including Mimi host actions", () => {
    const sent: Array<[string, unknown]> = [];
    let listener: ((snapshot: { revision: number; dismissedIds: string[] }) => void) | undefined;
    let unsubscribed = false;
    const dispose = registerPetIpc({
      ipcMain: {
        handle: () => {},
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      workInbox: {
        getSnapshot: () => ({ revision: 0, dismissedIds: [] }),
        add: () => ({ revision: 1, dismissedIds: [] }),
        clear: () => ({ revision: 1, dismissedIds: [] }),
        subscribe: (next) => {
          listener = next;
          return () => {
            unsubscribed = true;
          };
        },
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push([channel, payload]) },
        },
      ],
    });

    listener?.({ revision: 1, dismissedIds: ["completed:session-a"] });
    expect(sent).toEqual([
      ["pet:work-inbox-dismissed-changed", { revision: 1, dismissedIds: ["completed:session-a"] }],
    ]);
    dispose();
    expect(unsubscribed).toBe(true);
  });

  test("exposes the journal, segment transcript, and auto-extract preference", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
    let journalListener: (() => void) | undefined;
    const journalEntries = [
      {
        id: "journal-1",
        segmentId: "seg-1",
        title: "调试",
        summary: "修好了",
        startedAt: 1,
        endedAt: 2,
        messageCount: 4,
        range: { start: 0, end: 4 },
      },
    ];
    let autoExtract = true;
    registerPetIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: () => {},
      },
      aggregator: {
        getSnapshot: snapshot,
        subscribe: () => () => {},
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      journal: {
        list: async () => journalEntries,
        subscribe: (listener) => {
          journalListener = listener;
          return () => {};
        },
        readSegmentMessages: async (range) => [
          { role: "user" as const, text: `from ${range.start}` },
          { role: "assistant" as const, text: `to ${range.end}` },
        ],
      },
      preferences: {
        getAutoExtract: async () => autoExtract,
        setAutoExtract: async (enabled) => {
          autoExtract = enabled;
          return enabled;
        },
      },
      windows: () => [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, payload) => sent.push([channel, payload]) },
        },
      ],
    });

    expect(await handlers.get("pet:journal-get")?.({})).toEqual(journalEntries);
    expect(await handlers.get("pet:segment-transcript")?.({}, { start: 0, end: 4 })).toEqual([
      { role: "user", text: "from 0" },
      { role: "assistant", text: "to 4" },
    ]);
    expect(() => handlers.get("pet:segment-transcript")?.({}, { start: 4, end: 0 })).toThrow(
      "invalid segment transcript range",
    );
    expect(() => handlers.get("pet:segment-transcript")?.({}, { start: -1, end: 3 })).toThrow(
      "invalid segment transcript range",
    );

    expect(await handlers.get("pet:prefs-get")?.({})).toEqual({ autoExtract: true });
    expect(await handlers.get("pet:prefs-set-auto-extract")?.({}, false)).toBe(false);
    expect(await handlers.get("pet:prefs-get")?.({})).toEqual({ autoExtract: false });
    expect(() => handlers.get("pet:prefs-set-auto-extract")?.({}, "nope")).toThrow(
      "invalid Pet auto-extract preference",
    );

    journalListener?.();
    await Promise.resolve();
    expect(sent).toEqual([["pet:journal-changed", journalEntries]]);
  });
});
