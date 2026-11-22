import type { BrowserWindow } from "electron";
import type {
  MobileUploadService,
  RemoteHostManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { RoomHistoryAccess } from "../../shared/room-history.js";
import { createTaskInboxBackgroundHost } from "../task-inbox/task-inbox-background-host.js";
import { confirmOnDesktop } from "../cc-room/room-mode-ipc.js";
import type { createDesktopHost } from "../desktop-host/main.js";
import type { MobileRemoteOrchestratorDeps } from "../mobile-remote-orchestrator.js";

/** Route Host-owned room events to the native documents and paired sockets that own their views. */
export function bindNativeRooms(
  host: Pick<ReturnType<typeof createDesktopHost>, "remote" | "documentSignal" | "callBusiness">,
  remote: RemoteHostManager,
  uploads: MobileUploadService,
  windows: Set<BrowserWindow>,
  getBridge: MobileRemoteOrchestratorDeps["getBridge"],
  projects: (device: string) => Promise<void>,
) {
  const hostedRooms = host.remote.createRooms({
    remote,
    uploads,
    document: host.documentSignal,
    confirm: confirmOnDesktop,
    listBackground: createTaskInboxBackgroundHost({ worker: getBridge }).list,
    projects,
    publish(event) {
      const publishToWindows = (channel: string, data: unknown) => {
        for (const window of windows)
          if (!window.isDestroyed()) window.webContents.send(channel, data);
      };
      switch (event.type) {
        case "room.message":
          remote.broadcast(event);
          publishToWindows("room:message", { roomId: event.roomId, msg: event.msg });
          return;
        case "room.changed":
          publishToWindows("ccRoom:roomState", event.room);
          return;
        case "room.recovery":
          publishToWindows("ccRoom:transcriptRecovery", {
            roomId: event.roomId,
            message: event.message,
          });
          break;
        case "ccRoom.approvalRequest":
          publishToWindows("ccRoom:approvalRequest", { roomId: event.roomId, ...event.req });
          break;
        case "ccRoom.approvalResolved":
          publishToWindows("ccRoom:approvalResolved", {
            roomId: event.roomId,
            requestId: event.requestId,
            decision: event.decision,
          });
          break;
      }
      remote.broadcast(event);
    },
  });
  const roomHistory: RoomHistoryAccess = {
    getMessages: async (roomId, sinceSeq = 0) =>
      host.callBusiness("rooms/messages", {
        rootIdentity: await hostedRooms.root(),
        roomId,
        sinceSeq,
      }),
    getHistoryPage: async (roomId, request = {}) =>
      host.callBusiness("rooms/historyPage", {
        rootIdentity: await hostedRooms.root(),
        roomId,
        request,
      }),
  };
  return { hostedRooms, roomHistory };
}
