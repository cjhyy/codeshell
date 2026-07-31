import { describe, expect, test } from "bun:test";
import {
  buildClaudeMcpConfig,
  claudeAllowedToolNames,
  claudeBridgeArgs,
  CLAUDE_MCP_SERVER_NAME,
} from "./mcp-config.js";
import type { McpBridgeHandle } from "../shared/mcp-bridge.js";

const bridge: McpBridgeHandle = {
  url: "http://127.0.0.1:4242/mcp",
  token: "TOKEN-VALUE",
  tokenEnvVar: "CODESHELL_CODEX_MCP_TOKEN",
  close: async () => {},
};

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

  test("namespaces allowed tool names the way Claude Code does", () => {
    // Claude Code exposes MCP tools as `mcp__<server>__<tool>`; a bare "Panel"
    // would silently match nothing.
    expect(claudeAllowedToolNames(["Panel", "Memory"])).toEqual([
      "mcp__codeshell_tools__Panel",
      "mcp__codeshell_tools__Memory",
    ]);
  });

  test("allowed tools are derived from the exposure list, not hardcoded", () => {
    // The host's allowlist is the single source of truth; passing a name here
    // that the host does not expose is refused on arrival anyway.
    const args = claudeBridgeArgs({ bridge, exposedToolNames: ["Panel"] });
    const allowed = args[args.indexOf("--allowed-tools") + 1];
    expect(allowed).toBe("mcp__codeshell_tools__Panel");
    expect(allowed).not.toContain("Bash");
  });

  test("config is inline JSON, never a path into the user's own config", () => {
    // Per-invocation config keeps this session's token out of a file that
    // outlives the session, and leaves ~/.claude.json untouched.
    const args = claudeBridgeArgs({ bridge, exposedToolNames: ["Panel"] });
    const value = args[args.indexOf("--mcp-config") + 1]!;
    expect(() => JSON.parse(value)).not.toThrow();
    expect(value).not.toContain(".claude.json");
  });

  test("a custom server name flows into both the config and the tool prefix", () => {
    const args = claudeBridgeArgs({
      bridge,
      exposedToolNames: ["Panel"],
      serverName: "other_tools",
    });
    expect(args.join(" ")).toContain('"other_tools"');
    expect(args.join(" ")).toContain("mcp__other_tools__Panel");
  });
});
