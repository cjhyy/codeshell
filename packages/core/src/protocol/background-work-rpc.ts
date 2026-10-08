import {
  cancelBackgroundWorkForUI,
  listBackgroundWorkForUI,
} from "../tool-system/builtin/background-work.js";
import { createErrorResponse, createResponse, ErrorCodes, type RpcRequest } from "./types.js";
import type { Transport } from "./transport.js";

/**
 * BackgroundWork — unified, list-only view of a session's background work
 * across all three registries (shells + sub-agents + jobs) for the desktop
 * background panel. Per-shell output/kill still flow through BackgroundShells
 * (by shellId); this just answers "what's running in the background right now".
 */
export function handleBackgroundWork(req: RpcRequest, transport: Pick<Transport, "send">): void {
  const params = (req.params ?? {}) as { sessionId?: string; scope?: "session" | "all" };
  const sessionId = params.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    transport.send(createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"));
    return;
  }
  const scope = params.scope === "all" ? "all" : "session";
  const items = listBackgroundWorkForUI(sessionId, { scope });
  transport.send(createResponse(req.id, { items }));
}

export async function handleBackgroundWorkCancel(
  req: RpcRequest,
  transport: Pick<Transport, "send">,
): Promise<void> {
  const params = req.params ?? {};
  const validId = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9._-]+$/.test(value) &&
    !value.includes("..");
  if (
    !validId(params.sessionId) ||
    !validId(params.workId) ||
    !["shell", "subagent", "job"].includes(String(params.kind)) ||
    typeof params.expectedStartedAt !== "number" ||
    !Number.isFinite(params.expectedStartedAt) ||
    params.expectedStartedAt < 0 ||
    (params.expectedRuntimeGeneration !== undefined &&
      (typeof params.expectedRuntimeGeneration !== "number" ||
        !Number.isSafeInteger(params.expectedRuntimeGeneration) ||
        params.expectedRuntimeGeneration < 0))
  ) {
    transport.send(
      createErrorResponse(
        req.id,
        ErrorCodes.InvalidParams,
        "valid source Session, work id, kind and attempt are required",
      ),
    );
    return;
  }
  const cancelled = await cancelBackgroundWorkForUI({
    sessionId: params.sessionId,
    workId: params.workId,
    kind: params.kind as "shell" | "subagent" | "job",
    expectedStartedAt: params.expectedStartedAt,
    expectedRuntimeGeneration: params.expectedRuntimeGeneration as number | undefined,
  });
  transport.send(createResponse(req.id, { cancelled }));
}
