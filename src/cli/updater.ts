/**
 * Auto-update checker — non-blocking check for newer versions on npm.
 */

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

let _updateAvailable: string | undefined;

/**
 * Check if a newer version is available (non-blocking).
 * Call this on startup and read the result later.
 */
export function checkForUpdate(packageName = "@cjhyy/code-shell"): void {
  try {
    const currentVersion = getCurrentVersion();
    // Run npm view in background — don't block startup
    const latestVersion = execSync(`npm view ${packageName} version 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (latestVersion && latestVersion !== currentVersion && compareVersions(latestVersion, currentVersion) > 0) {
      _updateAvailable = latestVersion;
    }
  } catch {
    // Silently fail — network might not be available
  }
}

export function getUpdateAvailable(): string | undefined {
  return _updateAvailable;
}

let _cachedVersion: string | undefined;

export function getCurrentVersion(): string {
  if (_cachedVersion) return _cachedVersion;
  const found = resolveVersion();
  _cachedVersion = found;
  return found;
}

function resolveVersion(): string {
  // Walk up from this module until we find a package.json with a "version" field.
  // Works in ESM and CJS builds, and in dev (bun src).
  try {
    const here = typeof import.meta !== "undefined" && import.meta.url
      ? dirname(fileURLToPath(import.meta.url))
      : __dirname;
    let dir = here;
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8"));
        if (pkg && typeof pkg.version === "string") return pkg.version;
      } catch {
        // not here, walk up
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  try {
    const req = createRequire(import.meta.url ?? __filename);
    const pkg = req("../../package.json");
    if (pkg?.version) return pkg.version as string;
  } catch {
    // ignore
  }
  return "0.0.0";
}

/** Simple semver comparison. Returns >0 if a > b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
