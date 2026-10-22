/**
 * Claude Code's NATIVE tool permissions under a CodeShell host.
 *
 * CodeShell Host Tools (`mcp__codeshell_tools__*`) are authorized by
 * `ToolExecutor` whatever Claude decides. Claude's own tools (Bash, Edit, Write,
 * WebFetch, …) are not: they obey only the CLI's permission mode and whoever
 * answers its permission prompts. Two things therefore have to be explicit:
 *
 *  1. `--permission-mode`, derived from the host's selection. Leaving it out is
 *     not neutral: the CLI then falls back to the user's own
 *     `~/.claude/settings.json` `defaultMode`, which may be far wider than what
 *     the user picked in CodeShell.
 *  2. `--permission-prompt-tool`, so an "ask" reaches the host's approval UI. In
 *     `-p` mode without one, every ask is denied outright.
 *
 * The prompt tool is an MCP tool on the session's own bridge. Claude calls it
 * with `{ tool_name, input, tool_use_id }` and expects a JSON text result,
 * `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }`
 * (shape read from the CLI's own result schema; not run against a real account).
 */
import type { PermissionMode } from "@cjhyy/code-shell-core/extension";
import type { BridgeToolHost } from "../shared/mcp-bridge.js";

/** Values passed to `claude --permission-mode`. */
export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/**
 * Map a CodeShell permission selection onto Claude's.
 *
 * Never escalates: Plan wins over everything; full access maps to
 * `bypassPermissions` only when CodeShell itself is in `bypassPermissions`; and
 * anything without an exact Claude equivalent — notably CodeShell's legacy
 * `auto`, which in Claude would mean a model-classifier auto-approval — becomes
 * `default`.
 */
export function claudePermissionModeFor(selection: {
  permissionMode: PermissionMode | undefined;
  planMode: boolean;
}): ClaudePermissionMode {
  if (selection.planMode || selection.permissionMode === "plan") return "plan";
  switch (selection.permissionMode) {
    case "acceptEdits":
    case "dontAsk":
    case "bypassPermissions":
      return selection.permissionMode;
    default:
      return "default";
  }
}

/**
 * Whether native asks should be routed to the host in this mode. Plan stays
 * read-only (an approved ExitPlanMode would otherwise leave it); `dontAsk` means
 * "do not ask"; `bypassPermissions` never asks.
 */
export function claudeModeUsesPermissionPrompt(mode: ClaudePermissionMode): boolean {
  return mode === "default" || mode === "acceptEdits";
}

/** Plain CodeShell-side name; the bridge qualifies it as `mcp__<server>__…`. */
export const CLAUDE_PERMISSION_PROMPT_TOOL = "CodeShellPermissionPrompt";

export interface ClaudePermissionPromptRequest {
  /** Claude's tool name, e.g. `Bash`, `Edit`, `mcp__other__tool`. */
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
}

export type ClaudePermissionPromptDecider = (
  request: ClaudePermissionPromptRequest,
  signal?: AbortSignal,
) => Promise<{ approved: boolean; reason?: string }>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function deny(message: string): { result: string } {
  // The prompt tool's verdict is its TEXT result; an MCP error result would be
  // treated by the CLI as a failed prompt rather than as a decision.
  return { result: JSON.stringify({ behavior: "deny", message }) };
}

/**
 * Add the permission-prompt tool to a session's bridge surface.
 *
 * Answers, in order:
 *  - the prompt tool itself → deny. It is visible to the model like any MCP
 *    tool; a direct call must not raise a host approval dialog.
 *  - this server's own tools → allow without asking. `ToolExecutor` authorizes
 *    them; asking here too would approve one operation twice (the same rule the
 *    Codex adapter applies to its MCP elicitations).
 *  - `ExitPlanMode` → deny. The mode is CodeShell's selection, not the model's.
 *  - everything else → `decide`, failing closed on any error or abort.
 */
export function withClaudePermissionPrompt(
  host: BridgeToolHost,
  decide: ClaudePermissionPromptDecider,
  serverName: string,
): BridgeToolHost {
  const ownPrefix = `mcp__${serverName}__`;
  const qualifiedSelf = `${ownPrefix}${CLAUDE_PERMISSION_PROMPT_TOOL}`;
  return {
    businessSessionId: host.businessSessionId,
    listTools: () => [
      ...host.listTools(),
      {
        name: CLAUDE_PERMISSION_PROMPT_TOOL,
        description:
          "Internal: Claude Code's permission prompt for its native tools, answered by " +
          "the CodeShell user. Not for direct use.",
        inputSchema: {
          type: "object",
          properties: {
            tool_name: { type: "string" },
            input: { type: "object" },
            tool_use_id: { type: "string" },
          },
          required: ["tool_name", "input"],
        },
      },
    ],
    execute: async (call, signal) => {
      if (call.name !== CLAUDE_PERMISSION_PROMPT_TOOL) return host.execute(call, signal);
      const params = asRecord(call.input);
      const toolName = typeof params?.tool_name === "string" ? params.tool_name : "";
      const input = asRecord(params?.input);
      if (!toolName || !input) return deny("Malformed permission request.");
      if (toolName === qualifiedSelf || toolName === CLAUDE_PERMISSION_PROMPT_TOOL) {
        return deny("The permission prompt tool cannot be called directly.");
      }
      if (toolName.startsWith(ownPrefix)) {
        return { result: JSON.stringify({ behavior: "allow", updatedInput: input }) };
      }
      if (toolName === "ExitPlanMode") {
        return deny("The permission mode is set by the CodeShell user and cannot be changed here.");
      }
      try {
        if (signal?.aborted) return deny("The permission request was cancelled.");
        const decision = await decide(
          {
            toolName,
            input,
            ...(typeof params?.tool_use_id === "string" ? { toolUseId: params.tool_use_id } : {}),
          },
          signal,
        );
        if (signal?.aborted) return deny("The permission request was cancelled.");
        return decision.approved
          ? { result: JSON.stringify({ behavior: "allow", updatedInput: input }) }
          : deny(decision.reason || "The CodeShell user denied this tool call.");
      } catch {
        return deny("The CodeShell approval request failed.");
      }
    },
  };
}
