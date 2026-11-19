import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { FIRST_PHASE_EXPOSURE } from "@cjhyy/code-shell-core/extension";
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

  test("passes --strict-mcp-config so only Host-declared servers are tool channels", () => {
    // Without it, Claude Code ALSO loads every MCP server from the user's
    // ~/.claude.json and project config — approved for their own interactive use,
    // not for an agent CodeShell spawns, and outside CodeShell's ToolExecutor.
    //
    // Invariant (changed deliberately when Computer Use was opened to external
    // sessions): the bridge is the only channel UNLESS the Host declares another
    // server of its own. By default the config holds the bridge and nothing else.
    const built = claudeBridgeArgs({ bridge, exposedToolNames: ["Panel"] });
    cleanups.push(built.cleanup);
    expect(built.args).toContain("--strict-mcp-config");
    const path = built.args[built.args.indexOf("--mcp-config") + 1]!;
    const config = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: object };
    expect(Object.keys(config.mcpServers)).toEqual([CLAUDE_MCP_SERVER_NAME]);
  });

  describe("a Host MCP server beside the bridge", () => {
    const computer = {
      name: "codeshell_computer",
      command: "/app/electron",
      args: ["/app/proxy.cjs", "--driver", "/app/cua-driver", "--socket", "/tmp/d.sock"],
      env: { CODE_SHELL_CUA_SESSION_ID: "s-1" },
      secretEnv: { CODE_SHELL_CUA_ACTIVITY_TOKEN: "ACTIVITY-SECRET" },
    };

    test("is declared as a stdio server in the same private config file", () => {
      const built = claudeBridgeArgs({
        bridge,
        exposedToolNames: ["Panel"],
        hostMcpServers: [computer],
      });
      cleanups.push(built.cleanup);
      const path = built.args[built.args.indexOf("--mcp-config") + 1]!;
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const config = JSON.parse(readFileSync(path, "utf8")) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(Object.keys(config.mcpServers).sort()).toEqual([
        "codeshell_computer",
        CLAUDE_MCP_SERVER_NAME,
      ]);
      expect(config.mcpServers.codeshell_computer).toEqual({
        type: "stdio",
        command: "/app/electron",
        args: computer.args,
        env: { CODE_SHELL_CUA_SESSION_ID: "s-1", CODE_SHELL_CUA_ACTIVITY_TOKEN: "ACTIVITY-SECRET" },
      });
      // The secret is in the 0600 file, never in argv.
      expect(built.args.join(" ")).not.toContain("ACTIVITY-SECRET");
      expect(built.args).toContain("--strict-mcp-config");
    });

    test("its tools are NOT pre-approved: --allowed-tools stays bridge-only", () => {
      // `--allowed-tools` is a grant. These tools bypass ToolExecutor, so a grant
      // here would mean no approval anywhere; unlisted, Claude asks through the
      // permission-prompt tool (the Host's approval UI) or denies.
      const built = claudeBridgeArgs({
        bridge,
        exposedToolNames: ["Panel", "Read"],
        hostMcpServers: [computer],
      });
      cleanups.push(built.cleanup);
      const allowed = built.args[built.args.indexOf("--allowed-tools") + 1]!.split(",");
      expect(allowed).toEqual(["mcp__codeshell_tools__Panel", "mcp__codeshell_tools__Read"]);
    });

    test("a name that cannot form mcp__<server>__<tool> or shadows the bridge is refused", () => {
      for (const name of ["host:cua-driver", CLAUDE_MCP_SERVER_NAME])
        expect(() =>
          buildClaudeMcpConfig({ bridge, hostMcpServers: [{ ...computer, name }] }),
        ).toThrow(/Host MCP server/);
    });
  });

  test("namespaces allowed tool names the way Claude Code does", () => {
    expect(claudeAllowedToolNames(["Panel", "Memory"])).toEqual([
      "mcp__codeshell_tools__Panel",
      "mcp__codeshell_tools__Memory",
    ]);
  });

  test("qualifies CodeShell tools that share names with Claude built-ins", () => {
    // The qualified names grant only the CodeShell MCP alternatives. Claude's
    // bare built-ins keep following Claude Code's own permission flow.
    expect(claudeAllowedToolNames(["Read", "Bash", "Write", "Edit"])).toEqual([
      "mcp__codeshell_tools__Read",
      "mcp__codeshell_tools__Bash",
      "mcp__codeshell_tools__Write",
      "mcp__codeshell_tools__Edit",
    ]);
  });

  test.each(["Bash(git *)", "*"])("refuses malformed or wildcard grant %p", (name) => {
    expect(() => claudeAllowedToolNames([name])).toThrow(/GRANT|ToolExecutor/i);
  });

  test("the complete first-phase exposure can be passed to Claude Code", () => {
    const built = claudeBridgeArgs({
      bridge,
      exposedToolNames: FIRST_PHASE_EXPOSURE.toolNames,
    });
    cleanups.push(built.cleanup);
    const allowed = built.args[built.args.indexOf("--allowed-tools") + 1]!.split(",");
    expect(allowed).toHaveLength(FIRST_PHASE_EXPOSURE.toolNames.size);
    expect(allowed.every((name) => name.startsWith("mcp__codeshell_tools__"))).toBe(true);
    expect(allowed).toContain("mcp__codeshell_tools__Read");
  });

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
