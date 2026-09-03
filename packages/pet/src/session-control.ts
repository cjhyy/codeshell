import type { ToolContext, ToolDefinition } from "@cjhyy/code-shell-core/extension";
import { hostActionAvailability, hostActionService } from "./host-actions.js";
import { hasOnlyDeclaredToolArguments } from "./tool-arguments.js";

export const MANAGE_SESSIONS_TOOL_NAME = "ManageSessions";
export const WATCH_SESSION_TOOL_NAME = "WatchSession";
export const BIND_CONVERSATION_SESSION_TOOL_NAME = "BindConversationSession";

/** Opaque Sessions selector: `session-` + 20 hex (disclosure/selector.ts). */
const SESSION_SELECTOR_RE = /^session-[a-f0-9]{20}$/u;

export const bindConversationSessionToolDef: ToolDefinition = {
  name: BIND_CONVERSATION_SESSION_TOOL_NAME,
  description:
    "Route the current originating IM conversation directly to one CodeShell Work Session. " +
    'action="enter" makes the user\'s following messages go straight to that Session, and its ' +
    'replies come back to this chat without passing through Mimi. action="leave" returns the ' +
    "conversation to Mimi. session_selector must be an exact opaque selector from the read-only " +
    "Sessions tool: titles, paths and session ids are not accepted. Entering changes only where " +
    "messages are routed. It never widens the Session's permissions, never creates a Session or " +
    "a task, and never writes this control message into the Session. Tool acceptance only " +
    "records a pending host request; the host validates the Session and replaces your wording " +
    "with the authoritative outcome, so never state that the conversation has entered or left.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["enter", "leave"] },
      session_selector: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: 'Exact Sessions selector. Required for action="enter".',
      },
    },
    required: ["action"],
  },
};

export const bindConversationSessionAvailability = hostActionAvailability("sessionBind");

export async function bindConversationSessionTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const request = hostActionService(ctx);
  if (!request) {
    return "Error: BindConversationSession is available only in an IM-originated Mimi turn.";
  }
  if (
    !hasOnlyDeclaredToolArguments(args, ["action", "session_selector"]) ||
    (args.action !== "enter" && args.action !== "leave")
  ) {
    return 'Error: BindConversationSession requires action="enter" or action="leave".';
  }
  if (args.action === "leave") {
    if (args.session_selector !== undefined) {
      return "Error: BindConversationSession leave accepts no session_selector.";
    }
    const decision = request({ kind: "sessionBind", payload: { action: "leave" } });
    if (!decision.ok) return `Error: ${decision.error ?? "leaving the Session was rejected"}`;
    return (
      "Leave request accepted for host validation after this turn. " +
      "Do not claim the conversation has returned to Mimi until the host confirms it."
    );
  }
  const selector = typeof args.session_selector === "string" ? args.session_selector.trim() : "";
  if (!SESSION_SELECTOR_RE.test(selector)) {
    return (
      "Error: session_selector must be one exact selector returned by the Sessions tool " +
      "(the `selector` field), not a title, path, or session id."
    );
  }
  const decision = request({
    kind: "sessionBind",
    payload: { action: "enter", sessionSelector: selector },
  });
  if (!decision.ok) return `Error: ${decision.error ?? "entering the Session was rejected"}`;
  return (
    "Enter request accepted for host validation after this turn. The host verifies the Session " +
    "and appends the authoritative result, so end the turn now without saying the conversation " +
    "has entered it."
  );
}

export const watchSessionToolDef: ToolDefinition = {
  name: WATCH_SESSION_TOOL_NAME,
  description:
    "Subscribe the current originating IM conversation to the completion of one currently active " +
    "CodeShell Work Session. session_id must be copied exactly from the trusted sessions runtime " +
    "context. Tool acceptance only records a pending host request; do not promise a completion " +
    "notification until the host confirms the subscription in its post-turn receipt.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      session_id: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Exact agentSessionId from the trusted sessions runtime context.",
      },
    },
    required: ["session_id"],
  },
};

export const watchSessionAvailability = hostActionAvailability("sessionWatch");

export async function watchSessionTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const request = hostActionService(ctx);
  if (!request) return "Error: WatchSession is available only in an IM-originated Mimi turn.";
  const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId) ||
    !hasOnlyDeclaredToolArguments(args, ["session_id"])
  ) {
    return "Error: session_id must be one exact Session id from the trusted runtime context.";
  }
  const decision = request({ kind: "sessionWatch", payload: { sessionId } });
  if (!decision.ok) return `Error: ${decision.error ?? "session watch was rejected"}`;
  return (
    "Session watch request accepted for host validation after this turn. " +
    "Do not claim that completion notification is active until the host confirms it."
  );
}

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
