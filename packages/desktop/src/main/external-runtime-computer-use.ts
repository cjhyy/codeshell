/**
 * Computer Use for external runtimes (Claude Code / Codex CLIs).
 *
 * A native Session reaches the Host's Cua Driver as the `host:cua-driver` MCP
 * server of its worker. An external CLI gets the SAME gated proxy as one more
 * MCP server beside the tool bridge. Nothing here opens a second path to the
 * driver: the declaration is the Host's own `mcpDeclaration()`, plus the one
 * thing an external CLI cannot supply — the calling Session's identity.
 *
 * What carries over, and where it is enforced:
 *
 *  - Input gate, withheld browser tools, app notes, agent cursor / stage: in
 *    the proxy process itself (`computer-use/cua-activity-proxy.ts`). Without
 *    the proxy there is no declaration here.
 *  - Session attribution: the proxy is pinned to this Session by env
 *    (`PINNED_SESSION_ENV`), replacing the `_meta` lineage a native worker
 *    sends. Stop and run outcomes then apply as they do natively.
 *  - Approval: these tools bypass `ToolExecutor`, so they are never
 *    pre-approved. Each call is put to the user through the runtime's own
 *    approval path, as a native Session's `ask` is; full access skips the
 *    prompt, as `bypassPermissions` does natively.
 *
 * Whether a session gets it at all is decided by {@link externalComputerUseFor}.
 */
import { isFeatureEnabled, type FeatureFlagOverrides } from "@cjhyy/code-shell-core/extension";
import type { PermissionMode } from "@cjhyy/code-shell-core";
import type { ExternalHostMcpServer } from "@cjhyy/code-shell-capability-coding/external-runtimes";
import type { CuaDriverHost } from "./computer-use/cua-driver-host.js";
import { PINNED_SESSION_ENV, pinnedSessionId } from "./computer-use/input-gate-policy.js";
import { getCuaDriverHost } from "./computer-use/service.js";

/**
 * MCP server name external CLIs see. `host:cua-driver` cannot be used: both
 * CLIs name tools `mcp__<server>__<tool>`, and Claude Code accepts only
 * `[a-z0-9_]` in the server part.
 */
export const EXTERNAL_COMPUTER_USE_SERVER_NAME = "codeshell_computer";

const ACTIVITY_SOCKET_ENV = "CODE_SHELL_CUA_ACTIVITY_SOCKET";
const ACTIVITY_TOKEN_ENV = "CODE_SHELL_CUA_ACTIVITY_TOKEN";

export type ExternalComputerUseUnavailable =
  | "setting_off"
  | "driver_not_running"
  | "gate_unavailable"
  | "host_tools_off"
  | "restricted_profile"
  | "plan_mode"
  | "no_approval_path"
  | "invalid_session";

export type ExternalComputerUseDecision =
  | { offered: false; reason: ExternalComputerUseUnavailable }
  | { offered: true; servers: ExternalHostMcpServer[]; instructions: string };

export interface ExternalComputerUseInputs {
  sessionId: string;
  flags: FeatureFlagOverrides;
  /** `external_host_tools`: the guidance below names the bridge's browser tools. */
  hostToolsEnabled: boolean;
  /** Any capability restriction (Mimi-hosted, read-only, manager profiles). */
  restricted: boolean;
  planMode: boolean;
  permissionMode: PermissionMode | undefined;
  /** The Host can put an approval prompt in front of the user. */
  canPrompt: boolean;
  host?: Pick<CuaDriverHost, "status" | "mcpDeclaration">;
}

const off = (reason: ExternalComputerUseUnavailable): ExternalComputerUseDecision => ({
  offered: false,
  reason,
});

/**
 * Decide whether one external session gets Computer Use. Every "no" is a plain
 * absence: the server is not declared, so the CLI never lists its tools.
 */
