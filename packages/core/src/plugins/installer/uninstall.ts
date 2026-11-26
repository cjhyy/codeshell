import { withLocalPluginMutation } from "./mutation-lock.js";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { detachPluginDirectory, removeDetachedPluginDirectories } from "./removeDirectory.js";
import { pluginInstallDir, assertSafePluginName } from "./paths.js";
import { removeInstallEntries, pluginInstallKey } from "../installedPlugins.js";
import { PluginInstallError } from "./types.js";
import { pruneDisabledSettingsForPlugin } from "./pruneDisabled.js";
import { removeNativeRuntimeFiles } from "../native/snapshot.js";

/** Remove a locally-installed plugin dir + its installed_plugins.json entry. */
function uninstallLocal(name: string, removeDirectory: (dir: string) => void): void {
  assertSafePluginName(name);
  const dir = pluginInstallDir(name);
  if (!existsSync(dir)) {
    throw new PluginInstallError(`no plugin named '${name}'`);
  }
  removeDirectory(dir);
  removeInstallEntries(pluginInstallKey(name, "local"));
  removeNativeRuntimeFiles(name, pluginInstallKey(name, "local"));
  // Clear orphaned disable flags (disabledSkills "name:skill" /
  // disabledPlugins "name") so a removed plugin leaves no dangling entries.
  pruneDisabledSettingsForPlugin(name);
}

/** Synchronous SDK compatibility entry. UI hosts should use the async entry. */
export function uninstallPluginByName(name: string): void {
  uninstallLocal(name, (dir) => rmSync(dir, { recursive: true, force: true }));
}

/** Detach the installed name before yielding so a reinstall cannot be deleted. */
export async function uninstallPluginByNameAsync(
  name: string,
  beforeCommit?: () => void,
): Promise<void> {
  const dir = pluginInstallDir(name);
  const original = lstatSync(dir, { bigint: true, throwIfNoEntry: false });
  if (!original) throw new PluginInstallError(`no plugin named '${name}'`);
  const cleanup: string[] = [];
  try {
    await withLocalPluginMutation(name, async () => {
      uninstallLocal(name, (dir) => {
        const current = lstatSync(dir, { bigint: true });
        if (original.dev !== current.dev || original.ino !== current.ino)
          throw new PluginInstallError(`plugin '${name}' changed while waiting for removal`);
        beforeCommit?.();
        cleanup.push(detachPluginDirectory(dir));
      });
    });
  } finally {
    await removeDetachedPluginDirectories(cleanup);
  }
}
