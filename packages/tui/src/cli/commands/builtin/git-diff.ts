import { execFileSync } from "node:child_process";

/**
 * Run `git` with an argv array (no shell), so a user-supplied `file` argument
 * can never be interpreted as shell syntax. The `/diff` command used to build
 * a shell string with execSync and interpolate raw user input — a command
 * injection (review-2026-05-30). Here `file` is a single literal pathspec
 * passed as its own argv element; git treats it as a path, nothing more.
 *
 * Errors (not a repo, git missing, unmatched pathspec) are swallowed and
 * surface as an empty string — matching the command's "Not a git repository
 * or git not available." fallback at the call site.
 */
function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

/** `git diff --stat HEAD [-- file]`. */
export function gitDiffStat(cwd: string, file: string): string {
  const args = ["diff", "--stat", "HEAD"];
  if (file) args.push("--", file);
  return runGit(cwd, args);
}

/** `git diff HEAD --no-color [-- file]`. */
export function gitDiff(cwd: string, file: string): string {
  const args = ["diff", "HEAD", "--no-color"];
  if (file) args.push("--", file);
  return runGit(cwd, args);
}
