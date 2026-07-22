import type { RoomKind, RoomManager } from "@cjhyy/code-shell-server/mobile-remote";

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
