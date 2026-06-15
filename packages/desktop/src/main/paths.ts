/**
 * Pure path helpers for the desktop main process — NO Electron / fs imports so
 * they stay unit-testable under `bun test` (which can't load `electron`).
 */
import * as path from "node:path";

/**
 * Resolve a path the way the "open with" actions need it: strip a trailing
 * `:line[:col]` suffix and resolve relative paths against `cwd` (defaulting to
 * the process cwd). Pure — no filesystem or Electron access.
 */
export function resolveTargetPath(targetPath: string, cwd?: string): string {
  const cleaned = targetPath.replace(/:(\d+)(?::(\d+))?$/, "");
  return path.isAbsolute(cleaned)
    ? cleaned
    : path.resolve(cwd ?? process.cwd(), cleaned);
}
