/**
 * Auto-update checker — non-blocking check for newer versions on npm.
 */

import { execSync } from "node:child_process";

let _updateAvailable: string | undefined;

/**
 * Check if a newer version is available (non-blocking).
 * Call this on startup and read the result later.
 */
export function checkForUpdate(packageName = "code-shell"): void {
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

export function getCurrentVersion(): string {
  try {
    const pkg = require("../../package.json");
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
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
