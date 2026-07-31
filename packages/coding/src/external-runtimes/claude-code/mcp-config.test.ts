import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import {
  buildClaudeMcpConfig,
  claudeAllowedToolNames,
  claudeBridgeArgs,
  writeClaudeMcpConfigFile,
  CLAUDE_MCP_SERVER_NAME,
} from "./mcp-config.js";
import type { McpBridgeHandle } from "../shared/mcp-bridge.js";

const bridge: McpBridgeHandle = {
  url: "http://127.0.0.1:4242/mcp",
  token: "TOKEN-VALUE",
  tokenEnvVar: "CODESHELL_CODEX_MCP_TOKEN",
  close: async () => {},
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("claude-code MCP config", () => {
  test("declares an HTTP server with a bearer Authorization header", () => {
    const config = JSON.parse(buildClaudeMcpConfig({ bridge })) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    const server = config.mcpServers[CLAUDE_MCP_SERVER_NAME]!;
    expect(server.type).toBe("http");
    expect(server.url).toBe("http://127.0.0.1:4242/mcp");
    expect(server.headers.Authorization).toBe("Bearer TOKEN-VALUE");
  });

  test("points only at loopback", () => {
    const config = buildClaudeMcpConfig({ bridge });
    expect(config).toContain("127.0.0.1");
    expect(config).not.toContain("0.0.0.0");
  });

  test("the bearer token never enters argv", () => {
    // `ps auxww` exposes another process's argv to every local user (measured on
    // macOS), and this token IS the bridge's only authentication — leaking it
    // hands a local process full session authority. So the config goes in a file.
    const built = claudeBridgeArgs({ bridge, exposedToolNames: ["Panel"] });
    cleanups.push(built.cleanup);
    expect(built.args.join(" ")).not.toContain("TOKEN-VALUE");
    const path = built.args[built.args.indexOf("--mcp-config") + 1]!;
    expect(readFileSync(path, "utf8")).toContain("TOKEN-VALUE");
  });

  test("the config file is mode 0600", () => {
    const file = writeClaudeMcpConfigFile({ bridge });
    cleanups.push(file.cleanup);
    expect(statSync(file.path).mode & 0o777).toBe(0o600);
  });

  test("cleanup removes the config file", () => {
    const file = writeClaudeMcpConfigFile({ bridge });
    expect(statSync(file.path).isFile()).toBe(true);
    file.cleanup();
    expect(() => statSync(file.path)).toThrow();
  });

  test("passes --strict-mcp-config so the bridge is the only tool channel", () => {
    // Without it, Claude Code ALSO loads every MCP server from the user's
    // ~/.claude.json and project config — approved for their own interactive use,
    // not for an agent CodeShell spawns, and outside CodeShell's ToolExecutor.
    const built = claudeBridgeArgs({ bridge, exposedToolNames: ["Panel"] });
    cleanups.push(built.cleanup);
    expect(built.args).toContain("--strict-mcp-config");
  });

  test("namespaces allowed tool names the way Claude Code does", () => {
    expect(claudeAllowedToolNames(["Panel", "Memory"])).toEqual([
      "mcp__codeshell_tools__Panel",
      "mcp__codeshell_tools__Memory",
    ]);
  });

  test.each(["Bash", "Write", "Edit", "Read", "Bash(git *)", "*"])(
    "refuses to pre-approve the built-in tool %p",
    (name) => {
      // `--allowed-tools` is a GRANT, measured: `--allowed-tools Write` writes a
      // file with no approval prompt, while omitting the flag blocks it. A
      // built-in name reaching this list would hand the untrusted runtime an
      // unapproved tool, and the exposure allowlist would NOT help — it governs
      // the MCP surface, not Claude Code's own tools.
      expect(() => claudeAllowedToolNames([name])).toThrow(/GRANT|ToolExecutor/i);
    },
  );

  test("an already-qualified name is refused rather than passed through", () => {
    // Accepting a pre-qualified name would let a caller pre-approve a tool on a
    // DIFFERENT MCP server — one outside CodeShell's exposure policy entirely.
    // Callers pass plain CodeShell tool names; this function does the qualifying.
    expect(() => claudeAllowedToolNames(["mcp__other__Thing"])).toThrow(/already qualified/i);
  });

  test("allowed tools are derived from the exposure list, not hardcoded", () => {
    const built = claudeBridgeArgs({ bridge, exposedToolNames: ["Panel"] });
    cleanups.push(built.cleanup);
    const allowed = built.args[built.args.indexOf("--allowed-tools") + 1];
    expect(allowed).toBe("mcp__codeshell_tools__Panel");
  });

  test("a custom server name flows into both the config and the tool prefix", () => {
    const built = claudeBridgeArgs({
      bridge,
      exposedToolNames: ["Panel"],
      serverName: "other_tools",
    });
    cleanups.push(built.cleanup);
    const path = built.args[built.args.indexOf("--mcp-config") + 1]!;
    expect(readFileSync(path, "utf8")).toContain('"other_tools"');
    expect(built.args.join(" ")).toContain("mcp__other_tools__Panel");
  });
});
