import { describe, test, expect, afterEach } from "bun:test";
import { buildStdioEnv } from "./mcp-manager.js";
import type { MCPServerConfig } from "../types.js";

function cfg(name: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { name, command: "node", args: ["server.js"], ...extra };
}

/**
 * A spawned stdio MCP server inherits only a minimal allowlist of runtime env
 * vars (PATH/HOME/LANG/…), not the whole host env — aligned with CC/Codex's
 * env-secret-by-name convention. Anything else (API keys AND ordinary
 * non-allowlisted host vars) must be declared explicitly via `envVars`
 * (forward by name) or `config.env` (literal). No secret-shape guessing.
 */
describe("buildStdioEnv allowlist inheritance", () => {
  const touched: string[] = [];
  const set = (k: string, v: string) => {
    process.env[k] = v;
    touched.push(k);
  };
  afterEach(() => {
    for (const k of touched.splice(0)) delete process.env[k];
  });

  test("does NOT inherit secret-shaped host vars", () => {
    set("OPENAI_API_KEY", "sk-secret");
    set("GITHUB_TOKEN", "ghp_secret");
    set("DB_PASSWORD", "hunter2");

    const env = buildStdioEnv("srv", cfg("srv", { env: { HELLO: "world" } }));

    expect(env?.OPENAI_API_KEY).toBeUndefined();
    expect(env?.GITHUB_TOKEN).toBeUndefined();
    expect(env?.DB_PASSWORD).toBeUndefined();
    expect(env?.HELLO).toBe("world");
  });

  test("does NOT inherit a non-allowlisted host var even if it looks harmless", () => {
    // Allowlist, not blacklist: an undeclared var never rides along, regardless
    // of its name. The user must declare it if the server needs it.
    set("RANDOM_HOST_VAR", "leaky");
    set("MY_CONFIG_DIR", "/somewhere");
    const env = buildStdioEnv("srv", cfg("srv", { env: { X: "1" } }));
    expect(env?.RANDOM_HOST_VAR).toBeUndefined();
    expect(env?.MY_CONFIG_DIR).toBeUndefined();
  });

  test("inherits the minimal runtime allowlist (PATH / HOME)", () => {
    const env = buildStdioEnv("srv", cfg("srv", { env: { X: "1" } }));
    expect(env?.PATH).toBe(process.env.PATH);
    if (process.env.HOME) expect(env?.HOME).toBe(process.env.HOME);
  });

  test("an explicitly-forwarded var passes even if secret-shaped (user intent)", () => {
    set("MCP_API_KEY", "declared-on-purpose");
    const env = buildStdioEnv("srv", cfg("srv", { envVars: ["MCP_API_KEY"] }));
    expect(env?.MCP_API_KEY).toBe("declared-on-purpose");
  });

  test("an explicit config.env key passes (user intent)", () => {
    const env = buildStdioEnv("srv", cfg("srv", { env: { CUSTOM_TOKEN: "explicit" } }));
    expect(env?.CUSTOM_TOKEN).toBe("explicit");
  });

  test("envVars can forward an allowlisted-name-collision var explicitly", () => {
    // Even a var that happens to be non-allowlisted is reachable by name.
    set("NODE_EXTRA_CA_CERTS", "/certs/ca.pem");
    const env = buildStdioEnv("srv", cfg("srv", { envVars: ["NODE_EXTRA_CA_CERTS"] }));
    expect(env?.NODE_EXTRA_CA_CERTS).toBe("/certs/ca.pem");
  });
});
