/**
 * Minimal `git` subprocess wrappers used by the plugin marketplace. Each
 * function returns a discriminated union so callers can produce useful
 * error messages without try/catching. Mirrors Claude Code's
 * utils/plugins/marketplaceManager.ts:loadAndCacheMarketplace at the
 * subset we need for the MVP.
 */

import { spawn } from "node:child_process";

export type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

async function runGit(args: string[], cwd?: string, timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ ok: false, error: `git ${args.join(" ")} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, stdout: stdout.trim() });
      } else {
        resolve({
          ok: false,
          error: `git ${args.join(" ")} exited ${code}: ${stderr.trim() || "unknown error"}`,
        });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `git ${args.join(" ")} failed: ${err.message}` });
    });
  });
}

export async function gitClone(
  url: string,
  destDir: string,
  options?: { ref?: string },
): Promise<GitResult> {
  const args = ["clone", "--depth", "1"];
  if (options?.ref) args.push("--branch", options.ref);
  args.push("--", url, destDir);
  return runGit(args);
}

export async function gitRevParseHead(repoDir: string): Promise<GitResult> {
  return runGit(["rev-parse", "HEAD"], repoDir);
}

export async function gitFetchAndReset(repoDir: string, ref?: string): Promise<GitResult> {
  const fetchArgs = ["fetch", "--depth", "1", "origin"];
  if (ref) fetchArgs.push(ref);
  const fetch = await runGit(fetchArgs, repoDir);
  if (!fetch.ok) return fetch;
  return runGit(["reset", "--hard", ref ? `origin/${ref}` : "FETCH_HEAD"], repoDir);
}

/**
 * Github source helper: convert "owner/repo" to an https clone URL.
 */
export function githubRepoToCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}
