/**
 * Wiring Claude Code to the loopback MCP bridge.
 *
 * The design (§10.2) assumed this would need `@anthropic-ai/claude-agent-sdk` and
 * an in-process MCP server — a second transport alongside Codex's HTTP one.
 * It does not. `claude --mcp-config <inline json>` accepts an HTTP MCP server with
 * an `Authorization` header, exactly as Codex does, so both runtimes share one
 * bridge and CodeShell takes on no new dependency. Verified against real
 * `claude 2.1.220` (`docs/todo/evidence/e2e-claude-product-bridge.mjs`).
 *
 * Two behaviours worth knowing, both observed:
 *
 *  - Claude Code sends **no per-call thread identity**. Its bridge must therefore
 *    be pinned to one session (`singleSessionThreadId`), making the port the
 *    attribution. That is a real constraint, not a shortcut — see
 *    `McpBridgeOptions.singleSessionThreadId`.
 *  - It opens with a `GET` (probing for an SSE stream) which the bridge answers
 *    405. Harmless: it falls back to POST immediately.
 */
import type { McpBridgeHandle } from "../shared/mcp-bridge.js";

/** Logical MCP server name; also the `mcp__<server>__<tool>` prefix. */
export const CLAUDE_MCP_SERVER_NAME = "codeshell_tools";

export interface ClaudeMcpConfigOptions {
  bridge: McpBridgeHandle;
  serverName?: string;
}

/**
 * The `--mcp-config` payload. Inline JSON rather than a file, deliberately: it is
 * per-invocation, so it never mutates the user's own `~/.claude.json` and cannot
 * leak this session's bearer token into a config that outlives the session.
 *
 * The token does travel on the command line here, which is the one place Codex's
 * `bearer_token_env_var` is nicer. It is a per-bridge random 32-byte value that
 * dies with the session, and Claude Code offers no env-var indirection for MCP
 * headers — so this is the available trade, and it is worth stating plainly rather
 * than leaving a reader to assume §12.2 was met.
 */
export function buildClaudeMcpConfig(options: ClaudeMcpConfigOptions): string {
  const serverName = options.serverName ?? CLAUDE_MCP_SERVER_NAME;
  return JSON.stringify({
    mcpServers: {
      [serverName]: {
        type: "http",
        url: options.bridge.url,
        headers: { Authorization: `Bearer ${options.bridge.token}` },
      },
    },
  });
}

/**
 * Fully-qualified tool names to pass to `--allowed-tools`.
 *
 * Claude Code namespaces MCP tools as `mcp__<server>__<tool>`. Listing them
 * explicitly keeps the runtime's own permission layer from prompting for a tool
 * CodeShell is already going to authorize through `ToolExecutor` — which is the
 * double-approval §10.3 sets out to avoid. It does NOT widen anything: the
 * exposure allowlist and `ToolExecutor` still decide what actually runs, and a
 * name here that the host does not expose is refused on arrival.
 */
export function claudeAllowedToolNames(
  toolNames: Iterable<string>,
  serverName = CLAUDE_MCP_SERVER_NAME,
): string[] {
  return [...toolNames].map((name) => `mcp__${serverName}__${name}`);
}

/** CLI args wiring a `claude -p` invocation to the bridge. */
export function claudeBridgeArgs(options: {
  bridge: McpBridgeHandle;
  exposedToolNames: Iterable<string>;
  serverName?: string;
}): string[] {
  const serverName = options.serverName ?? CLAUDE_MCP_SERVER_NAME;
  return [
    "--mcp-config",
    buildClaudeMcpConfig({ bridge: options.bridge, serverName }),
    "--allowed-tools",
    claudeAllowedToolNames(options.exposedToolNames, serverName).join(","),
  ];
}
