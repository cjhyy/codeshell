import type { Engine } from "../engine/engine.js";
import { logger } from "../logging/logger.js";
import type { StreamEvent } from "../types.js";
import {
  buildNotificationMessage,
  notificationQueue,
  type NotificationQueue,
} from "../tool-system/builtin/agent-notifications.js";
import type { ApprovalRouter } from "../tool-system/permission.js";
import type { ChatSession } from "./chat-session.js";
import type { ChatSessionManager } from "./chat-session-manager.js";
import type { WorkspaceContext } from "../workspace/workspace-context.js";

interface BackgroundRunWorkspace {
  cwd?: string;
  workspaceContext?: WorkspaceContext;
}

interface BackgroundResultWakeOptions {
  sessionId: string;
  manager: ChatSessionManager | null;
  rehydrate(sessionId: string): Promise<ChatSession | null>;
  approvalRouter: ApprovalRouter;
  onStream(event: StreamEvent): void;
  notificationMailbox?: NotificationQueue;
  /** Reconstruct fresh host authority for a cold, project-bound Session. */
  resolveWorkspace?(session: ChatSession): Promise<BackgroundRunWorkspace>;
}

/**
 * Drain pending background results into exactly one synthetic continuation.
 * Busy sessions are awaited so a completion cannot fall into the gap between
 * the notification bus callback and the interactive run-boundary re-check.
 */
export async function wakeSessionForBackgroundResults({
  sessionId,
  manager,
  rehydrate,
  approvalRouter,
  onStream,
  notificationMailbox = notificationQueue,
  resolveWorkspace,
}: BackgroundResultWakeOptions): Promise<boolean> {
  if (!manager) {
    logger.debug("bg_wakeup.skipped", { sessionId, reason: "no_chat_manager" });
    return false;
  }
  if (manager.isUnavailable(sessionId)) {
    logger.debug("bg_wakeup.skipped", { sessionId, reason: "session_unavailable" });
    return false;
  }
  if (notificationMailbox.getSnapshot(sessionId).length === 0) {
    logger.debug("bg_wakeup.skipped", { sessionId, reason: "no_pending_results" });
    return false;
  }
  let session = manager.get(sessionId) ?? (await rehydrate(sessionId));
  if (!session) {
    logger.debug("bg_wakeup.skipped", { sessionId, reason: "session_missing" });
    return false;
  }

  let runWorkspace: BackgroundRunWorkspace;
  for (;;) {
    if (manager.isUnavailable(sessionId) || manager.get(sessionId) !== session) {
      logger.debug("bg_wakeup.skipped", { sessionId, reason: "session_owner_changed" });
      return false;
    }
    while (session.isBusy()) {
      logger.debug("bg_wakeup.waiting_for_idle", {
        sessionId,
        pendingCount: notificationMailbox.getSnapshot(sessionId).length,
      });
      await session.settled;
      if (manager.isUnavailable(sessionId)) {
        logger.debug("bg_wakeup.skipped", {
          sessionId,
          reason: "session_became_unavailable",
        });
        return false;
      }
      const current = manager.get(sessionId);
      if (!current) {
        logger.debug("bg_wakeup.skipped", { sessionId, reason: "session_evicted_after_settle" });
        return false;
      }
      session = current;
    }

    // Headless/automation runs are one-shot and have no continuation consumer.
    if (session.engine.isHeadless()) {
      logger.debug("bg_wakeup.skipped", { sessionId, reason: "headless" });
      return false;
    }
    // A user Stop must win over a later background completion.
    if (session.wasCancelledSinceLastTurn()) {
      logger.debug("bg_wakeup.skipped", { sessionId, reason: "cancelled_since_last_turn" });
      return false;
    }

    if (notificationMailbox.getSnapshot(sessionId).length === 0) {
      logger.debug("bg_wakeup.skipped", { sessionId, reason: "no_pending_results" });
      return false;
    }
    const resolvedEngine = session.engine;
    const settledBeforeResolution = session.settled;
    try {
      if (resolveWorkspace) {
        runWorkspace = await resolveWorkspace(session);
      } else {
        const resolver = (
          session.engine as Engine & {
            resolveSessionRunWorkspace?: (sessionId: string) => BackgroundRunWorkspace;
          }
        ).resolveSessionRunWorkspace;
        runWorkspace = resolver?.call(session.engine, sessionId) ?? {};
      }
    } catch (error) {
      // Resolve before draining so an unavailable authoritative worktree context
      // leaves the completion recoverable by a later user run.
      logger.warn("bg_wakeup.workspace_unavailable", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    // Host resolution yields to other turns, Stop, close and root migration.
    // Validate ownership before consuming anything, and never carry a context
    // across an intervening run boundary even when that run already finished.
    if (manager.isUnavailable(sessionId) || manager.get(sessionId) !== session) {
      logger.debug("bg_wakeup.skipped", { sessionId, reason: "session_owner_changed" });
      return false;
    }
    if (session.wasCancelledSinceLastTurn()) {
      logger.debug("bg_wakeup.skipped", { sessionId, reason: "cancelled_since_last_turn" });
      return false;
    }
    if (
      session.isBusy() ||
      session.engine !== resolvedEngine ||
      session.settled !== settledBeforeResolution
    ) {
      continue;
    }
    break;
  }

  const pending = notificationMailbox.drainAll(sessionId);
  if (pending.length === 0) {
    logger.debug("bg_wakeup.skipped", { sessionId, reason: "no_pending_results" });
    return false;
  }
  const task = `<system-reminder>\n${buildNotificationMessage(pending)}\n</system-reminder>`;
  try {
    const result = await session.enqueueTurn(task, {
      injected: true,
      ...runWorkspace,
      onStream,
      approvalRouter,
    });
    if (result.turnCount === 0) {
      const restored = notificationMailbox.restoreResults(sessionId, pending);
      logger.warn("bg_wakeup.turn_not_started", {
        sessionId,
        restored,
        reason: result.reason,
        text: result.text.slice(0, 500),
      });
      return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const restored = notificationMailbox.restoreResults(sessionId, pending);
    logger.warn("bg_wakeup.turn_failed", { sessionId, error: message, restored });
    // A setup failure can occur before the turn loop emits its own terminal
    // event. Emit an error so every renderer clears its busy state, but keep
    // the result queued so a later user turn can consume it safely.
    onStream({ type: "error", error: message || "background wakeup failed" });
    return false;
  }
  return true;
}
