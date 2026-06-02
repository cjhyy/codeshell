import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectPluginFormat } from "./detectFormat.js";
import { pluginInstallDir } from "./paths.js";
import { uninstallPluginByName } from "./uninstall.js";
import { installPluginFromPath } from "./install.js";
import { installPluginFromSource } from "./installFromSource.js";
import { parseSource } from "./parseSource.js";
import { CodexPluginManifest, CSMeta, PluginInstallError } from "./types.js";

export interface UpdateResult {
  updated: boolean;
  reason: string;
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
    // uninstall-then-install isn't atomic: if the reinstall fails (clone
    // error, bad plugin) the old copy is already gone. We can't roll back the
    // removal, but we surface a clear error instead of leaving silent
    // inconsistency.
    uninstallPluginByName(name);
    try {
      await installPluginFromSource(parsed, name, installedAt);
    } catch (err) {
      throw new PluginInstallError(
        `update failed and '${name}' was removed during reinstall: ` +
          `${err instanceof Error ? err.message : String(err)}. Reinstall it from ${meta.source}.`,
      );
    }
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

  uninstallPluginByName(name);
  try {
    await installPluginFromPath(meta.source, name, installedAt);
  } catch (err) {
    throw new PluginInstallError(
      `update failed and '${name}' was removed during reinstall: ` +
        `${err instanceof Error ? err.message : String(err)}. Reinstall it from ${meta.source}.`,
    );
  }
  return { updated: true, reason: "reinstalled" };
}
