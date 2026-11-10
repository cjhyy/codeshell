import type { BuiltinQueryContext } from "./context.js";
import {
  createResponse,
  createErrorResponse,
  ErrorCodes,
  type RpcRequest,
  type QueryParams,
} from "../types.js";

export async function queryUsage(
  context: Pick<BuiltinQueryContext, "engine" | "allowUsageAggregation" | "send" | "resolveEngine">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  const scope = params.scope ?? (params.sessionId ? "session" : "runtime");
  if (
    !["runtime", "session", "store"].includes(scope) ||
    (scope === "session" && !params.sessionId) ||
    (scope !== "session" && !context.allowUsageAggregation)
  ) {
    context.send(
      createErrorResponse(
        req.id,
        ErrorCodes.InvalidParams,
        "Usage query requires an owned Session or trusted host aggregation",
      ),
    );
    return;
  }
  const usageEngine = await context.resolveEngine(req, params.sessionId, engine, "usage");
  if (!usageEngine) return;
  if (scope === "session" && !usageEngine.sessionExistsOnDisk(params.sessionId!)) {
    context.send(createErrorResponse(req.id, ErrorCodes.SessionNotFound, "Session not found"));
    return;
  }
  try {
    const data = usageEngine.getUsageSummary({
      scope,
      sessionId: params.sessionId,
      includeChildren: params.includeChildren,
      since: params.since,
      until: params.until,
      limit: params.limit,
      cursor: params.cursor,
      runId: params.runId,
    });
    context.send(createResponse(req.id, { type: "usage", data }));
  } catch (error) {
    context.send(createErrorResponse(req.id, ErrorCodes.InvalidParams, (error as Error).message));
  }
  return;
}

export async function queryTools(
  context: Pick<BuiltinQueryContext, "engine" | "resolveEngine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  const toolsEngine = await context.resolveEngine(req, params.sessionId, engine, "tools");
  if (!toolsEngine) return;
  const registry = toolsEngine.getToolRegistry();
  const tools =
    typeof registry.listToolsDetailed === "function"
      ? registry
          .listToolsDetailed()
          .map((t: any) => ({ name: t.name, description: t.description ?? "" }))
      : registry.listTools().map((name: string) => ({ name, description: "" }));
  context.send(createResponse(req.id, { type: "tools", data: tools }));
  return;
}
