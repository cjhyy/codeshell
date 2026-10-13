import { describe, expect, test } from "bun:test";
import type { MCPServerConfig } from "../types.js";
import { snapshotMcpConnectionConfig } from "./mcp-connection-config.js";
import {
  DEFAULT_MCP_CONNECT_RETRIES,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
} from "./mcp-connection-policy.js";

function stdio(extra: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { name: "fixture", command: "local-mcp", ...extra };
}

function http(extra: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { name: "fixture", url: "https://mcp.invalid/fixture", ...extra };
}

function identity(config: MCPServerConfig): string {
  return snapshotMcpConnectionConfig(config).identity;
}

describe("MCP connection configuration snapshots", () => {
  test("equivalent map order, empty defaults and inferred transports share an identity", () => {
    const equivalent: Array<[MCPServerConfig, MCPServerConfig]> = [
      [
        stdio({
          env: { SECOND: "two", FIRST: "one" },
          envVars: ["TOKEN_B", "TOKEN_A", "TOKEN_A"],
        }),
        stdio({ env: { FIRST: "one", SECOND: "two" }, envVars: ["TOKEN_A", "TOKEN_B"] }),
      ],
      [
        stdio(),
        stdio({
          transport: "stdio",
          args: [],
          env: {},
          envVars: [],
          connectTimeoutMs: DEFAULT_MCP_CONNECT_TIMEOUT_MS,
          connectRetries: DEFAULT_MCP_CONNECT_RETRIES,
        }),
      ],
      [
        http({
          headers: { "X-Second": "two", "X-First": "one" },
          envHeaders: { "X-Second": "TOKEN_B", "X-First": "TOKEN_A" },
        }),
        http({
          transport: "streamable-http",
          headers: { "X-First": "one", "X-Second": "two" },
          envHeaders: { "X-First": "TOKEN_A", "X-Second": "TOKEN_B" },
          connectTimeoutMs: DEFAULT_MCP_CONNECT_TIMEOUT_MS,
          connectRetries: DEFAULT_MCP_CONNECT_RETRIES,
        }),
      ],
    ];

    for (const [first, second] of equivalent) {
      expect(identity(first)).toBe(identity(second));
    }
  });

  test("command, argument order and environment changes have distinct identities", () => {
    const base = stdio({ args: ["--first", "--second"], env: { VERSION: "one" } });
    const changes: Partial<MCPServerConfig>[] = [
      { command: "other-local-mcp" },
      { args: ["--second", "--first"] },
      { env: { VERSION: "two" } },
      { envVars: ["OTHER_TOKEN"] },
    ];

    for (const change of changes) {
      expect(identity({ ...base, ...change })).not.toBe(identity(base));
    }
  });

  test("HTTP transport, address, headers and credential declarations remain distinct", () => {
    const base = http({
      transport: "streamable-http",
      headers: { "X-Version": "one" },
      envHeaders: { "X-Token": "FIRST_TOKEN" },
      bearerTokenEnvVar: "FIRST_BEARER",
      credentialRef: "first-credential",
    });
    const changes: Partial<MCPServerConfig>[] = [
      { transport: "sse" },
      { url: "https://mcp.invalid/other" },
      { headers: { "X-Version": "two" } },
      { envHeaders: { "X-Token": "SECOND_TOKEN" } },
      { bearerTokenEnvVar: "SECOND_BEARER" },
      { credentialRef: "second-credential" },
    ];

    for (const change of changes) {
      expect(identity({ ...base, ...change })).not.toBe(identity(base));
    }
  });

  test("different initialization deadlines and retry budgets do not coalesce", () => {
    const base = stdio();
    const changes: Partial<MCPServerConfig>[] = [
      { connectTimeoutMs: DEFAULT_MCP_CONNECT_TIMEOUT_MS + 1 },
      { connectRetries: 0 },
      { connectRetries: 2 },
    ];

    for (const change of changes) {
      expect(identity({ ...base, ...change })).not.toBe(identity(base));
    }
  });

  test("Run policy stays in the snapshot without splitting transport identity", () => {
    const base = stdio();
    const policies: Partial<MCPServerConfig>[] = [
      { enabled: true },
      { enabled: false },
      { allowedTools: [] },
      { allowedTools: ["read"], disabledTools: ["write"] },
    ];

    for (const policy of policies) {
      const declaration = { ...base, ...policy };
      const snapshot = snapshotMcpConnectionConfig(declaration);
      expect(snapshot.identity).toBe(identity(base));
      expect(snapshot.config).toEqual(declaration);
    }
  });

  test("caller mutation cannot change a previously captured configuration", () => {
    const declaration = stdio({
      args: ["--version", "one"],
      env: { VERSION: "one" },
      envVars: ["FIRST_TOKEN"],
      headers: { "X-Version": "one" },
      envHeaders: { "X-Token": "FIRST_TOKEN" },
      credentialRef: "first-credential",
      allowedTools: ["read"],
      disabledTools: ["write"],
      enabled: true,
    });
    const snapshot = snapshotMcpConnectionConfig(declaration);

    declaration.command = "other-local-mcp";
    declaration.args![1] = "two";
    declaration.env!.VERSION = "two";
    declaration.envVars!.push("SECOND_TOKEN");
    declaration.headers!["X-Version"] = "two";
    declaration.envHeaders!["X-Token"] = "SECOND_TOKEN";
    declaration.credentialRef = "second-credential";
    declaration.allowedTools!.push("write");
    declaration.disabledTools!.length = 0;
    declaration.enabled = false;

    expect(snapshot.config).toEqual(
      stdio({
        args: ["--version", "one"],
        env: { VERSION: "one" },
        envVars: ["FIRST_TOKEN"],
        headers: { "X-Version": "one" },
        envHeaders: { "X-Token": "FIRST_TOKEN" },
        credentialRef: "first-credential",
        allowedTools: ["read"],
        disabledTools: ["write"],
        enabled: true,
      }),
    );
    expect(snapshot.config).not.toBe(declaration);
    expect(snapshot.identity).not.toBe(identity(declaration));
  });

  test("case-insensitive duplicate headers preserve precedence-sensitive declaration order", () => {
    for (const field of ["headers", "envHeaders"] as const) {
      const upperFirst = http({ [field]: { "X-Key": "first", "x-key": "second" } });
      const lowerFirst = http({ [field]: { "x-key": "second", "X-Key": "first" } });

      expect(identity(upperFirst)).not.toBe(identity(lowerFirst));
      expect(Object.keys(snapshotMcpConnectionConfig(upperFirst).config[field]!)).toEqual([
        "X-Key",
        "x-key",
      ]);
      expect(Object.keys(snapshotMcpConnectionConfig(lowerFirst).config[field]!)).toEqual([
        "x-key",
        "X-Key",
      ]);
    }
  });

  test("inlineImages separates identities only when enabled", () => {
    expect(identity(stdio({ inlineImages: false }))).toBe(identity(stdio()));
    expect(identity(stdio({ inlineImages: true }))).not.toBe(identity(stdio()));
  });
});
