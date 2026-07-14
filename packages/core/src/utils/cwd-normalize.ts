import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Canonicalize a runtime cwd without assuming any product domain. */
export function normalizeCwdPath(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function isExistingDirectory(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}
