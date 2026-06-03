import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PluginInstallError } from "../types.js";

/**
 * Resolve a Codex manifest's mcpServers declaration into a plain server map.
 * - object → returned as-is (inline)
 * - string → read that file relative to sourceDir; accept either a bare map
 *   or a `{ mcpServers: {...} }` wrapper.
 * - undefined → {}
 */
export function resolveCodexMcpServers(
  sourceDir: string,
  decl: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (decl === undefined) return {};
  if (typeof decl === "object") return decl;

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
    return (parsed as { mcpServers: Record<string, unknown> }).mcpServers ?? {};
  }
  return parsed as Record<string, unknown>;
}
