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
import { resolveGit, isGitAvailable } from "../utils/exec.js";

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
  // Up-front check: if git isn't installed/reachable at all, return a clear,
  // actionable error instead of a raw "spawn git ENOENT". The desktop host
  // turns GIT_NOT_FOUND into a friendly "install Git" prompt.
  if (!isGitAvailable()) {
    return {
      ok: false,
      error:
        "GIT_NOT_FOUND: git was not found. Install Git (https://git-scm.com/downloads) " +
        "and restart, or set the `git.path` setting to your git binary.",
    };
  }
  // Resolve git: user `git.path` override, else PATH×PATHEXT (.cmd/.exe on Win).
  const r = await safeSpawn(resolveGit(), args, {
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

/**
 * Clone a marketplace repo cheaply. These repos can bundle hundreds of plugins
 * (thousands of files), but adding a marketplace only needs its manifest — the
 * individual plugin trees are pulled on demand at install time
 * ({@link gitSparseCheckoutAdd}). So we do a blobless, no-checkout clone and
 * then sparse-check out only the manifest directories.
 *
 * `sparsePaths` defaults to the two manifest locations we support
 * (.claude-plugin and .agents/plugins). On any failure of the sparse setup we
 * fall back to checking out the full tree, so correctness never depends on
 * sparse support being present.
 *
 * Pass `full: true` to skip sparse entirely and check out the whole tree. This
 * is required when the caller reads arbitrary plugin content from the clone
 * (installing a plugin or a plugin subdir), as opposed to a marketplace where
 * only the manifest dirs are needed up front.
 */
export async function gitClone(
  url: string,
  destDir: string,
  options?: { ref?: string; sparsePaths?: string[]; full?: boolean },
): Promise<GitResult> {
  const sparsePaths = options?.sparsePaths ?? [".claude-plugin", ".agents/plugins"];
  const args = ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout"];
  if (options?.ref) args.push("--branch", options.ref);
  args.push("--", url, destDir);
  const cloned = await runGit(args);
  if (!cloned.ok) return cloned;

  // Full-tree clone: skip sparse setup and check out everything. Used by plugin
  // content clones, which read files anywhere in the repo.
  if (options?.full) {
    const checkout = await runGit(["checkout"], destDir);
    if (!checkout.ok) return checkout;
    return cloned;
  }

  // Restrict the working tree to the manifest dirs, then check out. Use
  // non-cone mode so nested paths like ".agents/plugins" match exactly.
  const init = await runGit(["sparse-checkout", "set", "--no-cone", ...sparsePaths], destDir);
  if (!init.ok) {
    // Sparse unsupported/failed — fall back to a normal full checkout so the
    // manifest is still present.
    return runGit(["checkout"], destDir);
  }
  const checkout = await runGit(["checkout"], destDir);
  if (!checkout.ok) return checkout;
  return cloned;
}

/**
 * Expand a sparse-checkout to include an additional path (a plugin subdir),
 * materializing its blobs. Best-effort: if the repo isn't sparse this errors
 * harmlessly and the caller proceeds (the files are already present).
 */
export async function gitSparseCheckoutAdd(repoDir: string, relPath: string): Promise<GitResult> {
  return runGit(["sparse-checkout", "add", relPath], repoDir);
}

export async function gitRevParseHead(repoDir: string): Promise<GitResult> {
  return runGit(["rev-parse", "HEAD"], repoDir);
}

/**
 * Resolve a ref (default HEAD) on a remote git URL WITHOUT cloning — one
 * cheap network round-trip. Returns the 40-char SHA on success.
 */
export async function gitLsRemote(url: string, ref?: string): Promise<GitResult> {
  // `git ls-remote <url> <ref>` prints "<sha>\t<refname>"; take the first sha.
  const r = await runGit(["ls-remote", url, ref ?? "HEAD"]);
  if (!r.ok) return r;
  const sha = r.stdout.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { ok: false, error: `ls-remote: no sha for ${ref ?? "HEAD"} in: ${r.stdout.slice(0, 120)}` };
  }
  return { ok: true, stdout: sha };
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
