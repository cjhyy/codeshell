import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { PANEL_APP_MANIFEST_FILE, PanelAppManifest } from "./manifest.js";
import { panelAppPackageDir, panelAppsRoot, PanelAppInstallError } from "./paths.js";
import { InstalledPanelAppRecordSchema } from "./registry.js";

export const PANEL_PACKAGE_LIMITS = {
  entries: 2000,
  bytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  depth: 16,
} as const;
export const PANEL_APP_META_FILE = ".cs-panel-app-meta.json";
export function createPanelPackageHash(): Hash {
  return createHash("sha256").update("codeshell-panel-package-v1\0");
}
export function hashPanelPackageFile(hash: Hash, file: string, bytes: Buffer): void {
  if (file !== PANEL_APP_META_FILE)
    hash.update(file).update("\0").update(String(bytes.length)).update("\0").update(bytes);
}

/** The Skill scanner is synchronous; verify the same payload identity before reading pinned Skills. */
export function retainedPanelAppManifestSync(
  id: string,
  packageDigest: string,
): {
  root: string;
  manifest: PanelAppManifest;
} {
  const root = panelAppPackageDir(id, packageDigest);
  for (const directory of [
    panelAppsRoot(),
    join(panelAppsRoot(), ".versions"),
    join(panelAppsRoot(), ".versions", id),
    root,
  ]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new PanelAppInstallError("Panel App package store requires ordinary directories");
  }
  const files: string[] = [];
  let entries = 0,
    total = 0;
  const walk = (directory: string, prefix: string, depth: number) => {
    if (depth > PANEL_PACKAGE_LIMITS.depth)
      throw new PanelAppInstallError("Panel App package is too deep");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > PANEL_PACKAGE_LIMITS.entries)
        throw new PanelAppInstallError("Panel App package has too many entries");
      const path = join(directory, entry.name),
        name = prefix + entry.name;
      const info = lstatSync(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new PanelAppInstallError("Panel App package contains an unsafe entry");
      if (info.isDirectory()) walk(path, name + "/", depth + 1);
      else files.push(name);
    }
  };
  walk(root, "", 0);
  const hash = createPanelPackageHash();
  let manifestBytes: Buffer | undefined;
  let metadataBytes: Buffer | undefined;
  for (const file of files.sort()) {
    const path = join(root, ...file.split("/"));
    const descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = fstatSync(descriptor);
      const fileLimit =
        file === PANEL_APP_MANIFEST_FILE || file === PANEL_APP_META_FILE
          ? 1024 * 1024
          : PANEL_PACKAGE_LIMITS.fileBytes;
      if (!info.isFile() || info.size > fileLimit || total + info.size > PANEL_PACKAGE_LIMITS.bytes)
        throw new PanelAppInstallError("Panel App package exceeds its byte limit");
      // One extra byte detects growth without reading an unbounded changing file.
      const bytes = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      if (offset !== info.size)
        throw new PanelAppInstallError("Panel App package changed while reading");
      total += offset;
      const content = bytes.subarray(0, offset);
      hashPanelPackageFile(hash, file, content);
      if (file === PANEL_APP_MANIFEST_FILE) manifestBytes = content;
      if (file === PANEL_APP_META_FILE) metadataBytes = content;
    } finally {
      closeSync(descriptor);
    }
  }
  if (hash.digest("hex") !== packageDigest || !manifestBytes || !metadataBytes)
    throw new PanelAppInstallError("Retained Panel App package content has changed");
  const manifest = PanelAppManifest.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.id !== id) throw new PanelAppInstallError("Retained Panel App ID does not match");
  const { schemaVersion, ...rawRecord } = JSON.parse(metadataBytes.toString("utf8"));
  const record = InstalledPanelAppRecordSchema.parse(rawRecord);
  if (schemaVersion !== 1 || record.id !== id || record.version !== manifest.version)
    throw new PanelAppInstallError("Retained Panel App metadata does not match");
  return { root, manifest };
}
