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

  test("passes a validated digital-human or team selection through the IPC boundary", async () => {
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

    await dispatch({}, { type: "chat", message: "research", digitalHumanId: "researcher" });
    await dispatch({}, { type: "chat", message: "ship it", digitalHumanTeamId: "delivery-team" });

    expect(received).toEqual([
      {
        type: "chat",
        message: "research",
        digitalHumanId: "researcher",
        clientMessageId: expect.stringMatching(/^pet-/),
      },
      {
        type: "chat",
        message: "ship it",
        digitalHumanTeamId: "delivery-team",
        clientMessageId: expect.stringMatching(/^pet-/),
      },
    ]);
    expect(() =>
      dispatch(
        {},
        {
          type: "chat",
          message: "ambiguous",
          digitalHumanId: "researcher",
          digitalHumanTeamId: "delivery-team",
        },
      ),
    ).toThrow("invalid pet command");
    expect(() =>
      dispatch({}, { type: "chat", message: "escape", digitalHumanId: "../profile" }),
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

  test("mutates work inbox dismissal state in main and broadcasts the authoritative revision", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: Array<[string, unknown]> = [];
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
});
