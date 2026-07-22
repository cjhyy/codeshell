import { describe, expect, test } from "bun:test";
import type { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import { openLinkedSessionFromIpc, takeOverLinkedSessionFromIpc } from "./linked-session-ipc.js";

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
