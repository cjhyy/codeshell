import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import { RoomManager as DiskRoomManager } from "../../../../server/src/mobile-remote/room-manager.js";
import {
  openLinkedSessionFromIpc,
  registerRoomHistoryIpc,
  takeOverLinkedSessionFromIpc,
} from "./linked-session-ipc.js";
import {
  openRoomSettings,
  roomSettingsState,
  registerRoomSettingsIpc,
} from "./room-settings-ipc.js";

const historyRoots: string[] = [];

test("native room settings preserve exact identity, validate input, and return Host-applied settings", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: any[] = [];
  const broadcasts: string[] = [];
  const meta = {
    id: "room_native",
    cwd: "/private/tmp/project",
    kind: "codex",
    permissionMode: "default",
    claudeSessionId: "thread-native",
    modelKey: "codex/old",
  };
  let busy: string | undefined = "queued";
  const deps: Parameters<typeof openRoomSettings>[0] = {
    roomManager: {
      getRoom: (id) => (id === meta.id ? (meta as any) : undefined),
      roomBusyReason: () => busy as any,
      effectiveMode: () => "acceptEdits",
      isExecutionBusy: () => true,
    },
    roomModes: {
      openSession: async (input) => {
        calls.push(input);
        return {
          roomId: meta.id,
          status: "running",
          mode: "acceptEdits",
          modelKey: input.modelKey ?? undefined,
          changed: true,
          requestedMode: input.mode,
          approved: false,
        };
      },
    },
    broadcastRoomState: (id) => broadcasts.push(id),
  };
  registerRoomSettingsIpc(
    { handle: (channel, fn) => void handlers.set(channel, fn) },
    (event, action) => {
      if (action.op === "settings")
        return roomSettingsState(deps.roomManager, action.roomId) as any;
      if (action.op !== "openSession") throw Error("unexpected request");
      return openRoomSettings(deps, action, {
        key: "desktop:" + event.sender.id,
        channel: "desktop",
        ownerWebContentsId: event.sender.id,
        assertCurrent() {
          if (event.sender.isDestroyed()) throw Error("window closed");
        },
      });
    },
  );
  const state = handlers.get("ccRoom:settingsState")!({}, meta.id);
  expect(state).toEqual({
    roomId: meta.id,
    sessionId: "thread-native",
    cwd: meta.cwd,
    kind: "codex",
    permissionMode: "acceptEdits",
    modelKey: "codex/old",
    observing: false,
    busyReason: "queued",
  });
  busy = undefined;
  expect(handlers.get("ccRoom:settingsState")!({}, meta.id).busyReason).toBe("retiring");
  const invoke = (settings: unknown) =>
    handlers.get("ccRoom:openSession")!(
      { sender: { id: 7, isDestroyed: () => false } },
      "thread-native",
      "/tmp/project",
      "default",
      "codex",
      settings,
    );
  for (const invalid of [
    null,
    [],
    {},
    { roomId: "" },
    { roomId: meta.id, modelKey: 3 },
    { roomId: meta.id, modelKey: "native/model" },
    { roomId: meta.id, modelKey: "codex/bad\nmodel" },
  ])
    await expect(invoke(invalid)).rejects.toThrow("invalid CLI settings request");
  expect(calls).toHaveLength(0);
  expect(await invoke({ roomId: meta.id, modelKey: "codex/new" })).toEqual({
    roomId: meta.id,
    cwd: meta.cwd,
    status: "running",
    permissionMode: "acceptEdits",
    modelKey: "codex/new",
  });
  expect(calls[0]).toMatchObject({
    sessionId: "thread-native",
    cwd: "/tmp/project",
    kind: "codex",
    roomId: meta.id,
    mode: "default",
    modelKey: "codex/new",
    requester: { key: "desktop:7" },
  });
  expect((await invoke({ roomId: meta.id, modelKey: null })).modelKey).toBeNull();
  expect(broadcasts).toEqual([meta.id, meta.id]);
});
afterEach(() => {
  for (const root of historyRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function historyHandler(manager: Parameters<typeof registerRoomHistoryIpc>[1]) {
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>();
  registerRoomHistoryIpc(
    {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    manager,
  );
  expect([...handlers.keys()]).toEqual(["ccRoom:roomHistory"]);
  return (roomId: string, request?: unknown) =>
    handlers.get("ccRoom:roomHistory")!({} as IpcMainInvokeEvent, roomId, request);
}

test("actual Main history registrar preserves legacy reads and resumes frozen pages across Host restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "cc-room-ipc-history-"));
  historyRoots.push(root);
  const manager = () =>
    new DiskRoomManager({
      rootDir: root,
      createAgent: () => {
        throw new Error("history reads must not start a CLI");
      },
      onMessage() {},
    });
  const rooms = manager();
  const room = rooms.createRoom({ cwd: root });
  rooms.beginTranscriptFollow(room.id);
  rooms.ingestTranscriptMessages(
    room.id,
    Array.from({ length: 5 }, (_, index) => ({
      from: "agent" as const,
      type: "text",
      text: `message-${index + 1}`,
    })),
  );
  const invoke = historyHandler(rooms);
  expect((await invoke(room.id)).map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  expect((await invoke(room.id, 3)).map((message) => message.seq)).toEqual([4, 5, 6]);
  const first = await invoke(room.id, { sinceSeq: 0, limit: 2 });
  expect(first.messages.map((message) => message.seq)).toEqual([1, 2]);
  expect(first.throughSeq).toBe(6);
  rooms.ingestTranscriptMessages(room.id, [
    { from: "agent", type: "text", text: "later-live-message" },
  ]);
  rooms.endTranscriptFollow(room.id);
  const cold = manager();
  const resume = historyHandler(cold);
  const second = await resume(room.id, { cursor: first.nextCursor, limit: 2 });
  const third = await resume(room.id, { cursor: second.nextCursor, limit: 2 });
  expect(
    [...first.messages, ...second.messages, ...third.messages].map((message) => message.seq),
  ).toEqual([1, 2, 3, 4, 5, 6]);
  expect(third.complete).toBe(true);
  expect(third.throughSeq).toBe(6);
  expect((await resume(room.id, 6)).map((message) => message.seq)).toEqual([7]);
  const other = cold.createRoom({ cwd: root });
  await expect(resume(other.id, { cursor: first.nextCursor })).rejects.toThrow();
});

test("malformed page objects never enter either legacy read or filesystem pagination", async () => {
  let calls = 0;
  const invoke = historyHandler({
    getMessages: () => {
      calls++;
      return [];
    },
    getHistoryPage: () => {
      calls++;
      throw new Error("must not reach storage");
    },
  });
  for (const request of [
    null,
    [],
    "0",
    true,
    new Date(),
    { extra: 1 },
    { sinceSeq: -1 },
    { sinceSeq: Number.MAX_SAFE_INTEGER + 1 },
    { sinceSeq: NaN },
    { limit: 0 },
    { limit: 501 },
    { limit: 1.5 },
    { cursor: 1 },
    { cursor: "" },
    { cursor: "x".repeat(2049) },
    { cursor: "x", sinceSeq: 0 },
  ]) {
    await expect(invoke("room_one_two", request)).rejects.toThrow(/invalid room history request/);
  }
  expect(calls).toBe(0);
});

function managerDouble(): {
  manager: Pick<RoomManager, "openLinkedSession" | "takeOverLinkedSession">;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  return {
    calls,
    manager: {
      openLinkedSession: (externalSessionId, cwd, kind) => {
        calls.push(["open", externalSessionId, cwd, kind]);
        return {
          roomId: "room_one_two",
          status: "observing",
          mode: "default",
          cwd: "/canonical/project",
        };
      },
      takeOverLinkedSession: async (roomId, externalSessionId, cwd, kind) => {
        calls.push(["takeover", roomId, externalSessionId, cwd, kind]);
        return {
          roomId,
          status: "running",
          mode: "default",
          cwd: "/canonical/project",
        };
      },
    },
  };
}

describe("linked-session IPC handlers", () => {
  test("open returns the RoomManager canonical observe-only result", () => {
    const { manager, calls } = managerDouble();
    expect(openLinkedSessionFromIpc(manager, "thread-1", "/project", "codex")).toEqual({
      roomId: "room_one_two",
      status: "observing",
      mode: "default",
      cwd: "/canonical/project",
    });
    expect(calls).toEqual([["open", "thread-1", "/project", "codex"]]);
  });

  test("takeover is a separate explicit operation", async () => {
    const { manager, calls } = managerDouble();
    await expect(
      takeOverLinkedSessionFromIpc(manager, "room_one_two", "claude-1", "/project", "claude-code"),
    ).resolves.toEqual({
      roomId: "room_one_two",
      status: "running",
      mode: "default",
      cwd: "/canonical/project",
    });
    expect(calls).toEqual([["takeover", "room_one_two", "claude-1", "/project", "claude-code"]]);
  });

  test("invalid tuples fail before RoomManager is called", () => {
    const { manager, calls } = managerDouble();
    expect(() => openLinkedSessionFromIpc(manager, "", "/project", "codex")).toThrow(/session id/i);
    expect(() => openLinkedSessionFromIpc(manager, "thread", "", "codex")).toThrow(/cwd/i);
    expect(() => openLinkedSessionFromIpc(manager, "thread", "/project", "other")).toThrow(/kind/i);
    expect(() => takeOverLinkedSessionFromIpc(manager, "", "thread", "/project", "codex")).toThrow(
      /room id/i,
    );
    expect(calls).toEqual([]);
  });
});
