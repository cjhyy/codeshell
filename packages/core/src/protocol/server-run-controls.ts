/** Stop and steer share the worker's current-turn identity boundary. */
import type { Engine } from "../engine/engine.js";
import type { ChatSession } from "./chat-session.js";
import type { ChatSessionManager } from "./chat-session-manager.js";
import type { Transport } from "./transport.js";
import {
  ErrorCodes,
  createErrorResponse,
  createResponse,
  type RpcRequest,
  type SteerParams,
} from "./types.js";

interface RunControlHost {
  transport: Pick<Transport, "send">;
  chatManager: ChatSessionManager | null;
}

interface CancelHost extends RunControlHost {
  cancelRunStarts: (manager: ChatSessionManager, sessionId: string) => boolean;
  cancelSessionApprovals: (session: ChatSession) => void;
  cancelLegacyRun: () => boolean;
}

interface SteerHost extends RunControlHost {
  legacyEngine: Engine | null;
}

export function handleCancelRequest(req: RpcRequest, host: CancelHost): void {
  const params = (req.params ?? {}) as unknown as import("./types.js").CancelParams;

  if (params.expectedClientMessageId !== undefined) {
    if (
      typeof params.expectedClientMessageId !== "string" ||
      !params.expectedClientMessageId.trim() ||
      typeof params.sessionId !== "string" ||
      !params.sessionId
    ) {
      host.transport.send(
        createErrorResponse(
          req.id,
          ErrorCodes.InvalidParams,
          "sessionId and a non-empty expectedClientMessageId are required",
        ),
      );
      return;
    }
    if (!host.chatManager) {
      host.transport.send(
        createErrorResponse(
          req.id,
          ErrorCodes.InvalidParams,
          "Scoped cancellation requires a managed session",
        ),
      );
      return;
    }
    const session = host.chatManager.get(params.sessionId);
    const stopped = session?.cancelActiveTurn(params.expectedClientMessageId) ?? false;
    if (stopped && session) host.cancelSessionApprovals(session);
    // A late Stop is scoped to its original turn. It must neither cancel a
    // newer start reservation nor drain queued closure/report turns.
    host.transport.send(createResponse(req.id, { ok: true, stopped }));
    return;
  }

  // ChatSessionManager path: cancel a specific session
  if (host.chatManager) {
    if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
      host.transport.send(
        createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"),
      );
      return;
    }
    const manager = host.chatManager;
    const stoppedStart = host.cancelRunStarts(manager, params.sessionId);
    const s = manager.get(params.sessionId);
    if (!s && stoppedStart) {
      host.transport.send(createResponse(req.id, { ok: true }));
      return;
    }
    if (!s) {
      host.transport.send(
        createErrorResponse(
          req.id,
          ErrorCodes.SessionClosed,
          `No such session: ${params.sessionId}`,
        ),
      );
      return;
    }
    s.cancel();
    // s.cancel() only aborts the engine controller + drains queued turns. The
    // session's pendingApprovals (askUser / browser_action / tool approvals)
    // are NOT driven directly by the abort signal. Left alone, an awaiting
    // AskUserQuestion would now wait forever, while bounded request types
    // would wait until APPROVAL_TIMEOUT_MS. Resolve them as cancelled now and
    // clear any matching timers, mirroring the legacy path below.
    host.cancelSessionApprovals(s);
    host.transport.send(createResponse(req.id, { ok: true }));
    return;
  }

  if (!host.cancelLegacyRun()) {
    host.transport.send(
      createErrorResponse(req.id, ErrorCodes.SessionClosed, "Agent is not running"),
    );
    return;
  }
  host.transport.send(createResponse(req.id, { ok: true }));
}

export function handleSteerRequest(req: RpcRequest, host: SteerHost): void {
  const params = (req.params ?? {}) as unknown as SteerParams;
  if (!params.text || !params.sessionId) {
    host.transport.send(
      createErrorResponse(req.id, ErrorCodes.InvalidParams, "text and sessionId required"),
    );
    return;
  }
  if (params.expectedClientMessageId !== undefined) {
    if (
      typeof params.expectedClientMessageId !== "string" ||
      !params.expectedClientMessageId.trim()
    ) {
      host.transport.send(
        createErrorResponse(
          req.id,
          ErrorCodes.InvalidParams,
          "expectedClientMessageId must be a non-empty string",
        ),
      );
      return;
    }
    const session = host.chatManager?.get(params.sessionId);
    if (!session?.matchesActiveTurn(params.expectedClientMessageId)) {
      host.transport.send(
        createResponse(req.id, {
          ok: true,
          accepted: false,
          ...(params.id ? { id: params.id } : {}),
        }),
      );
      return;
    }
  }
  if (host.chatManager?.isUnavailable(params.sessionId)) {
    host.transport.send(
      createErrorResponse(
        req.id,
        ErrorCodes.SessionClosed,
        `Session is closing or closed: ${params.sessionId}`,
      ),
    );
    return;
  }
  const engine = host.chatManager
    ? host.chatManager.get(params.sessionId)?.engine
    : host.legacyEngine;
  if (!engine) {
    host.transport.send(
      createErrorResponse(req.id, ErrorCodes.SessionClosed, `No such session: ${params.sessionId}`),
    );
    return;
  }
  try {
    const result = engine.enqueueSteer(
      params.sessionId,
      params.text,
      params.id,
      params.clientMessageId,
      params.attachments,
    );
    host.transport.send(createResponse(req.id, { ok: true, ...result }));
  } catch (err) {
    host.transport.send(
      createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message),
    );
  }
}
