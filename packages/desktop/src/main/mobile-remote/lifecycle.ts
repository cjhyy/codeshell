import {
  mobileTranscriptSubscriberId,
  type MobileViewerIdentity,
  type RemoteHostManager,
  type RoomManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { TranscriptSubscriptionManager } from "../cc-room/transcript-subscriptions.js";
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
