import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PluginInstallError } from "../types.js";

/**
 * Codex `.mcp.json` writes env-secret fields in snake_case
 * (`bearer_token_env_var`, `env_http_headers`, `env_vars`), but our runtime
 * MCP manager reads camelCase (`bearerTokenEnvVar`, `envHeaders`, `envVars` —
 * see buildStdioEnv / buildHttpHeaders in tool-system/mcp-manager.ts). Nothing
 * between install and connect runs these through a zod schema (install spreads
 * the object verbatim; loadPluginMcp casts raw JSON), so without this re-key an
 * imported Codex plugin's secret references would silently never apply and the
 * server would connect without its auth header / env. Re-key one server config
 * object. An already-present camelCase key wins over its snake_case twin so we
 * never clobber the canonical form. Non-object input passes through unchanged.
 */
const CODEX_FIELD_MAP: Record<string, string> = {
  bearer_token_env_var: "bearerTokenEnvVar",
  env_http_headers: "envHeaders",
  env_vars: "envVars",
};

export function normalizeCodexMcpFields(cfg: Record<string, unknown>): Record<string, unknown> {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return cfg;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    const mapped = CODEX_FIELD_MAP[key];
    // Skip the snake_case form if its camelCase twin is already present.
    if (mapped && mapped in cfg) continue;
    out[mapped ?? key] = value;
  }
  return out;
}

/** Apply normalizeCodexMcpFields to every server in a name → config map. */
function normalizeServerMap(servers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    out[name] = normalizeCodexMcpFields(cfg as Record<string, unknown>);
  }
  return out;
}

/**
 * Resolve a Codex manifest's mcpServers declaration into a plain server map.
 * Each server's env-secret fields are normalized from Codex's snake_case to
 * our runtime camelCase (see normalizeCodexMcpFields).
 * - object → normalized inline map
 * - string → read that file relative to sourceDir; accept either a bare map
 *   or a `{ mcpServers: {...} }` wrapper, then normalize.
 * - undefined → {}
 */
export function resolveCodexMcpServers(
  sourceDir: string,
  decl: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (decl === undefined) return {};
  if (typeof decl === "object") return normalizeServerMap(decl);

  // `decl` is an untrusted, unvalidated manifest field from a (possibly
  // remote-cloned) plugin. Resolve it and assert it stays inside sourceDir so
  // a value like "../../../../etc/secret.json" can't escape the plugin dir and
  // read arbitrary files into the install's mcp-servers.json.
  const base = resolve(sourceDir);
  const path = resolve(base, decl);
  const rel = relative(base, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PluginInstallError(`mcpServers ref escapes plugin dir: ${decl}`);
  }
  if (!existsSync(path)) {
    throw new PluginInstallError(`mcpServers ref not found: ${decl}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new PluginInstallError(
      `invalid mcp json ${decl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Only objects yield server maps. An array/number/string that happens to
  // parse is not a valid mcp config — return an empty map rather than casting
  // a non-object to Record.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  if ("mcpServers" in (parsed as object)) {
    return normalizeServerMap((parsed as { mcpServers: Record<string, unknown> }).mcpServers ?? {});
  }
  return normalizeServerMap(parsed as Record<string, unknown>);
}
