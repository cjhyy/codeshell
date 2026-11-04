import { existsSync, rmSync } from "node:fs";
import { detachPluginDirectory, removeDetachedPluginDirectories } from "./removeDirectory.js";
import { pluginInstallDir, assertSafePluginName } from "./paths.js";
import { removeInstallEntries, pluginInstallKey } from "../installedPlugins.js";
import { PluginInstallError } from "./types.js";
import { pruneDisabledSettingsForPlugin } from "./pruneDisabled.js";

/** Remove a locally-installed plugin dir + its installed_plugins.json entry. */
function uninstallLocal(name: string, removeDirectory: (dir: string) => void): void {
  assertSafePluginName(name);
  const dir = pluginInstallDir(name);
  if (!existsSync(dir)) {
    throw new PluginInstallError(`no plugin named '${name}'`);
  }
  removeDirectory(dir);
  removeInstallEntries(pluginInstallKey(name, "local"));
  // Clear orphaned disable flags (disabledSkills "name:skill" /
  // disabledPlugins "name") so a removed plugin leaves no dangling entries.
  pruneDisabledSettingsForPlugin(name);
}

/** Synchronous SDK compatibility entry. UI hosts should use the async entry. */
export function uninstallPluginByName(name: string): void {
  uninstallLocal(name, (dir) => rmSync(dir, { recursive: true, force: true }));
}

/** Detach the installed name before yielding so a reinstall cannot be deleted. */
export async function uninstallPluginByNameAsync(name: string): Promise<void> {
  const cleanup: string[] = [];
  try {
    uninstallLocal(name, (dir) => cleanup.push(detachPluginDirectory(dir)));
  } finally {
    await removeDetachedPluginDirectories(cleanup);
  }
}
