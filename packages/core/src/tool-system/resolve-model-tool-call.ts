import type { ToolCall, ToolResult } from "../types.js";
import type { RunToolSurface } from "./run-tool-surface.js";

/** Resolve the wire wrapper before concurrency, permission, hooks, and execution. */
export function resolveModelToolCall(
  call: ToolCall,
  surface: RunToolSurface,
): { call: ToolCall } | { error: string } {
  if (call.toolName !== "CallTool") return { call };
  const { name, args: input } = call.args;
  if (call.invalidArguments || typeof name !== "string" || !name || name === "CallTool") {
    return {
      error:
        "Use CallTool with an exact tool name (other than CallTool) and an args object matching the schema returned by ToolSearch.",
    };
  }
  if (!surface.isEligible(name)) {
    return {
      error: `Tool ${name} is not available in the current session context. Do NOT retry unless the relevant context changes.`,
    };
  }
  if (!surface.isCallable(name)) {
    return {
      error: `Tool ${name} is available but not loaded. Use ToolSearch with query "select:${name}" first.`,
    };
  }
  let args = input;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      /* The schema-bearing error below is actionable. */
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      error: `CallTool args must be a JSON object matching ${name}'s inputSchema: ${JSON.stringify(surface.getDefinition(name)?.inputSchema)}`,
    };
  }
  return {
    call: {
      ...call,
      toolName: name,
      args: args as Record<string, unknown>,
      wireToolName: "CallTool",
    },
  };
}

export function resolveModelToolCalls(
  calls: ToolCall[],
  surface?: RunToolSurface,
): {
  calls: ToolCall[];
  errors: ToolResult[];
} {
  const resolved: ToolCall[] = [];
  const errors: ToolResult[] = [];
  for (const call of calls) {
    const result = surface ? resolveModelToolCall(call, surface) : { call };
    if ("call" in result) resolved.push(result.call);
    else errors.push({ id: call.id, toolName: call.toolName, error: result.error, isError: true });
  }
  return { calls: resolved, errors };
}

export function orderModelToolResults(calls: ToolCall[], results: ToolResult[]): ToolResult[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  return calls.map((call) => byId.get(call.id)!);
}
