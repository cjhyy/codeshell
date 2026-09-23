import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { compare, valid } from "semver";
import { findPanelAppRoot } from "./discovery.js";
import { MAX_PANEL_UPDATE_MANIFEST_BYTES, readGitHubPanelAppManifest } from "./github-manifest.js";
import type { InstalledPanelAppSource } from "./installer.js";
import { PANEL_APP_MANIFEST_FILE, PanelAppManifest } from "./manifest.js";
import { assertSafePanelAppId, panelAppInstallDir } from "./paths.js";
import { readInstalledPanelAppsRegistry } from "./registry.js";

export interface PanelAppUpdateCheck {
  id: string;
  currentVersion: string;
  latestVersion?: string;
  status: "update-available" | "up-to-date" | "source-older" | "unsupported" | "error";
  checkedAt: string;
  sourceKind: "git" | "dir" | "zip";
  message?: string;
}

export interface InstalledPanelAppUpdateIdentity {
  id: string;
  version: string;
  source: InstalledPanelAppSource;
  lastUpdated: string;
}

async function readLocalManifest(root: string): Promise<string> {
  const path = join(root, PANEL_APP_MANIFEST_FILE);
  for (const directory of [root, dirname(path)]) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Panel App manifest directories must be ordinary directories");
    }
  }
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_PANEL_UPDATE_MANIFEST_BYTES) {
    throw new Error("Panel App manifest must be a regular file within the 1 MiB limit");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_PANEL_UPDATE_MANIFEST_BYTES) {
      throw new Error("Panel App manifest must be a regular file within the 1 MiB limit");
    }
    // Read at most the budget plus one byte, even if a local source grows after stat().
    const bytes = Buffer.alloc(MAX_PANEL_UPDATE_MANIFEST_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_PANEL_UPDATE_MANIFEST_BYTES) {
      throw new Error("Panel App manifest exceeds the 1 MiB limit");
    }
    return bytes.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

function manifestVersion(text: string, id: string): string {
  const manifest = PanelAppManifest.safeParse(JSON.parse(text));
  if (!manifest.success) throw new Error("Panel App source manifest is invalid");
  if (manifest.data.id !== id)
    throw new Error("Panel App source manifest ID does not match the installed app");
  const version = manifest.data.version;
  // semver accepts a leading v for compatibility, but package manifests require strict SemVer.
  if (version !== version.trim() || !/^[0-9]/.test(version) || !valid(version)) {
    throw new Error("Panel App manifest version is not a valid semantic version");
  }
  return version;
}

/** Read only the target manifest and registry record, without inspecting or hashing package assets. */
export async function getInstalledPanelAppUpdateIdentity(
  id: string,
): Promise<InstalledPanelAppUpdateIdentity | undefined> {
  try {
    assertSafePanelAppId(id);
    const record = (await readInstalledPanelAppsRegistry()).find((entry) => entry.id === id);
    if (!record) return undefined;
    return {
      id,
      version: manifestVersion(await readLocalManifest(panelAppInstallDir(id)), id),
      source: record.source,
      lastUpdated: record.lastUpdated,
    };
  } catch {
    return undefined;
  }
}

/**
 * Read-only version discovery. It neither grants permissions nor reviews/installs package code;
 * the existing full package review remains mandatory before applying any update.
 */
async function checkPanelAppSource(
  id: string,
  selected?: InstalledPanelAppUpdateIdentity,
): Promise<PanelAppUpdateCheck> {
  const result: PanelAppUpdateCheck = {
    id,
    currentVersion: "",
    status: "error",
    checkedAt: new Date().toISOString(),
    sourceKind: "dir",
  };
  try {
    assertSafePanelAppId(id);
    const record =
      selected ?? (await readInstalledPanelAppsRegistry()).find((entry) => entry.id === id);
    if (!record) throw new Error("Panel App has no installed source record");
    result.sourceKind =
      typeof record.source === "string"
        ? extname(record.source).toLowerCase() === ".zip"
          ? "zip"
          : "dir"
        : "git";
    // The registry can be stale: compare the package that is actually installed.
    result.currentVersion = selected
      ? selected.version
      : manifestVersion(await readLocalManifest(panelAppInstallDir(id)), id);
    if (typeof record.source === "string" && result.sourceKind === "zip") {
      // Source records predate a separate local kind field; a folder can also end in .zip.
      const metadata = await stat(record.source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (metadata?.isDirectory()) result.sourceKind = "dir";
    }
    if (result.sourceKind === "zip") {
      return {
        ...result,
        status: "unsupported",
        message: "ZIP sources require a manual package review to check for changes",
      };
    }
    const latest =
      typeof record.source === "string"
        ? await readLocalManifest(await findPanelAppRoot(await realpath(record.source)))
        : await readGitHubPanelAppManifest(record.source);
    result.latestVersion = manifestVersion(latest, id);
    const difference = compare(result.latestVersion, result.currentVersion);
    result.status =
      difference > 0 ? "update-available" : difference === 0 ? "up-to-date" : "source-older";
    return result;
  } catch (error) {
    return {
      ...result,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function checkInstalledPanelAppUpdate(id: string): Promise<PanelAppUpdateCheck> {
  return checkPanelAppSource(id);
}

/** The Host passes the identity of an already verified project-selected package. */
export function checkSelectedPanelAppUpdate(
  identity: InstalledPanelAppUpdateIdentity,
): Promise<PanelAppUpdateCheck> {
  return checkPanelAppSource(identity.id, identity);
}
