/**
 * Main-process delivery of background work launched by an external runtime:
 * DriveAgent jobs and Host Bash shells share the notification queue, and both
 * count as finite work an external Goal waits on instead of re-prompting.
 */
import {
  agentNotificationBus,
  backgroundJobRegistry,
  backgroundShellManager,
  notificationQueue,
} from "@cjhyy/code-shell-core/internal";
import type { ExternalRuntimeBackgroundWorkDelivery } from "./external-runtime-service.js";

const MAX_WAITING_TASKS = 8;
const MAX_WAITING_LABEL_CHARS = 80;

/** One-line, bounded label; job descriptions are model-written (untrusted). */
function waitingLabel(description: string | undefined): string {
  const line = (description || "(background job)").replace(/\s+/gu, " ").trim();
  return line.length > MAX_WAITING_LABEL_CHARS
    ? `${line.slice(0, MAX_WAITING_LABEL_CHARS - 1)}…`
    : line;
}

export function createExternalRuntimeBackgroundWork(
  shells: Pick<typeof backgroundShellManager, "hasExitWaitForSession"> = backgroundShellManager,
): ExternalRuntimeBackgroundWorkDelivery {
  return {
    subscribe: (listener) => agentNotificationBus.subscribe(listener),
    claimResults: (sessionId) => notificationQueue.claimResults(sessionId),
    hasPending: (sessionId) =>
      notificationQueue.getSnapshot(sessionId).some((item) => item.kind === "result"),
    // An external provider turn cannot yield like the native Engine's runYield,
    // so a Bash shell explicitly launched with wait_for_exit is finite work too.
    // Services (background_behavior=continue) never park the Goal.
    hasRunning: (sessionId) =>
      backgroundJobRegistry.hasRunningForSession(sessionId) ||
      shells.hasExitWaitForSession(sessionId),
    listRunning: (sessionId) =>
      backgroundJobRegistry
        .listRunningForSession(sessionId)
        .slice(0, MAX_WAITING_TASKS)
        .map((job) => ({ kind: "job", label: waitingLabel(job.description) })),
    dropSession: (sessionId) => {
      backgroundJobRegistry.dropForSession(sessionId);
      notificationQueue.reset(sessionId);
    },
  };
}
