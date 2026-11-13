import type { BuiltinQueryContext } from "./context.js";
import {
  createResponse,
  createErrorResponse,
  ErrorCodes,
  type RpcRequest,
  type QueryParams,
} from "../types.js";
import { readOutputJournal } from "../../session/output-journal.js";
import { withoutContextEvents, withoutLocalContextState } from "../../session/context-messages.js";
import { toCompactStreamStrategy } from "../server-output.js";
import { Methods } from "../types.js";
import type { StreamEvent } from "../../types.js";

export async function queryOutputJournal(
  context: Pick<BuiltinQueryContext, "engine" | "send" | "resolveEngine">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!params.sessionId) {
    context.send(
      createErrorResponse(
        req.id,
        ErrorCodes.InvalidParams,
        "sessionId required for output_journal",
      ),
    );
    return;
  }
  const owner = await context.resolveEngine(req, params.sessionId, engine, "output_journal");
  if (!owner) return;
  const data = readOutputJournal(owner.getSessionManager().getStorageDir(), params.sessionId, {
    after: params.after,
    through: params.through,
    maxBytes: params.maxBytes,
    maxFrames: params.maxFrames,
  });
  context.send(createResponse(req.id, { type: "output_journal", data }));
  return;
}

export async function querySessions(
  context: Pick<BuiltinQueryContext, "engine" | "chatManager" | "send" | "hiddenSessionKinds">,
  req: RpcRequest,
  _params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (context.chatManager) {
    // Pet projection and the legacy query share this one live-state builder.
    const { sessions } = context.chatManager.getLiveSessionSnapshot();
    context.send(createResponse(req.id, { type: "sessions", data: sessions }));
  } else if (engine) {
    const sessions = engine
      .getSessionManager()
      .list(undefined, { excludeKinds: context.hiddenSessionKinds })
      .map(withoutLocalContextState);
    context.send(createResponse(req.id, { type: "sessions", data: sessions }));
  } else {
    context.send(createResponse(req.id, { type: "sessions", data: [] }));
  }
  return;
}

export async function querySessionDetail(
  context: Pick<BuiltinQueryContext, "engine" | "resolveEngine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (params.sessionId) {
    const detailEngine = await context.resolveEngine(
      req,
      params.sessionId,
      engine,
      "session_detail",
    );
    if (!detailEngine) return;
    try {
      const bundle = detailEngine.getSessionManager().resume(params.sessionId);
      // A protocol client (TUI resume and export, a TCP client) gets the
      // conversation; engine context stays in the local session files.
      const data = {
        state: withoutLocalContextState(bundle.state),
        transcript: withoutContextEvents(bundle.transcript.getEvents()),
      };
      context.send(createResponse(req.id, { type: "session_detail", data }));
    } catch (err) {
      context.send(createErrorResponse(req.id, ErrorCodes.SessionNotFound, (err as Error).message));
    }
  } else {
    context.send(
      createErrorResponse(
        req.id,
        ErrorCodes.InvalidParams,
        "sessionId required for session_detail",
      ),
    );
  }
  return;
}

export async function queryCompact(
  context: Pick<BuiltinQueryContext, "engine" | "resolveEngine" | "notify" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  const compactSessionId =
    typeof params.sessionId === "string" && params.sessionId.length > 0
      ? params.sessionId
      : undefined;
  const compactEngine = await context.resolveEngine(req, compactSessionId, engine, "compact");
  if (!compactEngine) return;
  try {
    const result = await compactEngine.forceCompact(compactSessionId);
    if (result.before > result.after) {
      const event = {
        type: "context_compact",
        strategy: toCompactStreamStrategy(result.strategy),
        before: result.before,
        after: result.after,
      } satisfies StreamEvent;
      context.notify(Methods.StreamEvent, {
        sessionId: compactSessionId ?? "",
        event,
      });
    }
    context.send(
      createResponse(req.id, {
        type: "compact",
        data: result,
      }),
    );
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}

export async function queryArchiveRange(
  context: Pick<BuiltinQueryContext, "engine" | "send" | "resolveEngine" | "notify">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  const archiveSessionId =
    typeof params.sessionId === "string" && params.sessionId.length > 0
      ? params.sessionId
      : undefined;
  const start = Number(params.start);
  const end = Number(params.end);
  if (!archiveSessionId || !Number.isFinite(start) || !Number.isFinite(end)) {
    context.send(
      createErrorResponse(
        req.id,
        ErrorCodes.InvalidParams,
        "archive_range requires sessionId, start and end",
      ),
    );
    return;
  }
  const archiveEngine = await context.resolveEngine(req, archiveSessionId, engine, "archive_range");
  if (!archiveEngine) return;
  try {
    const toClientMessageId =
      typeof params.toClientMessageId === "string" ? params.toClientMessageId : undefined;
    const anchors = toClientMessageId
      ? {
          toClientMessageId,
          ...(typeof params.fromClientMessageId === "string"
            ? { fromClientMessageId: params.fromClientMessageId }
            : {}),
          ...(typeof params.segmentId === "string" ? { segmentId: params.segmentId } : {}),
        }
      : undefined;
    const result = await archiveEngine.archiveTurnRange(archiveSessionId, { start, end }, anchors);
    if (result.before > result.after) {
      const event = {
        type: "context_compact",
        // Range archival has its own tier; "range" must be in
        // COMPACT_STREAM_STRATEGIES or it degrades to "compacted".
        strategy: toCompactStreamStrategy("range"),
        before: result.before,
        after: result.after,
      } satisfies StreamEvent;
      context.notify(Methods.StreamEvent, {
        sessionId: archiveSessionId,
        event,
      });
    }
    context.send(
      createResponse(req.id, {
        type: "archive_range",
        data: result,
      }),
    );
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}

export async function queryArchiveMarker(
  context: Pick<BuiltinQueryContext, "engine" | "send" | "resolveEngine">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  const markerSessionId =
    typeof params.sessionId === "string" && params.sessionId.length > 0
      ? params.sessionId
      : undefined;
  const summary = typeof params.summary === "string" ? params.summary : undefined;
  const toClientMessageId =
    typeof params.toClientMessageId === "string" ? params.toClientMessageId : undefined;
  if (!markerSessionId || !summary || !toClientMessageId) {
    context.send(
      createErrorResponse(
        req.id,
        ErrorCodes.InvalidParams,
        "archive_marker requires sessionId, summary and toClientMessageId",
      ),
    );
    return;
  }
  const markerEngine = await context.resolveEngine(req, markerSessionId, engine, "archive_marker");
  if (!markerEngine) return;
  try {
    const appended = await markerEngine.appendArchiveMarker(markerSessionId, {
      summary,
      toClientMessageId,
      ...(typeof params.fromClientMessageId === "string"
        ? { fromClientMessageId: params.fromClientMessageId }
        : {}),
      ...(typeof params.segmentId === "string" ? { segmentId: params.segmentId } : {}),
    });
    context.send(createResponse(req.id, { type: "archive_marker", data: { appended } }));
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}
