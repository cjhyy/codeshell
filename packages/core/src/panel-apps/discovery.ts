import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { PANEL_APP_MANIFEST_FILE } from "./manifest.js";
import { PanelAppInstallError } from "./paths.js";

export const MAX_PANEL_DISCOVERY_DEPTH = 4;
export const MAX_PANEL_DISCOVERY_DIRECTORIES = 512;
const MAX_PANEL_DISCOVERY_RESULTS = 16;

function looksLikePanelAppRoot(directory: string): boolean {
  return existsSync(join(directory, PANEL_APP_MANIFEST_FILE));
}

export async function discoverPanelAppRoots(directory: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [{ directory, depth: 0 }];
  let visited = 0;
  while (
    pending.length > 0 &&
    visited < MAX_PANEL_DISCOVERY_DIRECTORIES &&
    found.length < MAX_PANEL_DISCOVERY_RESULTS
  ) {
    const current = pending.shift()!;
    visited += 1;
    if (looksLikePanelAppRoot(current.directory)) {
      found.push(current.directory);
      continue;
    }
    if (current.depth >= MAX_PANEL_DISCOVERY_DEPTH) continue;
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      if (pending.length + visited >= MAX_PANEL_DISCOVERY_DIRECTORIES) {
        throw new PanelAppInstallError(
          "Panel App directory discovery limit exceeded; choose an app subdirectory",
        );
      }
      pending.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return found;
}

export async function findPanelAppRoot(directory: string): Promise<string> {
  if (looksLikePanelAppRoot(directory)) return directory;
  const found = await discoverPanelAppRoots(directory);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    const candidates = found
      .map((root) => relative(directory, root).split(sep).join(posix.sep))
      .sort()
      .join(", ");
    throw new PanelAppInstallError(
      `multiple Panel Apps found; choose an app subdirectory: ${candidates}`,
    );
  }
  throw new PanelAppInstallError(
    `no Panel App found (expected ${PANEL_APP_MANIFEST_FILE}); ` +
      "for a monorepo, provide the app subdirectory or a GitHub /tree/<ref>/<path> URL",
  );
}
