import type { ToolContext, ToolDefinition } from "@cjhyy/code-shell-core/extension";
import { hostActionAvailability, hostActionService } from "./host-actions.js";
import { hasOnlyDeclaredToolArguments } from "./tool-arguments.js";

export const MANAGE_SESSIONS_TOOL_NAME = "ManageSessions";

export const manageSessionsToolDef: ToolDefinition = {
  name: MANAGE_SESSIONS_TOOL_NAME,
  description:
    "Archive dormant or otherwise unwanted CodeShell Work Sessions without deleting their data. " +
    "session_ids must be exact opaque selectors returned by the read-only Sessions tool. Archive " +
    "is recoverable and is the default meaning of 'clean up sessions'.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["archive"] },
      session_ids: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
    required: ["action", "session_ids"],
  },
};

export const manageSessionsAvailability = hostActionAvailability("sessionArchive");

export async function manageSessionsTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const request = hostActionService(ctx);
  if (!request) return "Error: ManageSessions is available only in a Mimi manager turn.";
  if (
    args.action !== "archive" ||
    !Array.isArray(args.session_ids) ||
    args.session_ids.length < 1 ||
    args.session_ids.length > 20 ||
    args.session_ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) ||
    new Set(args.session_ids).size !== args.session_ids.length ||
    !hasOnlyDeclaredToolArguments(args, ["action", "session_ids"])
  ) {
    return "Error: ManageSessions archive requires 1 to 20 unique Sessions selectors.";
  }
  const decision = request({
    kind: "sessionArchive",
    payload: { action: "archive", sessionIds: args.session_ids },
  });
  if (!decision.ok) return `Error: ${decision.error ?? "session archive was rejected"}`;
  return "Session archive request accepted. The host will append the authoritative result.";
}
