import { homedir } from "node:os";
import { join } from "node:path";
import { THEME_ID } from "./manifest.js";

export class ThemeInstallError extends Error {}

/** A review token changed between preview and install (content was modified). */
export class ThemeReviewChangedError extends ThemeInstallError {
  constructor() {
    super("theme content changed since preview");
  }
}

/**
 * Where installed themes live.
 *
 * This used to resolve HOME on its own, so a test that reached it without
 * CODE_SHELL_HOME wrote into the developer's real theme registry — eight
 * "concurrent-N" fixture packs showed up in a real settings picker on
 * 2026-09-06. The sessions-root guard did not cover it because this was a
 * second, independent home resolution.
 *
 * Fails closed under a test runner instead. `bun test` sets NODE_ENV=test
 * itself, so no test has to opt in, and a real host run is untouched.
 */
function userHome(): string {
  const explicit = process.env.CODE_SHELL_HOME;
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1") {
    throw new ThemeInstallError(
      "Refusing to use the real ~/.code-shell/themes from a test. Set CODE_SHELL_HOME " +
        "to a temp dir (packages/core/test-setup.ts does this via the bunfig preload).",
    );
  }
  return process.env.HOME ?? homedir();
}

/** A theme id must be a single safe path segment matching the manifest pattern. */
export function assertSafeThemeName(id: string): void {
  if (!THEME_ID.test(id) || id === "." || id === "..") {
    throw new ThemeInstallError(`invalid theme id: ${JSON.stringify(id)}`);
  }
}

export function themesRoot(): string {
  return join(userHome(), ".code-shell", "themes");
}

export function themeInstallDir(id: string): string {
  assertSafeThemeName(id);
  return join(themesRoot(), id);
}

/** Canonical asset subdirectory inside an installed theme. */
export const THEME_ASSET_DIR = ".cs-theme-assets";

/** Registry of installed themes. */
export function themesRegistryPath(): string {
  return join(themesRoot(), "installed.json");
}
