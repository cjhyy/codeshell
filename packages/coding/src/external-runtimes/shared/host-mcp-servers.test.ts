import { describe, expect, test } from "bun:test";
import {
  claudeHostMcpServerEntries,
  codexHostMcpServerArgs,
  hostMcpSecretEnv,
  validateExternalHostMcpServers,
  type ExternalHostMcpServer,
} from "./host-mcp-servers.js";

const server: ExternalHostMcpServer = {
  name: "codeshell_computer",
  command: "/Applications/Code Shell.app/electron",
  args: ["/app/proxy.cjs", "--driver", "/app/cua driver", "--socket", "/tmp/cs/driver.sock"],
  env: { ELECTRON_RUN_AS_NODE: "1", CODE_SHELL_CUA_SESSION_ID: "s-1" },
  secretEnv: { CODE_SHELL_CUA_ACTIVITY_TOKEN: "SECRET-TOKEN" },
};

describe("Host MCP servers for external runtimes", () => {
  test("accepts a normalized name and returns the declarations unchanged", () => {
    expect(validateExternalHostMcpServers([server], "codeshell_tools")).toEqual([server]);
    expect(validateExternalHostMcpServers(undefined, "codeshell_tools")).toEqual([]);
  });

  test.each(["host:cua-driver", "cua-driver", "Computer", "", "a b"])(
    "refuses server name %p, which would not form mcp__<server>__<tool>",
    (name) => {
      expect(() =>
        validateExternalHostMcpServers([{ ...server, name }], "codeshell_tools"),
      ).toThrow(/Invalid Host MCP server name/);
    },
  );

  test("refuses a server that would shadow the bridge or repeat a name", () => {
    expect(() =>
      validateExternalHostMcpServers([{ ...server, name: "codeshell_tools" }], "codeshell_tools"),
    ).toThrow(/collides/);
    expect(() => validateExternalHostMcpServers([server, server], "codeshell_tools")).toThrow(
      /collides/,
    );
  });

  test("refuses malformed environment names and an empty command", () => {
    expect(() =>
      validateExternalHostMcpServers([{ ...server, env: { "a=b": "1" } }], "codeshell_tools"),
    ).toThrow(/environment/);
    expect(() =>
      validateExternalHostMcpServers([{ ...server, command: "" }], "codeshell_tools"),
    ).toThrow(/no command/);
  });

  test("Claude Code gets a stdio entry whose env includes the secret (0600 file)", () => {
    expect(claudeHostMcpServerEntries([server])).toEqual({
      codeshell_computer: {
        type: "stdio",
        command: server.command,
        args: [...server.args],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          CODE_SHELL_CUA_SESSION_ID: "s-1",
          CODE_SHELL_CUA_ACTIVITY_TOKEN: "SECRET-TOKEN",
        },
      },
    });
  });

  test("Codex gets the declaration as -c overrides and the secret by NAME only", () => {
    const args = codexHostMcpServerArgs([server]);
    expect(args).toEqual([
      "-c",
      'mcp_servers.codeshell_computer.command="/Applications/Code Shell.app/electron"',
      "-c",
      'mcp_servers.codeshell_computer.args=["/app/proxy.cjs","--driver","/app/cua driver","--socket","/tmp/cs/driver.sock"]',
      "-c",
      'mcp_servers.codeshell_computer.env={ELECTRON_RUN_AS_NODE="1",CODE_SHELL_CUA_SESSION_ID="s-1"}',
      "-c",
      'mcp_servers.codeshell_computer.env_vars=["CODE_SHELL_CUA_ACTIVITY_TOKEN"]',
    ]);
    // argv is readable by every local user.
    expect(args.join(" ")).not.toContain("SECRET-TOKEN");
    expect(hostMcpSecretEnv([server])).toEqual({ CODE_SHELL_CUA_ACTIVITY_TOKEN: "SECRET-TOKEN" });
  });

  test("no servers means no arguments and no environment", () => {
    expect(codexHostMcpServerArgs([])).toEqual([]);
    expect(hostMcpSecretEnv([])).toEqual({});
    expect(claudeHostMcpServerEntries([])).toEqual({});
  });
});
