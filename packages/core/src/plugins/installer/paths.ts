import { homedir } from "node:os";
import { join } from "node:path";
import { PluginInstallError } from "./types.js";

function userHome(): string {
  return process.env.HOME ?? homedir();
}

/** A plugin name must be a single safe path segment — no separators, no traversal. */
export function assertSafePluginName(name: string): void {
  if (!name || name === "." || name === "..") {
    throw new PluginInstallError(`invalid plugin name: ${JSON.stringify(name)}`);
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new PluginInstallError(`plugin name must be a single path segment: ${JSON.stringify(name)}`);
  }
}

export function pluginsRoot(): string {
  return join(userHome(), ".code-shell", "plugins");
}

export function pluginInstallDir(name: string): string {
  assertSafePluginName(name);
  return join(pluginsRoot(), name);
}

export function pluginMetaPath(name: string): string {
  return join(pluginInstallDir(name), ".cs-meta.json");
}
