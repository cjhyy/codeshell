/**
 * Host-owned stdio MCP servers offered to an external runtime BESIDE the tool
 * bridge (today: Desktop's gated Computer Use proxy).
 *
 * Invariant: the bridge is no longer the only tool channel, but every channel
 * is still declared by the Host. A server listed here does not route through
 * `ToolExecutor`, so:
 *
 *  - its own process must enforce the Host's execution policy (the Computer
 *    Use proxy enforces the input gate and is pinned to one Session), and
 *  - its tools are never pre-approved. Claude Code asks through the
 *    permission-prompt tool; Codex asks through an MCP approval elicitation.
 *    Both reach the Host's approval backend, and both fail closed without one.
 *
 * The Host decides WHETHER a session gets such a server. This module only
 * validates and serializes a declaration; it has no default and no discovery.
 */

export interface ExternalHostMcpServer {
  /** Logical server name; also the `mcp__<name>__<tool>` prefix. */
  name: string;
  command: string;
  args: readonly string[];
  /** Non-secret environment for the server process. */
  env: Readonly<Record<string, string>>;
  /**
   * Secrets for the server process. Kept out of `argv`: Claude Code reads them
   * from its 0600 config file, Codex forwards them by variable NAME from its
   * own environment (`env_vars`).
   */
  secretEnv?: Readonly<Record<string, string>>;
}

/** Claude Code builds `mcp__<server>__<tool>`; ":" or "-" would not round-trip. */
const SERVER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function assertEnv(server: string, env: Readonly<Record<string, string>> | undefined): void {
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!ENV_NAME.test(name) || typeof value !== "string")
      throw new Error(`Host MCP server '${server}' has an invalid environment entry`);
  }
}

/** Reject anything that could shadow the bridge or produce an unusable tool prefix. */
export function validateExternalHostMcpServers(
  servers: readonly ExternalHostMcpServer[] | undefined,
  bridgeServerName: string,
): readonly ExternalHostMcpServer[] {
  const seen = new Set<string>([bridgeServerName]);
  for (const server of servers ?? []) {
    if (!SERVER_NAME.test(server.name))
      throw new Error(`Invalid Host MCP server name: ${JSON.stringify(server.name)}`);
    if (seen.has(server.name))
      throw new Error(`Host MCP server '${server.name}' collides with another server`);
    seen.add(server.name);
    if (!server.command) throw new Error(`Host MCP server '${server.name}' has no command`);
    if (!server.args.every((arg) => typeof arg === "string"))
      throw new Error(`Host MCP server '${server.name}' has invalid arguments`);
    assertEnv(server.name, server.env);
    assertEnv(server.name, server.secretEnv);
  }
  return servers ?? [];
}

/** `mcpServers` entries for Claude Code's (0600) `--mcp-config` file. */
export function claudeHostMcpServerEntries(
  servers: readonly ExternalHostMcpServer[],
): Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> }> {
  return Object.fromEntries(
    servers.map((server) => [
      server.name,
      {
        type: "stdio" as const,
        command: server.command,
        args: [...server.args],
        env: { ...server.env, ...server.secretEnv },
      },
    ]),
  );
}

/** A TOML basic string; JSON escapes are a subset of TOML's. */
function toml(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex `-c` overrides declaring each server. Secrets are named, not written:
 * `env_vars` forwards them from the app-server's own environment
 * ({@link hostMcpSecretEnv}).
 */
export function codexHostMcpServerArgs(servers: readonly ExternalHostMcpServer[]): string[] {
  return servers.flatMap((server) => {
    const key = `mcp_servers.${server.name}`;
    const env = Object.entries(server.env).map(([name, value]) => `${name}=${toml(value)}`);
    const secrets = Object.keys(server.secretEnv ?? {});
    return [
      "-c",
      `${key}.command=${toml(server.command)}`,
      "-c",
      `${key}.args=[${server.args.map(toml).join(",")}]`,
      ...(env.length ? ["-c", `${key}.env={${env.join(",")}}`] : []),
      ...(secrets.length ? ["-c", `${key}.env_vars=[${secrets.map(toml).join(",")}]`] : []),
    ];
  });
}

/** Secrets to place in the spawned runtime's environment, never in its argv. */
export function hostMcpSecretEnv(
  servers: readonly ExternalHostMcpServer[],
): Record<string, string> {
  return Object.assign({}, ...servers.map((server) => server.secretEnv ?? {}));
}
