import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  const path = join(sourceDir, decl);
  if (!existsSync(path)) {
    throw new PluginInstallError(`mcpServers ref not found: ${decl}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new PluginInstallError(`invalid mcp json ${decl}: ${(err as Error).message}`);
  }
  if (parsed && typeof parsed === "object" && "mcpServers" in (parsed as object)) {
    return (parsed as { mcpServers: Record<string, unknown> }).mcpServers ?? {};
  }
  return (parsed as Record<string, unknown>) ?? {};
}
