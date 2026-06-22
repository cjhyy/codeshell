import { existsSync, rmSync } from "node:fs";
import { pluginInstallDir, assertSafePluginName } from "./paths.js";
import { removeInstallEntries, pluginInstallKey } from "../installedPlugins.js";
import { PluginInstallError } from "./types.js";
import { pruneDisabledSettingsForPlugin } from "./pruneDisabled.js";

/** Remove a locally-installed plugin dir + its installed_plugins.json entry. */
export function uninstallPluginByName(name: string): void {
  assertSafePluginName(name);
  const dir = pluginInstallDir(name);
  if (!existsSync(dir)) {
    throw new PluginInstallError(`no plugin named '${name}'`);
  }
  rmSync(dir, { recursive: true, force: true });
  removeInstallEntries(pluginInstallKey(name, "local"));
  // Clear orphaned disable flags (disabledSkills "name:skill" /
  // disabledPlugins "name") so a removed plugin leaves no dangling entries.
  pruneDisabledSettingsForPlugin(name);
}
