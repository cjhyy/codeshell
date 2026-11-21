import {
  mobileTranscriptSubscriberId,
  type MobileViewerIdentity,
  type RemoteHostManager,
  type RoomManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { TranscriptSubscriptionManager } from "../cc-room/transcript-subscriptions.js";
import type { ApprovalBridge } from "../cc-room/approval-bridge.js";
import type { MobileRemoteOrchestrator } from "../mobile-remote-orchestrator.js";

/** Bind socket cleanup and persisted room retention once at Desktop startup. */
export function initializeMobileRemoteLifecycle(
  remote: RemoteHostManager,
  orchestrator: MobileRemoteOrchestrator,
  transcripts: TranscriptSubscriptionManager,
  rooms: RoomManager,
): void {
  // Abruptly closed tabs cannot unsubscribe. Revoke only their viewer, preserving
  // other tabs authenticated as the same device.
  remote.on("viewer-offline", ({ viewerId }: MobileViewerIdentity) => {
    orchestrator.releaseViewer(viewerId);
    transcripts.unsubscribeSubscriber(mobileTranscriptSubscriberId(viewerId));
  });
  // Running rooms are never reaped. Cleanup is best-effort during startup.
  const maxIdleMs = 14 * 24 * 60 * 60 * 1000;
  try {
    const reaped = rooms.pruneStaleRooms(maxIdleMs);
    if (reaped.length) console.log(`[rooms] pruned ${reaped.length} stale room(s)`);
  } catch {
    /* Never block startup on retention cleanup. */
  }
}

/**
 * RoomManager.onRoomEnded for Desktop. RoomManager calls it for EVERY way a
 * room's process ends: a phone's room.close, a Desktop window closing the CLI
 * session, Host shutdown, and the CLI exiting on its own. Phones learn here
 * that no turn can still run in the room; previously only a phone-initiated
 * close told them, so Desktop-side closes left the remote stuck "running".
 * The room list is not republished: a closing process stays fenced (listed
 * open) until its exit is proven, and RoomManager republishes it then.
 */
export function publishRoomEnded(
  deps: {
    approvals: Pick<ApprovalBridge, "cancelRoom">;
    transcripts: Pick<TranscriptSubscriptionManager, "endRoom">;
    remote: Pick<RemoteHostManager, "broadcast">;
  },
  roomId: string,
): void {
  deps.approvals.cancelRoom(roomId);
  deps.transcripts.endRoom(roomId);
  deps.remote.broadcast({ type: "room.closed", roomId });
}
