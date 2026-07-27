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

function userHome(): string {
  return process.env.CODE_SHELL_HOME ?? process.env.HOME ?? homedir();
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
