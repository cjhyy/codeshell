import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { pluginInstallDir, pluginsRoot, assertSafePluginName } from "./paths.js";
import { type CSMeta, PluginInstallError } from "./types.js";
import { appendInstallEntry, pluginInstallKey } from "../installedPlugins.js";
import { pluginHookInstallRecord } from "../pluginHookIntegrity.js";
import { pluginMcpInstallRecord } from "../pluginMcpIntegrity.js";
import { readPluginMcp } from "./loadPluginMcp.js";
import { projectPluginSource } from "./projectPluginSource.js";

export interface InstallPluginFromPathOptions {
  /** Trusted source identity to persist instead of the temporary projection input path. */
  source?: string;
  /** Trusted distribution version to persist instead of the plugin manifest version. */
  version?: string;
}

/**
 * Install a local plugin directory into ~/.code-shell/plugins/<name>/.
 * Builds into a temp sibling dir, then renames into place — a conversion
 * failure leaves nothing behind. `installedAt` is passed in (caller stamps the
 * timestamp) to keep this function pure of the unavailable Date.now().
 */
export async function installPluginFromPath(
  sourceDir: string,
  name: string,
  installedAt: string,
  options: InstallPluginFromPathOptions = {},
): Promise<string> {
  assertSafePluginName(name);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new PluginInstallError(`source is not a directory: ${sourceDir}`);
  }
  const finalDir = pluginInstallDir(name);
  if (existsSync(finalDir)) {
    throw new PluginInstallError(
      `plugin '${name}' already installed; uninstall first or rename the source`,
    );
  }
  await mkdir(pluginsRoot(), { recursive: true });
  const tmpDir = join(pluginsRoot(), `.tmp-${name}-${process.pid}-${randomUUID()}`);
  await mkdir(tmpDir);

  try {
    const projected = await projectPluginSource(sourceDir, tmpDir, name);
    const meta: CSMeta = {
      name,
      format: projected.format,
      version: options.version ?? projected.version,
      source: options.source ?? sourceDir,
      installedAt,
    };
    await writeFile(join(tmpDir, ".cs-meta.json"), JSON.stringify(meta, null, 2));
    await rename(tmpDir, finalDir);
    // Register so existing loaders (scanInstalledPlugins / loadPluginHooks)
    // discover this local install. Marketplace tag "local" distinguishes it
    // from cache/marketplace installs.
    appendInstallEntry(pluginInstallKey(name, "local"), {
      scope: "user",
      installPath: finalDir,
      version: meta.version ?? "local",
      installedAt,
      lastUpdated: installedAt,
      ...pluginHookInstallRecord(finalDir),
      ...pluginMcpInstallRecord(finalDir, Object.keys(readPluginMcp(finalDir, name)).length > 0),
    });
    return finalDir;
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}
