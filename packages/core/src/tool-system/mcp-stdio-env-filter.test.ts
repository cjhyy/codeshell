import { describe, test, expect, afterEach } from "bun:test";
import { buildStdioEnv } from "./mcp-manager.js";
import type { MCPServerConfig } from "../types.js";

function cfg(name: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return { name, command: "node", args: ["server.js"], ...extra };
}

/**
 * A spawned stdio MCP server should not inherit the host's sensitive env by
 * default. Plugin-bundled / auto-connected servers otherwise get every
 * `*_KEY` / `*_TOKEN` / `*SECRET*` / `*PASSWORD*` in the CodeShell process —
 * including Credential.exposeAsEnv injections and top-level `env` API keys —
 * which violates least-privilege. Explicit `envVars` / `config.env` are the
 * user's declared intent and must still pass through.
 */
describe("buildStdioEnv sensitive-env filtering", () => {
  const touched: string[] = [];
  const set = (k: string, v: string) => {
    process.env[k] = v;
    touched.push(k);
  };
  afterEach(() => {
    for (const k of touched.splice(0)) delete process.env[k];
  });

  test("strips secret-shaped keys from the inherited base", () => {
    set("OPENAI_API_KEY", "sk-secret");
    set("GITHUB_TOKEN", "ghp_secret");
    set("MY_SECRET_VALUE", "shh");
    set("DB_PASSWORD", "hunter2");
    set("AWS_SECRET_ACCESS_KEY", "aws-secret");

    // Something must trigger a non-undefined return (env inheritance).
    const env = buildStdioEnv("srv", cfg("srv", { env: { HELLO: "world" } }));

    expect(env?.OPENAI_API_KEY).toBeUndefined();
    expect(env?.GITHUB_TOKEN).toBeUndefined();
    expect(env?.MY_SECRET_VALUE).toBeUndefined();
    expect(env?.DB_PASSWORD).toBeUndefined();
    expect(env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // The explicit config.env still comes through.
    expect(env?.HELLO).toBe("world");
  });

  test("keeps ordinary runtime vars (PATH / HOME / LANG)", () => {
    const env = buildStdioEnv("srv", cfg("srv", { env: { X: "1" } }));
    expect(env?.PATH).toBe(process.env.PATH);
    if (process.env.HOME) expect(env?.HOME).toBe(process.env.HOME);
  });

  test("an explicitly-forwarded secret-shaped var still passes (user intent)", () => {
    set("MCP_API_KEY", "declared-on-purpose");
    const env = buildStdioEnv("srv", cfg("srv", { envVars: ["MCP_API_KEY"] }));
    expect(env?.MCP_API_KEY).toBe("declared-on-purpose");
  });

  test("an explicit config.env secret-shaped key still passes (user intent)", () => {
    const env = buildStdioEnv("srv", cfg("srv", { env: { CUSTOM_TOKEN: "explicit" } }));
    expect(env?.CUSTOM_TOKEN).toBe("explicit");
  });
});
