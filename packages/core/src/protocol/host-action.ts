/**
 * Generic worker → host request/response loopback for extension modules.
 *
 * A protocol observer calls `ProtocolObserverHost.requestHostAction`; the
 * server emits an internal (non-surfaceable) `agent/approvalRequest` whose
 * `request.toolName` is {@link HOST_ACTION_TOOL_NAME}. The host intercepts the
 * line, dispatches by `args.action` and answers with `agent/approve` whose
 * `decision.answer` is the JSON-encoded result object (`{ ok:false, error }`
 * on failure). Hosts without a handler reply with an unsupported failure.
 */
export const HOST_ACTION_TOOL_NAME = "__host_action__";

/** `request.args` of a {@link HOST_ACTION_TOOL_NAME} approval request. */
export type HostActionRequestArgs = {
  action: string;
  args: Record<string, unknown>;
};

/** How `parseHostLoopbackDecision` (protocol/server.ts) classified a host-loopback reply. */
export type HostLoopbackOutcome<Failure extends string = string> =
  | { ok: true; value: unknown }
  | { ok: false; failure: Failure; detail: string };

/**
 * Settle an object-shaped host-loopback reply (workspace + host actions).
 *
 * Throws on a classified failure, on `{ ok: false, error }`, and on any
 * non-object JSON. A workspace or host-action result is always an object:
 * `null` / a bare number / a string would otherwise be handed to the caller as
 * if the action had succeeded (for a workspace switch, rebasing the session
 * onto a non-workspace), so the requirement is stated rather than relying on a
 * TypeError from `"ok" in parsed`.
 */
export function settleObjectHostReply(
  outcome: HostLoopbackOutcome,
  label: string,
  malformedDetail: string,
): object {
  if (!outcome.ok) throw new Error(outcome.detail);
  const parsed = outcome.value as { ok?: unknown; error?: unknown } | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} ${malformedDetail}`);
  }
  if ("ok" in parsed && parsed.ok === false) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : `${label} failed`);
  }
  return parsed;
}

/** One object-replying internal loopback request (see `requestHostLoopback` in server.ts). */
export interface HostLoopbackRequest {
  toolName: string;
  args: Record<string, unknown>;
  /** Prefix of every failure message, e.g. "workspace switch timed out …". */
  label: string;
  description: string;
}

/** `__workspace_action__`: SwitchSessionWorkspace and host-authoritative run workspaces. */
export function workspaceActionLoopback(
  action: "switch" | "resolve_session_run",
  target: string,
): HostLoopbackRequest {
  return {
    toolName: "__workspace_action__",
    args: { action, target },
    label: action === "switch" ? "workspace switch" : "Session workspace resolution",
    description: `workspace:${action}:${target}`,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `__host_action__`: generic extension-module request to the host. Throws —
 * before anything is registered — unless `action` is a non-empty string and
 * `args` a plain object, so a bad call never reaches the host as a line it
 * cannot parse.
 */
export function hostActionLoopback(action: unknown, args: unknown): HostLoopbackRequest {
  if (typeof action !== "string" || !action) {
    throw new Error("host action requires a non-empty action name");
  }
  if (!isPlainObject(args)) throw new Error(`host action ${action} requires plain-object args`);
  const request: HostActionRequestArgs = { action, args };
  return {
    toolName: HOST_ACTION_TOOL_NAME,
    args: request,
    label: `host action ${action}`,
    description: `host:${action}`,
  };
}