export function externalComputerUseFor(
  inputs: ExternalComputerUseInputs,
): ExternalComputerUseDecision {
  // Capability-restricted sessions keep the reviewed bridge as their only channel.
  if (inputs.restricted) return off("restricted_profile");
  if (inputs.planMode || inputs.permissionMode === "plan") return off("plan_mode");
  if (!inputs.hostToolsEnabled) return off("host_tools_off");
  if (!isFeatureEnabled(inputs.flags, "computer_use_cua")) return off("setting_off");
  // Natively every call is an `ask` unless the user chose full access; `dontAsk`
  // denies. A session that can neither prompt nor has full access gets nothing.
  const fullAccess = inputs.permissionMode === "bypassPermissions";
  if (!fullAccess && (inputs.permissionMode === "dontAsk" || !inputs.canPrompt))
    return off("no_approval_path");
  const host = inputs.host ?? getCuaDriverHost();
  if (!host || host.status().state !== "running") return off("driver_not_running");
  const declaration = host.mcpDeclaration();
  const { [ACTIVITY_TOKEN_ENV]: token, ...env } = declaration.env;
  // The bare driver has no input gate. Only the gated proxy is ever offered.
  if (!token || !env[ACTIVITY_SOCKET_ENV]) return off("gate_unavailable");
  try {
    if (!pinnedSessionId(inputs.sessionId)) return off("invalid_session");
  } catch {
    return off("invalid_session");
  }
  return {
    offered: true,
    servers: [
      {
        name: EXTERNAL_COMPUTER_USE_SERVER_NAME,
        command: declaration.command,
        args: [...declaration.args],
        env: { ...env, [PINNED_SESSION_ENV]: inputs.sessionId },
        secretEnv: { [ACTIVITY_TOKEN_ENV]: token },
      },
    ],
    instructions: EXTERNAL_COMPUTER_USE_INSTRUCTIONS,
  };
}

/** The start request's own answer: the servers and guidance, or nothing at all. */
export function externalComputerUse(
  request: {
    sessionId: string;
    toolProfile?: unknown;
    planMode?: boolean;
    permissionMode?: PermissionMode;
  },
  flags: FeatureFlagOverrides,
  canPrompt: boolean,
  host?: ExternalComputerUseInputs["host"],
): Extract<ExternalComputerUseDecision, { offered: true }> | undefined {
  const decision = externalComputerUseFor({
    sessionId: request.sessionId,
    flags,
    hostToolsEnabled: isFeatureEnabled(flags, "external_host_tools"),
    restricted: request.toolProfile !== undefined,
    planMode: request.planMode === true,
    permissionMode: request.permissionMode,
    canPrompt,
    ...(host ? { host } : {}),
  });
  return decision.offered ? decision : undefined;
}

const TOOLS = `mcp__${EXTERNAL_COMPUTER_USE_SERVER_NAME}__*`;

export const EXTERNAL_COMPUTER_USE_INSTRUCTIONS =
  `Computer use is available through the ${TOOLS} tools (CodeShell's own driver: ` +
  "list_apps, launch_app, get_window_state, click, set_value, type_text, press_key, …). " +
  "Choose by where the target lives. A page in CodeShell's built-in browser: use " +
  "browser_navigate, browser_observe and browser_act, never computer use. Any other " +
  "desktop app, or a page the user already has open in their own browser (Chrome, " +
  `Safari, …): use ${TOOLS}. Read the window with get_window_state before acting and ` +
  "again afterwards to confirm the result. Prefer element-based background input, which " +
  "neither brings the app forward nor moves the user's pointer; inside a web page in the " +
  "user's own browser only background set_value is accepted for text. Each call may need " +
  "the user's approval. A tool result may carry notes for the app you are driving and " +
  "tool descriptions carry CodeShell's input policy: follow both. If a call returns " +
  "computer_input_refused, follow its guidance and do not retry the same action; when " +
  "the user stopped computer control, stop and report what is left.";
