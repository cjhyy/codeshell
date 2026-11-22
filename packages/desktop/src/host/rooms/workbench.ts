import {
  isRoomApprovalDecision,
  type RoomKind,
  type RoomMeta,
} from "@cjhyy/code-shell-server/mobile-remote";
import { listBackgroundWorkForUI } from "@cjhyy/code-shell-core/internal";
import {
  requireRendererLinkedSessionPath,
  requireRendererProjectPath,
} from "../../main/renderer-project-path.js";
import { DriveAgentTranscriptAccess } from "../../main/cc-room/drive-agent-transcript-access.js";
import {
  openLinkedSessionFromIpc,
  takeOverLinkedSessionAtHost,
} from "../../main/cc-room/linked-session-ipc.js";
import { roomSettingsState, openRoomSettings } from "../../main/cc-room/room-settings-ipc.js";
import type { ApprovalDecision } from "../../main/cc-room/approval-bridge.js";
import type { createOwnedRooms } from "./runtime.js";
import type { CcRoomSettingsRequest, MobilePermissionMode } from "../../shared/mobile-remote.js";
type Owned = ReturnType<typeof createOwnedRooms>;
export type WorkbenchRoomCall =
  | { op: "list" }
  | {
      op: "create";
      input: { name?: string; cwd: string; kind?: RoomKind; permissionMode?: MobilePermissionMode };
    }
  | { op: "open" | "close" | "end" | "settings" | "unsubscribe"; roomId: string }
  | { op: "send"; roomId: string; text: string }
  | { op: "respond"; roomId: string; requestId: string; decision: ApprovalDecision }
  | {
      op: "openSession";
      sessionId: string;
      cwd: string;
      kind?: RoomKind;
      mode: MobilePermissionMode;
      settings?: CcRoomSettingsRequest;
    }
  | { op: "linked"; sessionId: string; cwd: string; kind: RoomKind; source?: unknown }
  | {
      op: "takeOver" | "subscribe";
      roomId: string;
      sessionId: string;
      cwd: string;
      kind: RoomKind;
      limit?: number;
    };
export interface RoomDocument {
  id: number;
  key: string;
  assertCurrent(): void;
}
export function workbenchRoomActions(
  rooms: Owned,
  list: ConstructorParameters<typeof DriveAgentTranscriptAccess>[0],
  paths: {
    requirePath: typeof requireRendererLinkedSessionPath;
    readLocal: NonNullable<ConstructorParameters<typeof DriveAgentTranscriptAccess>[1]>;
  } = {
    requirePath: requireRendererLinkedSessionPath,
    readLocal: () => listBackgroundWorkForUI("task-inbox", { scope: "all" }),
  },
) {
  const access = new DriveAgentTranscriptAccess(list, paths.readLocal);
  return {
    release(key: string) {
      access.forgetSender(key);
      rooms.transcripts.unsubscribeSubscriber(key);
      rooms.modes.cancelRequester(key);
    },
    async run(call: WorkbenchRoomCall, doc: RoomDocument) {
      doc.assertCurrent();
      const m = rooms.manager;
      switch (call.op) {
        case "list":
          return m.listRooms().map(rooms.publicRoom);
        case "create": {
          const input = call.input;
          if (
            !input ||
            (input.kind !== undefined && input.kind !== "claude-code" && input.kind !== "codex") ||
            (input.name !== undefined &&
              (typeof input.name !== "string" || input.name.length > 512)) ||
            (input.permissionMode !== undefined &&
              !["default", "acceptEdits", "bypassPermissions"].includes(input.permissionMode))
          )
            throw Error("invalid room configuration");
          const cwd = await requireRendererProjectPath(input.cwd);
          const kind = input.kind ?? "claude-code";
          const grant = await rooms.modes.resolveCreateMode(kind, cwd, input.permissionMode);
          if ((await requireRendererProjectPath(input.cwd)) !== cwd)
            throw Error("Room project changed");
          if (grant.trustedBypass && !(await rooms.modes.isTrusted(kind, cwd)))
            throw Error("房间所在目录的信任状态已变更。");
          doc.assertCurrent();
          const room = m.createRoom({ name: input.name, cwd, kind, permissionMode: grant.mode });
          if (grant.trustedBypass) rooms.modes.grantTrusted(room.id, room.cwd, room.kind);
          return rooms.publicRoom(room);
        }
        case "open":
          return m.open(call.roomId);
        case "end":
        case "close":
          if (call.op === "end") rooms.transcripts.endRoom(call.roomId);
          m.close(call.roomId);
          access.forgetRoom(doc.key, call.roomId);
          return;
        case "send":
          if (typeof call.text !== "string" || call.text.length > 512 * 1024)
            throw Error("invalid room message");
          return m.send(call.roomId, call.text);
        case "settings":
          return roomSettingsState(m, call.roomId);
        case "openSession":
          return openRoomSettings(
            { roomManager: m, roomModes: rooms.modes, broadcastRoomState: rooms.changed },
            call,
            {
              key: doc.key,
              channel: "desktop",
              ownerWebContentsId: doc.id,
              assertCurrent: doc.assertCurrent,
            },
          );
        case "respond":
          if (!isRoomApprovalDecision(call.decision)) throw Error("Invalid room approval choice");
          return rooms.approvals.respond(call.roomId, call.requestId, call.decision);
        case "linked": {
          const open = (id: string, cwd: string, kind: RoomMeta["kind"]) => {
            doc.assertCurrent();
            return openLinkedSessionFromIpc(m, id, cwd, kind);
          };
          let path: string;
          try {
            path = await paths.requirePath(call.cwd);
          } catch (error) {
            doc.assertCurrent();
            if (call.source === undefined) throw error;
            const result = await access.open(
              doc.key,
              call.source,
              { externalSessionId: call.sessionId, cwd: call.cwd, kind: call.kind },
              (target) => open(target.externalSessionId, target.cwd, target.kind),
            );
            doc.assertCurrent();
            return result;
          }
          return open(call.sessionId, path, call.kind);
        }
        case "takeOver":
          return takeOverLinkedSessionAtHost(
            {
              roomManager: m,
              assertCurrent: doc.assertCurrent,
              requirePath: async (value) => {
                const path = await paths.requirePath(value);
                doc.assertCurrent();
                return path;
              },
              broadcastRoomState: rooms.changed,
            },
            call.roomId,
            call.sessionId,
            call.cwd,
            call.kind,
          );
        case "subscribe": {
          let path: string;
          try {
            path = await paths.requirePath(call.cwd);
          } catch {
            path = await access.requireSubscription(doc.key, call.roomId, {
              externalSessionId: call.sessionId,
              cwd: call.cwd,
              kind: call.kind,
            });
          }
          doc.assertCurrent();
          if (!rooms.matches(call.roomId, path, call.sessionId, call.kind))
            throw Error("cc-room transcript subscription does not match the opened room");
          return {
            ...rooms.transcripts.subscribe({
              subscriberId: doc.key,
              roomId: call.roomId,
              cwd: path,
              sessionId: call.sessionId,
              kind: call.kind,
              limit: call.limit ?? 100,
            }),
            approvals: rooms.approvals.pendingRequests(call.roomId),
          };
        }
        case "unsubscribe":
          rooms.transcripts.unsubscribe(doc.key, call.roomId);
          return;
      }
    },
  };
}
