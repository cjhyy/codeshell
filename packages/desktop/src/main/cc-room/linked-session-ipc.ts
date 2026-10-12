import type { RoomKind, RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import type { IpcMain } from "electron";

export function registerRoomHistoryIpc(
  ipcMain: Pick<IpcMain, "handle">,
  roomManager: Pick<RoomManager, "getMessages" | "getHistoryPage">,
): void {
  // Keep the existing Main IPC authority and legacy number/undefined result.
  // Only a validated object selects the frozen-page contract; malformed
  // objects must never fall through to the legacy cursor's normalization.
  ipcMain.handle("ccRoom:roomHistory", async (_e, roomId: string, request: unknown) => {
    if (request === undefined || typeof request === "number")
      return roomManager.getMessages(roomId, request ?? 0);
    return roomManager.getHistoryPage(roomId, parseHistoryRequest(request));
  });
}

function parseHistoryRequest(value: unknown): Parameters<RoomManager["getHistoryPage"]>[1] {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).some((key) => !["sinceSeq", "cursor", "limit"].includes(key))
  )
    throw new Error("invalid room history request");
  const request = value as { sinceSeq?: unknown; cursor?: unknown; limit?: unknown };
  if (
    (request.sinceSeq !== undefined &&
      (typeof request.sinceSeq !== "number" ||
        !Number.isSafeInteger(request.sinceSeq) ||
        request.sinceSeq < 0)) ||
    (request.limit !== undefined &&
      (typeof request.limit !== "number" ||
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 500)) ||
    (request.cursor !== undefined &&
      (typeof request.cursor !== "string" ||
        request.cursor.length < 1 ||
        request.cursor.length > 2048 ||
        request.sinceSeq !== undefined))
  )
    throw new Error("invalid room history request bounds");
  return request as Parameters<RoomManager["getHistoryPage"]>[1];
}

type LinkedSessionRoomManager = Pick<RoomManager, "openLinkedSession" | "takeOverLinkedSession">;

export function openLinkedSessionFromIpc(
  roomManager: LinkedSessionRoomManager,
  externalSessionId: unknown,
  cwd: unknown,
  kind: unknown,
): ReturnType<RoomManager["openLinkedSession"]> {
  const target = parseTarget(externalSessionId, cwd, kind);
  return roomManager.openLinkedSession(target.externalSessionId, target.cwd, target.kind);
}

export function takeOverLinkedSessionFromIpc(
  roomManager: LinkedSessionRoomManager,
  roomId: unknown,
  externalSessionId: unknown,
  cwd: unknown,
  kind: unknown,
): ReturnType<RoomManager["takeOverLinkedSession"]> {
  if (typeof roomId !== "string" || !roomId.trim()) throw new Error("room id is required");
  const target = parseTarget(externalSessionId, cwd, kind);
  return roomManager.takeOverLinkedSession(
    roomId,
    target.externalSessionId,
    target.cwd,
    target.kind,
  );
}

function parseTarget(
  externalSessionId: unknown,
  cwd: unknown,
  kind: unknown,
): { externalSessionId: string; cwd: string; kind: RoomKind } {
  if (typeof externalSessionId !== "string" || !externalSessionId.trim()) {
    throw new Error("external session id is required");
  }
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("cwd is required");
  if (kind !== "claude-code" && kind !== "codex") {
    throw new Error("unsupported linked session kind");
  }
  return { externalSessionId, cwd, kind };
}
