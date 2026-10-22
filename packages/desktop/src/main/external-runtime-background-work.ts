/**
 * Main-process delivery of background work launched by an external runtime:
 * DriveAgent jobs and Host Bash shells share the notification queue, and both
 * count as finite work an external Goal waits on instead of re-prompting.
 */
import {
  agentNotificationBus,
  backgroundJobRegistry,
  backgroundShellManager,
  buildNotificationMessage,
  notificationQueue,
} from "@cjhyy/code-shell-core/internal";
import type { ExternalRuntimeBackgroundWorkDelivery } from "./external-runtime-service.js";

export function createExternalRuntimeBackgroundWork(
  shells: Pick<typeof backgroundShellManager, "hasExitWaitForSession"> = backgroundShellManager,
): ExternalRuntimeBackgroundWorkDelivery {
  return {
    subscribe: (listener) => agentNotificationBus.subscribe(listener),
    drainMessage: (sessionId) => {
      const pending = notificationQueue.drainAll(sessionId);
      return pending.length > 0 ? buildNotificationMessage(pending) : undefined;
    },
    hasPending: (sessionId) => notificationQueue.getSnapshot(sessionId).length > 0,
    // An external provider turn cannot yield like the native Engine's runYield,
    // so a Bash shell explicitly launched with wait_for_exit is finite work too.
    // Services (background_behavior=continue) never park the Goal.
    hasRunning: (sessionId) =>
      backgroundJobRegistry.hasRunningForSession(sessionId) ||
      shells.hasExitWaitForSession(sessionId),
    dropSession: (sessionId) => {
      backgroundJobRegistry.dropForSession(sessionId);
      notificationQueue.reset(sessionId);
    },
  };
}
