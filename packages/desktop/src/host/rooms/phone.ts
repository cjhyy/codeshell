import {
  mobileTranscriptSubscriberId,
  type MobileServerEvent,
  type TurnQueueDispatchResult,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { createOwnedRooms } from "./runtime.js";
import {
  MobileTurnQueueHost,
  submitThroughOriginalPath,
  type QueuedDispatch,
} from "../../main/mobile-remote/turn-queue-host.js";
import {
  handleRoomEvent,
  type MobileRoomContext,
} from "../../main/mobile-remote/handle-room-event.js";
import {
  handleCcRoomEvent,
  type MobileCcRoomContext,
} from "../../main/mobile-remote/handle-cc-room-event.js";
import type { AuthenticatedMobileClientEvent } from "../../main/mobile-remote/handle-client-event.js";
import {
  requireRendererLinkedSessionPath,
  requireRendererProjectPath,
} from "../../main/renderer-project-path.js";
import { mobileRoomModeRequesterKey } from "../../main/cc-room/room-mode-authority.js";

export interface RoomPhoneEffects {
  authorize(deviceId: string, viewerId?: string): Promise<void>;
  send(
    scope: "viewer" | "device" | "broadcast",
    id: string | undefined,
    event: MobileServerEvent,
  ): void;
  uploads: MobileRoomContext["uploads"] & {
    retain(device: string, id: string): Promise<void>;
    discard(device: string, id: string): Promise<void>;
  };
  settle: MobileRoomContext["settleMobileUploadClaims"];
  projects: MobileRoomContext["sendProjectList"];
  history: NonNullable<MobileRoomContext["roomHistory"]>;
  read: MobileCcRoomContext["readCcRoom"];
}
import { isRoomPhoneEvent } from "../../main/mobile-remote/room-route.js";
type Owned = ReturnType<typeof createOwnedRooms>;
export function roomPhoneActions(rooms: Owned, effects: RoomPhoneEffects) {
  const viewers = new Map<string, string>();
  let devices: string[] = [];
  const lifetime = new AbortController();
  const remote = {
    hasAuthenticatedViewer: (viewer: string, device: string) =>
      !lifetime.signal.aborted && viewers.get(viewer) === device,
    onlineDeviceIds: () => devices,
    sendToDevice: (id: string, event: MobileServerEvent) => effects.send("device", id, event),
    sendToViewer: (id: string, event: MobileServerEvent) => effects.send("viewer", id, event),
    broadcast: (event: MobileServerEvent) => effects.send("broadcast", undefined, event),
  };
  const ctx: MobileRoomContext & MobileCcRoomContext = {
    remote,
    roomManager: rooms.manager,
    recheckCreate: async (cwd) => {
      if ((await requireRendererProjectPath(cwd)) !== cwd) throw Error("Room project changed");
    },
    roomModes: rooms.modes,
    roomHistory: effects.history,
    roomToPublic: rooms.publicRoom,
    sendProjectList: effects.projects,
    uploads: effects.uploads,
    settleMobileUploadClaims: effects.settle,
    approvalBridge: rooms.approvals,
    transcriptSubscriptions: rooms.transcripts,
    readCcRoom: effects.read,
    requireLinkedSessionPath: requireRendererLinkedSessionPath,
    broadcastRoomState: rooms.changed,
    roomMatchesTranscript: rooms.matches,
  };
  async function queued(dispatch: QueuedDispatch): Promise<TurnQueueDispatchResult> {
    const { event, deviceId, roomMode } = dispatch;
    if (event.type !== "room.send") throw Error("Unsupported queued room command");
    let stopped = false;
    const current = () => {
      lifetime.signal.throwIfAborted();
      if (dispatch.stopped()) {
        stopped = true;
        throw Error("房间已停止，排队消息尚未发送。");
      }
      if (rooms.manager.effectiveMode(event.roomId) !== roomMode)
        throw Error("房间权限模式已变更。");
      if (
        !dispatch.detached &&
        (!event.viewerId || !remote.hasAuthenticatedViewer(event.viewerId, deviceId))
      )
        throw Error("设备连接已结束");
    };
    const authorize = async () => {
      await effects.authorize(deviceId, dispatch.detached ? undefined : event.viewerId);
      current();
    };
    try {
      await authorize();
      const result = await submitThroughOriginalPath(remote, event, (transport) =>
        handleRoomEvent(
          { ...ctx, remote: transport, authorizeSubmit: authorize, beforePhysicalSubmit: current },
          event,
        ),
      );
      return stopped
        ? { ok: false, requeue: true, message: "房间已停止，排队消息尚未发送。" }
        : result;
    } catch (error) {
      return {
        ok: false,
        ...(stopped ? { requeue: true } : {}),
        message: error instanceof Error ? error.message : "房间消息尚未发送。",
      };
    }
  }
  const queue = new MobileTurnQueueHost({
    remote,
    uploads: effects.uploads,
    isSessionBusy: () => false,
    isSessionAuthorized: () => false,
    captureSession: async () => undefined,
    room: (id) => {
      const room = rooms.manager.getRoom(id);
      return (
        room && {
          observing: room.linkedSessionMode === "observe-only",
          mode: rooms.manager.effectiveMode(id),
          busy: rooms.manager.isExecutionBusy(id),
        }
      );
    },
    submit: queued,
  });
  rooms.manager.setHostTurnHooks({
    hasPendingTurns: (roomId) => queue.hasPendingTurns({ kind: "room", roomId }),
    beforeClose: (roomId) => queue.pauseForStop({ kind: "room", roomId }),
  });
  return {
    async handle(event: AuthenticatedMobileClientEvent, signal: AbortSignal) {
      const { deviceId, viewerId } = event;
      if (!deviceId || !viewerId || !isRoomPhoneEvent(event))
        throw Error("Unauthenticated room command");
      await effects.authorize(deviceId, viewerId);
      signal.throwIfAborted();
      lifetime.signal.throwIfAborted();
      viewers.set(viewerId, deviceId);
      queue.observeViewer(viewerId, deviceId);
      const current = () => {
        signal.throwIfAborted();
        if (!remote.hasAuthenticatedViewer(viewerId, deviceId))
          throw Error("requester disconnected");
      };
      const authorize = async () => {
        await effects.authorize(deviceId, viewerId);
        current();
      };
      if (
        event.type === "room.open" ||
        event.type === "room.create" ||
        event.type === "ccRoom.unsubscribeTranscript"
      )
        rooms.modes.cancelRequester(mobileRoomModeRequesterKey(viewerId));
      if (queue.control(event) || (await queue.submit(event))) return;
      current();
      queue.before(event);
      if (event.type === "room.create") {
        const cwd = await requireRendererProjectPath(event.cwd);
        current();
        event = { ...event, cwd };
      }
      if (event.type.startsWith("ccRoom.")) {
        let subscribed = false;
        await handleCcRoomEvent(
          {
            ...ctx,
            assertCurrent: current,
            remote: {
              ...remote,
              sendToViewer: (v, e) => {
                if (v === viewerId && e.type === "ccRoom.transcriptSubscribed") subscribed = true;
                remote.sendToViewer(v, e);
              },
              hasAuthenticatedViewer: (v, d) =>
                !signal.aborted && remote.hasAuthenticatedViewer(v, d),
            },
          },
          event,
        );
        if (event.type === "ccRoom.subscribeTranscript") return subscribed;
      } else
        await handleRoomEvent(
          { ...ctx, beforePhysicalSubmit: current, authorizeSubmit: authorize },
          event,
        );
    },
    presence: (online: string[]) => {
      devices = online;
    },
    observed: (roomId: string, message: unknown) => queue.observeRoomMessage(roomId, message),
    left(viewer: string) {
      viewers.delete(viewer);
      queue.releaseViewer(viewer);
      rooms.modes.cancelRequester(mobileRoomModeRequesterKey(viewer));
      rooms.transcripts.unsubscribeSubscriber(mobileTranscriptSubscriberId(viewer));
    },
    cancel(viewer: string) {
      rooms.modes.cancelRequester(mobileRoomModeRequesterKey(viewer));
    },
    close() {
      lifetime.abort();
      queue.dispose();
      viewers.clear();
    },
  };
}
