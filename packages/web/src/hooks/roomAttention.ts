import { useCallback, useMemo, useState } from "react";
import type { MobileServerEvent, RoomPublic } from "@cjhyy/code-shell-core";
import { clearUnreadSession, markSessionUnread, pruneUnreadSessions } from "./remoteAppSync.js";

/**
 * Attention state for external CLI rooms (Claude Code / Codex) the remote is
 * NOT currently viewing: unread assistant output and pending tool approvals.
 *
 * Approval cards themselves stay owned by the viewed room (useRemoteApp only
 * renders, and answers, cards of the bound room). This index only remembers
 * which approval request ids are pending per room, so the room list can show a
 * badge and the user can jump there. A ccRoom.opened reply drops the room's
 * entries: the Host replays every still-pending request right after it, which
 * re-adds the live ones and heals any resolution this browser missed offline.
 */

/** Pending approval ids kept per room; older ids are dropped first. */
export const MAX_ROOM_APPROVALS_PER_ROOM = 20;
/** Rooms tracked with pending approvals; the least recently updated is dropped. */
export const MAX_ROOMS_WITH_APPROVALS = 50;

export type RoomApprovalIndex = ReadonlyMap<string, readonly string[]>;

export function noteRoomApproval(
  index: RoomApprovalIndex,
  roomId: string,
  requestId: string,
): RoomApprovalIndex {
  const current = index.get(roomId) ?? [];
  if (current.includes(requestId)) return index;
  const next = new Map(index);
  next.delete(roomId); // re-insert: Map order = recency
  next.set(roomId, [...current, requestId].slice(-MAX_ROOM_APPROVALS_PER_ROOM));
  while (next.size > MAX_ROOMS_WITH_APPROVALS) next.delete(next.keys().next().value!);
  return next;
}

export function resolveRoomApproval(
  index: RoomApprovalIndex,
  roomId: string,
  requestId: string,
): RoomApprovalIndex {
  const current = index.get(roomId);
  if (!current?.includes(requestId)) return index;
  const next = new Map(index);
  const rest = current.filter((id) => id !== requestId);
  if (rest.length) next.set(roomId, rest);
  else next.delete(roomId);
  return next;
}

export function forgetRoomApprovals(index: RoomApprovalIndex, roomId: string): RoomApprovalIndex {
  if (!index.has(roomId)) return index;
  const next = new Map(index);
  next.delete(roomId);
  return next;
}

/** A room the Host lists as not running cannot be waiting on an approval:
 *  the Host denies every pending request when a room's process ends. */
export function pruneRoomApprovals(
  index: RoomApprovalIndex,
  rooms: readonly RoomPublic[],
): RoomApprovalIndex {
  let next = index;
  for (const room of rooms) if (!room.open) next = forgetRoomApprovals(next, room.id);
  return next;
}

/** Rooms that the Host reported running before and not running now. */
export function roomsThatStopped(
  previous: readonly RoomPublic[],
  current: readonly RoomPublic[],
): string[] {
  const now = new Map(current.map((room) => [room.id, room]));
  return previous
    .filter((room) => room.open && now.get(room.id)?.open === false)
    .map((room) => room.id);
}

/** New assistant output in a room log (see RoomManager's persisted shapes). */
export function isRoomAssistantOutput(msg: unknown): boolean {
  const m = msg as { from?: unknown; type?: unknown } | null;
  return m?.from === "agent" && m.type === "text";
}

export interface RoomAttention {
  roomId: string;
  kind: RoomPublic["kind"];
  /** External CLI session id; a room without one cannot be reopened remotely. */
  sessionId?: string;
  cwd: string;
  name: string;
  permissionMode: RoomPublic["permissionMode"];
  unread: boolean;
  /** Pending approval request ids, oldest first. */
  approvalIds: readonly string[];
}

export function roomAttentionList(
  rooms: readonly RoomPublic[],
  unread: ReadonlySet<string>,
  approvals: RoomApprovalIndex,
  activeRoomId: string | undefined,
): RoomAttention[] {
  return rooms.flatMap((room) => {
    if (room.id === activeRoomId) return [];
    const approvalIds = approvals.get(room.id) ?? [];
    if (!unread.has(room.id) && approvalIds.length === 0) return [];
    return [
      {
        roomId: room.id,
        kind: room.kind,
        ...(room.sessionId ? { sessionId: room.sessionId } : {}),
        cwd: room.cwd,
        name: room.name,
        permissionMode: room.permissionMode,
        unread: unread.has(room.id),
        approvalIds,
      },
    ];
  });
}

/** Room approval cards hidden when their response was sent, kept (bounded)
 *  until resolved so a Host-reported failure can restore the card. */
export class SentRoomApprovals<T extends { requestId: string }> {
  private readonly cards = new Map<string, T>();
  remember(card: T): void {
    this.cards.delete(card.requestId);
    this.cards.set(card.requestId, card);
    if (this.cards.size > MAX_ROOM_APPROVALS_PER_ROOM)
      this.cards.delete(this.cards.keys().next().value!);
  }
  /** Returns (and forgets) the card a response was sent for. */
  take(requestId: string): T | undefined {
    const card = this.cards.get(requestId);
    this.cards.delete(requestId);
    return card;
  }
}

/**
 * React state for room attention. `observe` must see every server event, with
 * the room currently bound; `viewing` is called whenever the viewed room changes.
 */
export function useRoomAttention() {
  const [unread, setUnread] = useState<Set<string>>(() => new Set());
  const [approvals, setApprovals] = useState<RoomApprovalIndex>(() => new Map());
  const [rooms, setRooms] = useState<readonly RoomPublic[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string>();

  const observe = useCallback((event: MobileServerEvent, viewedRoomId: string | undefined) => {
    switch (event.type) {
      case "room.list.ok":
        setRooms(event.rooms);
        setApprovals((prev) => pruneRoomApprovals(prev, event.rooms));
        setUnread((prev) =>
          pruneUnreadSessions(
            prev,
            event.rooms.map((room) => room.id),
          ),
        );
        break;
      case "room.message":
        if (event.roomId !== viewedRoomId && isRoomAssistantOutput(event.msg))
          setUnread((prev) => markSessionUnread(prev, event.roomId));
        break;
      case "room.closed":
      case "ccRoom.opened":
        setApprovals((prev) => forgetRoomApprovals(prev, event.roomId));
        break;
      case "ccRoom.approvalRequest":
        // A Host mode card belongs to one tab's open request, not to the room list.
        if (event.req.purpose !== "room-permission-mode")
          setApprovals((prev) => noteRoomApproval(prev, event.roomId, event.req.requestId));
        break;
      case "ccRoom.approvalResolved":
        setApprovals((prev) => resolveRoomApproval(prev, event.roomId, event.requestId));
        break;
      default:
        break;
    }
  }, []);

  /** The room is now viewed (or none is): its output counts as read. */
  const viewing = useCallback((roomId: string | undefined) => {
    setActiveRoomId(roomId);
    if (roomId) setUnread((prev) => clearUnreadSession(prev, roomId));
  }, []);

  const attention = useMemo(
    () => roomAttentionList(rooms, unread, approvals, activeRoomId),
    [rooms, unread, approvals, activeRoomId],
  );
  return { attention, observe, viewing };
}
