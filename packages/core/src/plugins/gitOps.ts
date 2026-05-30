/**
 * Minimal `git` subprocess wrappers used by the plugin marketplace. Each
 * function returns a discriminated union so callers can produce useful
 * error messages without try/catching. Mirrors Claude Code's
 * utils/plugins/marketplaceManager.ts:loadAndCacheMarketplace at the
 * subset we need for the MVP.
 *
 * Subprocess lifecycle (spawn, timeout cascade, IO drain, byte cap) is
 * centralized in {@link safeSpawn}; gitOps only owns the error-shape
 * mapping into GitResult.
 *
 * Trust: gitOps is invoked from marketplace install/update actions that the
 * user initiates by typing `/plugin install ...` (or the equivalent). It is
 * NOT exposed to the LLM via tool calls, so it does not need permission
 * classification. See docs/architecture/17 for the trust framing.
 */

import { safeSpawn } from "../runtime/safe-spawn.js";

export type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

/**
 * Force git to never prompt interactively. gitOps runs in headless contexts
 * (the Electron main process, the agent worker) that have no TTY, so a
 * private/auth-required clone or an unknown SSH host key would otherwise make
 * git BLOCK on a credential/host-key prompt — the operation appears to hang
 * until the safeSpawn timeout (or an off-screen askpass dialog). With these
 * set, git fails fast with an auth error instead.
 *
 * - GIT_TERMINAL_PROMPT=0 — git's own username/password prompt becomes an error.
 * - GIT_SSH_COMMAND BatchMode=yes — ssh never asks for a password/passphrase;
 *   accept-new auto-trusts a first-seen host key (instead of the y/n prompt)
 *   but still rejects a changed key. Not overridden if the caller already
 *   provides GIT_SSH_COMMAND (e.g. a custom identity file).
 */
export function nonInteractiveGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND:
      base.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
  };
}

async function runGit(args: string[], cwd?: string, timeoutMs = 60_000): Promise<GitResult> {
  const r = await safeSpawn("git", args, {
    cwd: cwd ?? process.cwd(),
    env: nonInteractiveGitEnv(process.env),
    timeoutMs,
  });
  if (r.spawnFailed) {
    return { ok: false, error: `git ${args.join(" ")} failed: ${r.error ?? "spawn failed"}` };
  }
  if (r.timedOut) {
    return { ok: false, error: `git ${args.join(" ")} timed out after ${timeoutMs}ms` };
  }
  if (r.exitCode === 0) {
    return { ok: true, stdout: r.stdout.trim() };
  }
  return {
    ok: false,
    error: `git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.trim() || "unknown error"}`,
  };
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
