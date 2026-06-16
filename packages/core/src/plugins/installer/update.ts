import { existsSync, readFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { detectPluginFormat } from "./detectFormat.js";
import { pluginInstallDir } from "./paths.js";
import { installPluginFromPath } from "./install.js";
import { installPluginFromSource } from "./installFromSource.js";
import { parseSource } from "./parseSource.js";
import { pluginInstallKey, readInstalledPlugins, removeInstallEntries, writeInstalledPlugins } from "../installedPlugins.js";
import { CodexPluginManifest, CSMeta, PluginInstallError } from "./types.js";

export interface UpdateResult {
  updated: boolean;
  reason: string;
}

/**
 * Reinstall a plugin atomically: a failed update leaves the OLD plugin intact.
 *
 * The installers (installPluginFromPath / installPluginFromSource) build into a
 * temp dir then rename into pluginInstallDir(name), and THROW if the final dir
 * already exists. So we must free the final dir *before* installing — we do that
 * by renaming the live dir to a sibling backup. On success we drop the backup;
 * on failure we delete any partial install and rename the backup back.
 *
 * Async fs only — this runs in the Electron main process, so we never block the
 * event loop with sync fs. process.pid (not Date.now(), unavailable here) makes
 * the backup name unique.
 */
async function reinstallAtomic(
  name: string,
  source: string,
  doInstall: () => Promise<unknown>,
): Promise<void> {
  const dir = pluginInstallDir(name);
  const backup = `${dir}.bak-${process.pid}`;

  // Capture the existing install_plugins.json entries so a failed reinstall can
  // restore them (uninstall-then-install used to drop them on failure; here the
  // old plugin survives, so its registration must survive too).
  const key = pluginInstallKey(name, "local");
  const savedEntries = readInstalledPlugins().plugins[key];

  await rm(backup, { recursive: true, force: true });
  await rename(dir, backup);
  // The installer re-adds the entry on success; remove the stale one first so a
  // successful reinstall doesn't accumulate a duplicate.
  removeInstallEntries(key);

  try {
    await doInstall();
  } catch (err) {
    // Roll back: drop any partial install, restore the old dir + its entries.
    await rm(dir, { recursive: true, force: true });
    await rename(backup, dir);
    if (savedEntries) {
      // Restore in a single read-modify-write rather than one append per entry,
      // which both narrows the race window against any concurrent writer and
      // avoids re-appending onto whatever partial state doInstall() may have
      // left for this key.
      const data = readInstalledPlugins();
      data.plugins[key] = savedEntries;
      writeInstalledPlugins(data);
    }
    throw new PluginInstallError(
      `update failed; the old version of '${name}' was kept: ` +
        `${err instanceof Error ? err.message : String(err)}. Source: ${source}.`,
    );
  }

  // Success — drop the backup (best-effort; a leftover backup is harmless but
  // we clean it up so it never shows up in the plugins root).
  await rm(backup, { recursive: true, force: true });
}

/**
 * Reinstall a plugin from its recorded source.
 *
 * - Local source: reinstall when the source version changed, or when `force`.
 *   CC plugins have no version → only `force` updates them.
 * - Remote (git) source: re-clone and reinstall every time — git sources carry
 *   no local version file to compare, so update is always a fresh pull
 *   (equivalent to `--force`; cheap and reliable). See spec §9.
 */
export async function updatePluginByName(
  name: string,
  installedAt: string,
  force: boolean,
): Promise<UpdateResult> {
  const dir = pluginInstallDir(name);
  const metaPath = join(dir, ".cs-meta.json");
  if (!existsSync(metaPath)) throw new PluginInstallError(`no plugin named '${name}'`);
  const meta = CSMeta.parse(JSON.parse(readFileSync(metaPath, "utf-8")));

  const parsed = parseSource(meta.source);

  if (parsed.kind === "remote") {
    // No local version to diff against — always re-clone and reinstall.
    await reinstallAtomic(name, meta.source, () =>
      installPluginFromSource(parsed, name, installedAt),
    );
    return { updated: true, reason: "reinstalled from git source" };
  }

  if (!existsSync(meta.source)) {
    throw new PluginInstallError(`source no longer exists: ${meta.source}`);
  }

  if (!force) {
    if (detectPluginFormat(meta.source) === "codex") {
      const manifest = CodexPluginManifest.parse(
        JSON.parse(readFileSync(join(meta.source, ".codex-plugin", "plugin.json"), "utf-8")),
      );
      if (manifest.version === meta.version) {
        return { updated: false, reason: "already up to date" };
      }
    } else {
      return { updated: false, reason: "CC plugin needs --force to reinstall" };
    }
  }

  await reinstallAtomic(name, meta.source, () =>
    installPluginFromPath(meta.source, name, installedAt),
  );
  return { updated: true, reason: "reinstalled" };
}
