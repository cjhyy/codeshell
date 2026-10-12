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

const historyRoots: string[] = [];
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
      takeOverLinkedSession: (roomId, externalSessionId, cwd, kind) => {
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

  test("takeover is a separate explicit operation", () => {
    const { manager, calls } = managerDouble();
    expect(
      takeOverLinkedSessionFromIpc(manager, "room_one_two", "claude-1", "/project", "claude-code"),
    ).toEqual({
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
