import type { ChatSessionManager } from "./chat-session-manager.js";
import type { NotificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { listBackgroundWorkForUI } from "../tool-system/builtin/background-work.js";
import { createErrorResponse, createResponse, ErrorCodes, type RpcRequest } from "./types.js";
import type { Transport } from "./transport.js";

export function validCloseSessionRequest(
  request: RpcRequest,
  transport: Pick<Transport, "send">,
): boolean {
  const params = (request.params ?? {}) as { sessionId?: unknown; onlyIfIdle?: unknown };
  if (
    typeof params.sessionId === "string" &&
    params.sessionId.length > 0 &&
    (params.onlyIfIdle === undefined || typeof params.onlyIfIdle === "boolean")
  )
    return true;
  transport.send(
    createErrorResponse(
      request.id,
      ErrorCodes.InvalidParams,
      "valid Session close request is required",
    ),
  );
  return false;
}

/** An explicit checkpoint may unload only an already idle owner, without reaping its history. */
export async function closeIdleOutputHistorySession(
  request: RpcRequest,
  transport: Pick<Transport, "send">,
  deps: {
    manager?: ChatSessionManager | null;
    mailbox: NotificationQueue;
    pendingStarts: boolean;
    closed(): void;
  },
): Promise<void> {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const session = deps.manager?.get(sessionId);
  const busy =
    session?.isBusy() ||
    session?.pendingApprovals.size ||
    deps.pendingStarts ||
    deps.mailbox.getSnapshot(sessionId).length ||
    listBackgroundWorkForUI(sessionId).some((entry) =>
      ["starting", "running", "cancelling", "unknown"].includes(
        entry.kind === "shell" ? entry.shell.status : entry.status,
      ),
    );
  if (busy || !deps.manager) {
    transport.send(
      createErrorResponse(request.id, ErrorCodes.InvalidParams, "Session is not idle"),
    );
    return;
  }
  // Unloading publishes its owner fence synchronously before disposal awaits.
  // Unlike ordinary delete, this path never kills shells or drops retained jobs.
  await deps.manager.unloadIdleSession(sessionId);
  deps.closed();
  transport.send(createResponse(request.id, { ok: true }));
}
