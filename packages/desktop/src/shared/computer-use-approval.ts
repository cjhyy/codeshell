/**
 * What a computer-use approval of an external runtime (Claude Code / Codex)
 * asks, in a form both processes read.
 *
 * These calls reach the Host's Cua driver through the `codeshell_computer` MCP
 * server and bypass `ToolExecutor`, so the approval card is the only place the
 * user sees them. The runtime reports them as an MCP tool name
 * (`mcp__codeshell_computer__click`), which used to be shown as "its native …
 * tool". Main derives this presentation from the request; the renderer words it
 * in the user's language, and other clients read the plain `description`.
 */

/** MCP server name external CLIs see (see main `external-runtime-computer-use.ts`). */
export const EXTERNAL_COMPUTER_USE_SERVER_NAME = "codeshell_computer";

const TOOL_PREFIX = `mcp__${EXTERNAL_COMPUTER_USE_SERVER_NAME}__`;

export type ComputerUseApprovalRuntime = "claude-code" | "codex";

export interface ComputerUseApprovalPresentation {
  runtime: ComputerUseApprovalRuntime;
  /** The driver tool, e.g. `click`, `type_text`, `launch_app`. */
  action: string;
  /** The app the call names (a name or bundle id), when it names one. */
  app?: string;
  /** The target process and window, when the call carries them. */
  pid?: number;
  windowId?: number;
}

/** The driver action of a runtime-reported tool name, or undefined when it is not computer use. */
export function computerUseActionOf(toolName: string): string | undefined {
  if (!toolName.startsWith(TOOL_PREFIX)) return undefined;
  const action = toolName.slice(TOOL_PREFIX.length);
  return /^[a-z][a-z0-9_]{0,63}$/u.test(action) ? action : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function shortText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

function id(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Describe one computer-use call from what the request carries. Codex's
 * approval carries only the tool name; Claude Code's also carries the input.
 */
export function computerUseApprovalPresentation(
  runtime: ComputerUseApprovalRuntime,
  toolName: string,
  input?: unknown,
): ComputerUseApprovalPresentation | undefined {
  const action = computerUseActionOf(toolName);
  if (!action) return undefined;
  const args = recordOf(input) ?? {};
  // The driver takes the window as top-level `pid`/`window_id` or as `target`.
  const target = recordOf(args.target) ?? args;
  const app =
    shortText(args.app_name) ??
    shortText(args.name) ??
    shortText(args.app) ??
    shortText(args.bundle_id);
  const pid = id(target.pid);
  const windowId = id(target.window_id);
  return {
    runtime,
    action,
    ...(app ? { app } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(windowId !== undefined ? { windowId } : {}),
  };
}

/** Accept only a well-formed presentation from an approval request on the wire. */
export function readComputerUseApprovalPresentation(
  value: unknown,
): ComputerUseApprovalPresentation | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  if (record.runtime !== "claude-code" && record.runtime !== "codex") return undefined;
  if (typeof record.action !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(record.action))
    return undefined;
  const app = shortText(record.app);
  const pid = id(record.pid);
  const windowId = id(record.windowId);
  return {
    runtime: record.runtime,
    action: record.action,
    ...(app ? { app } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(windowId !== undefined ? { windowId } : {}),
  };
}

export const COMPUTER_USE_RUNTIME_LABEL: Record<ComputerUseApprovalRuntime, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * The plain wording for clients that show `toolName` / `description` as given
 * (phone, web, Mimi's IM prompt). The desktop card words it from the
 * presentation instead.
 */
export function computerUseApprovalText(presentation: ComputerUseApprovalPresentation): {
  toolName: string;
  description: string;
} {
  const where =
    presentation.app ??
    (presentation.pid !== undefined
      ? `pid ${presentation.pid}${presentation.windowId !== undefined ? `, window ${presentation.windowId}` : ""}`
      : undefined);
  return {
    // Not the MCP name: the card must not read as (or be remembered as) another tool.
    toolName: `Computer use: ${presentation.action}`,
    description: `${COMPUTER_USE_RUNTIME_LABEL[presentation.runtime]} 想操控电脑：${presentation.action}${where ? `（${where}）` : ""}`,
  };
}
