import type { TranscriptSubscriptionManager } from "../cc-room/transcript-subscriptions.js";
import type { ApprovalBridge } from "../cc-room/approval-bridge.js";
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
    remote: { broadcast(event: { type: "room.closed"; roomId: string }): void };
  },
  roomId: string,
): void {
  deps.approvals.cancelRoom(roomId);
  deps.transcripts.endRoom(roomId);
  deps.remote.broadcast({ type: "room.closed", roomId });
}
