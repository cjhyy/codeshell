/**
 * Cross-platform executable resolution.
 *
 * Node's `child_process.spawn`/`execFile` on Windows do NOT walk PATHEXT for a
 * bare command name unless `shell:true` — so `execFile("git", …)` finds
 * `git.exe` but NOT a `git.cmd`/`gh.cmd` shim (common for tools installed via
 * scoop/npm/chocolatey). On POSIX a bare name in PATH works fine.
 *
 * `resolveExecutable` does an explicit PATH × PATHEXT lookup on Windows and
 * returns the first existing match's absolute path; on POSIX (or when nothing
 * is found) it returns the command unchanged, so callers can always pass the
 * result straight to execFile/spawn.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

/**
 * The names to probe for `command` on the current platform: the bare name on
 * POSIX (or when it already has an extension), plus each PATHEXT variant
 * (command.exe / .cmd / .bat …) on Windows.
 */
export function commandCandidateNames(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "win32" || extname(command)) return [command];
  const pathext = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return [command, ...pathext.map((ext) => `${command}${ext}`)];
}

function isExecutableFile(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `command` to an absolute executable path on Windows (walking
 * PATH × PATHEXT so .cmd/.bat shims are found). Returns `command` unchanged on
 * POSIX, when it already has a path separator/extension, or when no match is
 * found (let spawn surface the ENOENT then).
 */
const resolveCache = new Map<string, string>();

export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32") return command;
  const trimmed = command.trim();
  if (!trimmed) return command;
  const cached = resolveCache.get(trimmed);
  if (cached !== undefined) return cached;
  const result = resolveExecutableUncached(trimmed, env);
  resolveCache.set(trimmed, result);
  return result;
}

/** Test seam: drop the resolution cache. */
export function _clearExecutableCache(): void {
  resolveCache.clear();
}

function resolveExecutableUncached(trimmed: string, env: NodeJS.ProcessEnv): string {
  const command = trimmed;

  // Already a path (absolute or relative with a separator): resolve extension.
  const hasSep = trimmed.includes("/") || trimmed.includes("\\");
  if (hasSep || isAbsolute(trimmed)) {
    for (const name of commandCandidateNames(trimmed, env)) {
      if (isExecutableFile(name)) return name;
    }
    return command;
  }

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of commandCandidateNames(trimmed, env)) {
      const full = join(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return command;
}
