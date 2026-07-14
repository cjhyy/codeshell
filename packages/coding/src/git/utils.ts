/**
 * Git utility functions for the git workflow commands.
 *
 * Every call goes through execFileSync with an argv array — no command
 * strings, no shell interpolation. Even arguments that look "safe" (already
 * quoted, hard-coded) are passed as separate argv tokens so a future caller
 * can't accidentally widen the attack surface by interpolating user input
 * into the string form.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { parseGitLog, type GitLogEntry } from "./parse-log.js";
import { resolveExecutable, resolveGit } from "@cjhyy/code-shell-core";

export interface GitStatusEntry {
  status: string;
  path: string;
}

export type { GitLogEntry };

// Resolve git/gh through PATH×PATHEXT on Windows so a .cmd/.exe shim is found
// (bare execFile doesn't walk PATHEXT). No-op on POSIX. See utils/exec.ts.
const GH_BIN = resolveExecutable("gh");

/** Run git with an argv array and return its trimmed stdout. */
function git(cwd: string, args: string[], timeoutMs = 10000): string {
  return execFileSync(resolveGit(), args, { cwd, encoding: "utf-8", timeout: timeoutMs }).trim();
}

/** Run gh with an argv array and return its trimmed stdout. */
function gh(cwd: string, args: string[], timeoutMs = 10000): string {
  return execFileSync(GH_BIN, args, { cwd, encoding: "utf-8", timeout: timeoutMs }).trim();
}

export function isGitRepo(cwd: string): boolean {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a directory to its PROJECT ROOT: the enclosing git repository's
 * top-level dir if `cwd` is inside a git repo, otherwise `cwd` unchanged.
 *
 * This is the project-boundary rule the desktop uses when adding/identifying a
 * project: picking a SUBDIRECTORY of a git repo should belong to that one repo
 * (its root), not spawn a separate project per subdir — mirrors how editors
 * (and Claude Code) treat a repo as one workspace. A non-git folder is its own
 * project (returned as-is). Never throws; on any git failure falls back to cwd.
 * Returns the git-reported toplevel (already absolute, forward-slashed on win).
 */
export function resolveProjectRoot(cwd: string): string {
  let realCwd = cwd;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    // Non-existent paths are allowed to fall back unchanged below.
  }
  try {
    const top = git(realCwd, ["rev-parse", "--show-toplevel"], 5000);
    return top ? realpathSync(top) : realCwd;
  } catch {
    return realCwd;
  }
}

export function getCurrentBranch(cwd: string): string {
  return git(cwd, ["branch", "--show-current"], 5000);
}

export function getGitStatus(cwd: string): GitStatusEntry[] {
  const raw = git(cwd, ["status", "--porcelain"], 10000);
  if (!raw) return [];
  return raw.split("\n").map((line) => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3),
  }));
}

export function getGitDiff(cwd: string, opts?: { staged?: boolean; file?: string }): string {
  const args = ["diff", "--no-color"];
  if (opts?.staged) args.push("--staged");
  // `--` terminates option parsing so a file path starting with `-` can't
  // be re-interpreted as a flag.
  if (opts?.file) args.push("--", opts.file);
  return git(cwd, args, 30000);
}

export function getGitDiffStat(cwd: string, opts?: { staged?: boolean; file?: string }): string {
  const args = ["diff", "--stat", "--no-color"];
  if (opts?.staged) args.push("--staged");
  if (opts?.file) args.push("--", opts.file);
  return git(cwd, args, 10000);
}

export function getGitLog(cwd: string, n = 10): GitLogEntry[] {
  // `n` is numeric — coerce/validate to keep the argv clean even if a caller
  // hands us a string.
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
  const raw = git(cwd, ["log", "--oneline", "--format=%H|%s|%an|%ci", `-${count}`], 10000);
  if (!raw) return [];
  return parseGitLog(raw);
}

export function getRemoteUrl(cwd: string): string | undefined {
  try {
    return git(cwd, ["remote", "get-url", "origin"], 5000);
  } catch {
    return undefined;
  }
}

export function gitAdd(cwd: string, files: string[] = ["."]): void {
  // `--` ensures a path starting with `-` cannot be parsed as a flag.
  // Each file is its own argv token, so spaces / quotes / non-ASCII pass
  // through verbatim with no shell parsing.
  execFileSync(resolveGit(), ["add", "--", ...files], { cwd, timeout: 10000 });
}

export function gitCommit(cwd: string, message: string): string {
  // Pre-fix this used `JSON.stringify(message)` which only happened to be
  // safe because JSON.stringify covers most shell metacharacters — but it's
  // not real escaping. The argv form is.
  return execFileSync(resolveGit(), ["commit", "-m", message], {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
  }).trim();
}

export function gitListBranches(cwd: string): { name: string; current: boolean }[] {
  const raw = git(cwd, ["branch", "--no-color"], 5000);
  if (!raw) return [];
  return raw.split("\n").map((line) => ({
    current: line.startsWith("*"),
    name: line.replace(/^\*?\s+/, "").trim(),
  }));
}

export function gitCheckout(cwd: string, branch: string, create = false): void {
  // argv form defeats shell injection. We additionally reject branch names
  // that start with `-` so a value like `--orphan` can't slip through git's
  // own option parser (the trailing `--` trick doesn't help on checkout:
  // git interprets it as the option's value, not as an option terminator).
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("branch must be a non-empty string");
  }
  if (branch.startsWith("-")) {
    throw new Error(`refusing branch name that starts with '-': ${branch}`);
  }
  const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
  execFileSync(resolveGit(), args, { cwd, timeout: 10000 });
}

export function ghAvailable(): boolean {
  try {
    execFileSync(GH_BIN, ["--version"], { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function ghPrComments(cwd: string, prUrl: string): string {
  // Pre-fix `gh pr view ${prUrl}` interpolated the URL directly. argv form
  // means even a value like "$(rm -rf ~)" is sent to gh as a literal
  // positional argument (which gh will then reject as a bad PR URL).
  return gh(
    cwd,
    ["pr", "view", prUrl, "--comments", "--json", "comments", "-q", ".comments[].body"],
    30000,
  );
}
