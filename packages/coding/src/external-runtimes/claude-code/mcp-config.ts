/**
 * Wiring Claude Code to the loopback MCP bridge.
 *
 * The design (§10.2) assumed this would need `@anthropic-ai/claude-agent-sdk` and
 * an in-process MCP server — a second transport alongside Codex's HTTP one.
 * It does not. `claude --mcp-config` accepts an HTTP MCP server with an
 * `Authorization` header, exactly as Codex does, so both runtimes share one bridge
 * and CodeShell takes on no new dependency. Verified against real `claude 2.1.220`
 * (`docs/todo/evidence/e2e-claude-product-bridge.mjs`).
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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpBridgeHandle } from "../shared/mcp-bridge.js";

/** Logical MCP server name; also the `mcp__<server>__<tool>` prefix. */
export const CLAUDE_MCP_SERVER_NAME = "codeshell_tools";

/** `mcp__<server>__<tool>` — the only shape that may reach `--allowed-tools`. */
const MCP_TOOL_NAME = /^mcp__[a-z0-9_]+__[A-Za-z0-9_]+$/;

export interface ClaudeMcpConfigOptions {
  bridge: McpBridgeHandle;
  serverName?: string;
}

/**
 * The `--mcp-config` payload as an inline JSON string.
 *
 * Prefer {@link writeClaudeMcpConfigFile} for anything that spawns a real
 * process: an inline config puts the bearer token in `argv`, where `ps auxww`
 * exposes it to every local user (measured on macOS — argv is not restricted to
 * the owning uid). The bridge's only authentication IS that token, so leaking it
 * hands another local process full session authority.
 *
 * Kept exported because it is the right shape for tests and for callers that hold
 * no token (a config pointing at an already-authenticated transport).
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

export interface ClaudeMcpConfigFile {
  /** Path to pass to `--mcp-config`. */
  path: string;
  /** Remove the file and its directory. Call when the session ends. */
  cleanup(): void;
}

/**
 * Write the config to a mode-0600 temp file so the token never enters `argv`.
 *
 * `--mcp-config` documents "JSON files or strings", and a file works identically
 * — verified by capturing the resulting handshake, which carries the same
 * `Authorization` header. This is per-invocation and unlinked on cleanup, so it
 * does NOT touch the user's own `~/.claude.json`; the goal was never "avoid all
 * files", it was "avoid mutating persistent user config".
 */
export function writeClaudeMcpConfigFile(options: ClaudeMcpConfigOptions): ClaudeMcpConfigFile {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-mcp-"));
  const path = join(dir, "mcp-config.json");
  writeFileSync(path, buildClaudeMcpConfig(options), { mode: 0o600 });
  // Set explicitly as well: writeFileSync's mode is subject to umask.
  chmodSync(path, 0o600);
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Fully-qualified tool names for `--allowed-tools`.
 *
 * **`--allowed-tools` is a GRANT, not a filter.** Measured against real
 * `claude 2.1.220`: `--allowed-tools Write` lets the model write a file with no
 * approval prompt, while omitting the flag blocks the same request; and naming
 * only `Read` does not disable `Write`. It is purely additive — the CLI pairs it
 * with `--disallowedTools`, which is the deny half.
 *
 * An earlier version of this comment claimed the flag "does NOT widen anything".
 * That was inverted, and the inversion is the dangerous part: a reader who
 * believes the flag cannot widen has no reason to check what goes into it.
 *
 * Safety therefore rests on ONE property, enforced below rather than assumed:
 * every emitted name is `mcp__<server>__<tool>`, which routes to CodeShell's own
 * `ToolExecutor` and exposure policy. CodeShell deliberately exposes governed
 * alternatives named `Read`, `Bash`, `Write`, and `Edit`; after qualification
 * these become `mcp__codeshell_tools__Read`, etc. They do not pre-approve Claude
 * Code's bare built-ins with the same names.
 *
 * The function accepts only plain tool identifiers sourced from the exposed
 * CodeShell registry, then adds the MCP namespace itself. Anything that looks
 * like a Claude permission pattern (`Bash(git *)`, `*`) or is already qualified
 * for another server is a programming error and is rejected.
 */
export function claudeAllowedToolNames(
  toolNames: Iterable<string>,
  serverName = CLAUDE_MCP_SERVER_NAME,
): string[] {
  const reject = (name: string, why: string): never => {
    throw new Error(
      `Refusing to pre-approve '${name}': ${why}. --allowed-tools is a GRANT, and ` +
        `only mcp__${serverName}__<tool> names route through CodeShell's ToolExecutor.`,
    );
  };
  return [...toolNames].map((name) => {
    // A CodeShell tool name, e.g. "Panel". Nothing else is accepted.
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      return reject(name, "not a plain CodeShell tool name");
    }
    // An already-qualified name would let a caller pre-approve a tool on a
    // DIFFERENT MCP server — outside CodeShell's exposure policy entirely. The
    // qualifying is this function's job, not the caller's. (Checked separately
    // from the shape test above: `mcp__other__Thing` is a valid identifier.)
    if (name.startsWith("mcp__")) {
      return reject(name, "already qualified — pass a plain CodeShell tool name");
    }
    const qualified = `mcp__${serverName}__${name}`;
    if (!MCP_TOOL_NAME.test(qualified)) return reject(name, "does not qualify as an MCP tool name");
    return qualified;
  });
}

/**
 * CLI args wiring a `claude -p` invocation to the bridge.
 *
 * Uses a 0600 file for the config (token out of `argv`) and passes
 * `--strict-mcp-config` so the bridge is the session's ONLY tool channel.
 * Without that flag Claude Code also loads every MCP server from the user's
 * `~/.claude.json` and project config — servers the user approved for their own
 * interactive use, not for an agent CodeShell spawns on their behalf, and which
 * sit entirely outside CodeShell's exposure policy and `ToolExecutor`.
 *
 * The caller owns `cleanup()`; run it when the session ends.
 */
export function claudeBridgeArgs(options: {
  bridge: McpBridgeHandle;
  exposedToolNames: Iterable<string>;
  serverName?: string;
}): { args: string[]; cleanup(): void } {
  const serverName = options.serverName ?? CLAUDE_MCP_SERVER_NAME;
  const config = writeClaudeMcpConfigFile({ bridge: options.bridge, serverName });
  return {
    args: [
      "--mcp-config",
      config.path,
      "--strict-mcp-config",
      "--allowed-tools",
      claudeAllowedToolNames(options.exposedToolNames, serverName).join(","),
    ],
    cleanup: config.cleanup,
  };
}
