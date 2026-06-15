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

/**
 * Find `command` as a real, runnable executable. Unlike {@link resolveExecutable}
 * (which returns the bare name unchanged when nothing is found, so spawn can
 * surface its own ENOENT), this returns the absolute path if a binary exists or
 * `null` if it genuinely cannot be found — works on POSIX too (probes PATH).
 * Use it to *detect* a missing tool up front (e.g. is git installed?).
 */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const hasSep = trimmed.includes("/") || trimmed.includes("\\") || isAbsolute(trimmed);
  if (hasSep) {
    for (const name of commandCandidateNames(trimmed, env)) {
      if (isExecutableFile(name)) return name;
    }
    return null;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of commandCandidateNames(trimmed, env)) {
      const full = join(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

// ─── git executable: optional user override + availability probe ───────────
//
// codeshell shells out to `git` for marketplace clones, worktrees, and diffs.
// A GUI launch may not inherit the user's PATH (classic Windows/macOS issue),
// so we let the user point us at a git binary explicitly via the `git.path`
// setting — mirrors VS Code's `git.path`. The desktop host reads that setting
// and calls setGitPathOverride() at startup / on settings change.

let gitPathOverride: string | null = null;

/** Set (or clear, with null/"") the user-configured git binary path. */
export function setGitPathOverride(path: string | null | undefined): void {
  gitPathOverride = path && path.trim() ? path.trim() : null;
}

/**
 * The git command to spawn: the user override if set, else `git` resolved
 * through PATH×PATHEXT. Always returns something spawnable (callers still get
 * a structured spawn-failure if it's wrong).
 */
export function resolveGit(env: NodeJS.ProcessEnv = process.env): string {
  if (gitPathOverride) return resolveExecutable(gitPathOverride, env);
  return resolveExecutable("git", env);
}

/** Is a usable git binary available (override path, or git on PATH)? */
export function isGitAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return findExecutable(gitPathOverride ?? "git", env) !== null;
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
