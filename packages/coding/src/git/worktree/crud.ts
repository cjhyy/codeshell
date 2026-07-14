import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildSandboxEnv,
  defaultShellBinary,
  mergeShellEnv,
  safeSpawnShell,
  type SandboxBackend,
} from "@cjhyy/code-shell-core";
import { execGit, execGitSync, gitErrorMessage, gitOutput } from "./git-exec.js";
import { assertBranchNotCheckedOut, currentBranch, findGitRoot } from "./query.js";
import { applyPrefix, isManagedWorktreeBranch, validateWorktreeSlug } from "./slug.js";

export interface WorktreeSession {
  originalCwd: string;
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
  originalBranch?: string;
  /** Immutable commit used to create the branch. Safe for later ahead checks. */
  baseRef?: string;
  /** User-facing ref selector (`head`, `fresh`, or an explicit ref). */
  baseRefLabel?: string;
  /** Gitignored files copied from `.worktreeinclude` / DriveAgent include patterns. */
  includedFiles?: string[];
  sessionId: string;
  createdAt: number;
}

/** Per-platform setup/cleanup scripts (a project's localEnvironment). */
export interface PlatformScripts {
  default?: string;
  macos?: string;
  linux?: string;
  windows?: string;
}

export interface CreateWorktreeOptions {
  prefix?: string;
  signal?: AbortSignal;
  /** `head`, `fresh` (local origin/HEAD), or an explicit git ref. */
  baseRef?: string;
  /** Extra gitignore-style patterns, combined with a root `.worktreeinclude`. */
  include?: string[];
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/**
 * Best-effort rollback for an aborted `git worktree add`.
 *
 * `allowRecursiveDelete` gates the `rm -rf` fallback. It must stay `false`
 * whenever the worktree path already existed before this call: a `git worktree
 * add` that fails with "already exists" never registered the path, so the
 * fallback would recursively delete a directory (and any uncommitted work in
 * it) that this call did not create. Only genuine partial-creation states —
 * where `worktree add` succeeded and a later step failed — may fall back to a
 * recursive delete.
 */
export async function cleanupAbortedWorktree(
  gitRoot: string,
  worktreePath: string,
  branchName: string,
  allowRecursiveDelete = true,
): Promise<void> {
  try {
    await execGit(gitRoot, ["worktree", "remove", worktreePath, "--force"], 30_000);
  } catch {
    if (allowRecursiveDelete) {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    }
    await execGit(gitRoot, ["worktree", "prune"], 10_000).catch(() => {});
  }
  await execGit(gitRoot, ["branch", "-D", branchName], 10_000).catch(() => {});
}

/**
 * Pick the setup/cleanup script for the running platform, falling back to
 * `default`. Empty/whitespace-only scripts are treated as absent so a project
 * can leave a platform key blank without spawning an empty shell. `platform`
 * defaults to `process.platform` so callers usually omit it; tests pass a
 * fixed value.
 */
export function selectPlatformScript(
  scripts: PlatformScripts | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!scripts) return undefined;
  const key = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
  // A blank platform key shouldn't shadow a real `default` — fall through.
  const platformScript = scripts[key]?.trim() ? scripts[key] : undefined;
  const candidate = platformScript ?? scripts.default;
  const trimmed = candidate?.trim();
  return trimmed ? candidate : undefined;
}

/**
 * Create an isolated git worktree for an agent session.
 */
export async function createWorktree(
  cwd: string,
  slug: string,
  sessionId: string,
  opts: CreateWorktreeOptions = {},
): Promise<WorktreeSession> {
  validateWorktreeSlug(slug);
  throwIfAborted(opts.signal);

  const gitRoot = await findGitRoot(cwd);
  throwIfAborted(opts.signal);
  const branchName = applyPrefix(opts.prefix, slug, sessionId);
  const worktreePath = resolve(gitRoot, "..", `.worktrees/${slug}-${sessionId.slice(0, 8)}`);
  await assertBranchNotCheckedOut(gitRoot, branchName);
  if (await gitRefExists(gitRoot, `refs/heads/${branchName}`)) {
    throw new Error(`branch ${branchName} already exists`);
  }
  // If a directory already sits at the worktree path, `git worktree add` will
  // fail without registering it. Remember that so rollback never rm -rf's a
  // pre-existing directory (and any uncommitted work in it) we did not create.
  const worktreePathPreexisted = existsSync(worktreePath);
  throwIfAborted(opts.signal);

  const originalBranch = await currentBranch(gitRoot);
  throwIfAborted(opts.signal);
  const resolvedBase = await resolveWorktreeBase(
    gitRoot,
    opts.baseRef,
    originalBranch,
    opts.signal,
  );
  throwIfAborted(opts.signal);

  // The argv form keeps branchName/worktreePath as literal positional
  // arguments even if a future caller bypasses validateWorktreeSlug.
  try {
    await execGit(
      gitRoot,
      ["worktree", "add", "-b", branchName, worktreePath, resolvedBase.commit],
      30_000,
      opts.signal,
    );
    throwIfAborted(opts.signal);

    // Symlink large directories to avoid disk bloat.
    symlinkLargeDirectories(gitRoot, worktreePath);
    throwIfAborted(opts.signal);

    const includedFiles = copyWorktreeIncludes(gitRoot, worktreePath, opts.include);
    throwIfAborted(opts.signal);

    return {
      originalCwd: cwd,
      worktreePath,
      worktreeName: slug,
      worktreeBranch: branchName,
      originalBranch,
      baseRef: resolvedBase.commit,
      baseRefLabel: resolvedBase.label,
      ...(includedFiles.length > 0 ? { includedFiles } : {}),
      sessionId,
      createdAt: Date.now(),
    };
  } catch (error) {
    // A failed include copy is just as incomplete as an aborted checkout. Do
    // not leave a half-configured worktree/branch behind for an agent to use.
    // But never recursively delete a directory that predated this call: if the
    // path already existed, `git worktree add` failed without registering it.
    await cleanupAbortedWorktree(gitRoot, worktreePath, branchName, !worktreePathPreexisted);
    throw error;
  }
}

interface ResolvedWorktreeBase {
  label: string;
  commit: string;
}

/** Resolve a stable commit before creating the branch. `fresh` intentionally
 * uses the locally-known remote default ref and never performs implicit
 * network I/O; callers that need the newest remote state should fetch first. */
async function resolveWorktreeBase(
  gitRoot: string,
  requested: string | undefined,
  originalBranch: string | undefined,
  signal?: AbortSignal,
): Promise<ResolvedWorktreeBase> {
  const selector = requested?.trim() || "head";
  let label = selector;
  if (selector.toLowerCase() === "head") {
    label = "HEAD";
  } else if (selector.toLowerCase() === "fresh") {
    const remoteHead = (
      await gitOutput(gitRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    )?.trim();
    const originalRemote = originalBranch ? `origin/${originalBranch}` : undefined;
    label =
      remoteHead ||
      (originalRemote && (await gitRefExists(gitRoot, originalRemote)) ? originalRemote : "HEAD");
  }
  signal?.throwIfAborted();
  const commit = (
    await execGit(gitRoot, ["rev-parse", "--verify", `${label}^{commit}`], 10_000, signal)
  ).trim();
  if (!commit) throw new Error(`Unable to resolve worktree base ref: ${selector}`);
  return { label: selector.toLowerCase() === "fresh" ? `${selector} (${label})` : label, commit };
}

async function gitRefExists(gitRoot: string, ref: string): Promise<boolean> {
  return !!(await gitOutput(gitRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
}

/** Copy gitignored configuration selected by `.worktreeinclude` and explicit
 * patterns. Only regular files reported by `git ls-files --ignored` are copied,
 * so patterns cannot escape the repository or overwrite tracked checkout data. */
export function copyWorktreeIncludes(
  sourceRoot: string,
  worktreePath: string,
  explicitPatterns: readonly string[] | undefined,
): string[] {
  const includeFile = join(sourceRoot, ".worktreeinclude");
  const filePatterns = existsSync(includeFile)
    ? parseWorktreeInclude(readFileSync(includeFile, "utf8"))
    : [];
  const patterns = [...filePatterns, ...(explicitPatterns ?? [])]
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) return [];
  for (const pattern of patterns) validateIncludePattern(pattern);

  const ignored = execGitSync(
    sourceRoot,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    15_000,
  )
    .split("\0")
    .filter(Boolean)
    .map(normalizeGitPath);
  const included: string[] = [];
  for (const file of ignored) {
    if (!matchesIncludePatterns(file, patterns)) continue;
    const source = resolve(sourceRoot, file);
    const target = resolve(worktreePath, file);
    if (!isContainedPath(sourceRoot, source) || !isContainedPath(worktreePath, target)) continue;
    const info = lstatSync(source);
    if (!info.isFile()) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, statSync(source).mode);
    included.push(file);
  }
  return included;
}

function parseWorktreeInclude(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function validateIncludePattern(raw: string): void {
  const pattern = raw.startsWith("!") ? raw.slice(1) : raw;
  if (!pattern || isAbsolute(pattern) || pattern.split(/[\\/]+/).includes("..")) {
    throw new Error(`Invalid worktree include pattern: ${raw}`);
  }
}

/** Ordered gitignore-style subset: `*`, `?`, `**`, leading `/`, directory
 * suffixes, basename-only matches, and `!` negation. */
function matchesIncludePatterns(path: string, patterns: readonly string[]): boolean {
  let included = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = normalizeGitPath(negated ? raw.slice(1) : raw);
    if (globMatches(path, pattern)) included = !negated;
  }
  return included;
}

function globMatches(path: string, rawPattern: string): boolean {
  const anchored = rawPattern.startsWith("/");
  let pattern = anchored ? rawPattern.slice(1) : rawPattern;
  const directory = pattern.endsWith("/");
  if (directory) pattern += "**";
  const hasSlash = pattern.includes("/");
  const body = globToRegExp(pattern);
  const prefix = anchored || hasSlash ? "^" : "(?:^|/)";
  const suffix = directory ? "(?:/.*)?$" : "$";
  return new RegExp(`${prefix}${body}${suffix}`).test(path);
}

function globToRegExp(pattern: string): string {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return out;
}

function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface WorktreeSetupResult {
  /** True if no setup script was configured for this platform (nothing ran). */
  skipped: boolean;
  /** True if a script ran and exited 0. */
  ok: boolean;
  /** Combined stdout/stderr, for surfacing to the user on failure. */
  output: string;
  /** Exit code when a script ran; undefined when skipped. */
  exitCode?: number | null;
}

/**
 * Run a project's `localEnvironment.setupScripts` once, in the freshly-created
 * worktree's root, right after `git worktree add`.
 */
export async function runWorktreeSetup(
  worktreePath: string,
  script: string | undefined,
  opts: {
    sandbox?: SandboxBackend;
    shellEnv?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<WorktreeSetupResult> {
  const trimmed = script?.trim();
  if (!trimmed) return { skipped: true, ok: true, output: "" };

  const shell = defaultShellBinary();
  const backend = opts.sandbox;
  const baseEnv = backend && backend.name !== "off" ? buildSandboxEnv() : { ...process.env };
  const env = mergeShellEnv(baseEnv, opts.shellEnv);

  const result = await safeSpawnShell(trimmed, {
    cwd: worktreePath,
    env,
    timeoutMs: opts.timeoutMs ?? 120_000,
    maxOutputBytes: 1024 * 1024,
    sandbox: backend,
    shell,
    signal: opts.signal,
  });

  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);
  const output = parts.join("\n").trim();

  if (result.aborted) return { skipped: false, ok: false, output: output || "setup aborted" };
  if (result.timedOut) return { skipped: false, ok: false, output: output || "setup timed out" };
  if (result.spawnFailed) {
    return { skipped: false, ok: false, output: result.error ?? "failed to spawn setup script" };
  }
  return { skipped: false, ok: result.exitCode === 0, output, exitCode: result.exitCode };
}

export interface RemoveWorktreeResult {
  /** True once `git worktree remove` completed and the directory is gone. */
  dirRemoved: boolean;
  /** The branch targeted for deletion when removeBranch=true. */
  branch?: string;
  /** True when removeBranch=true and branch deletion completed. */
  branchDeleted?: boolean;
  /** Non-empty when the worktree directory is gone but branch deletion failed. */
  branchError?: string;
}

export interface RemoveWorktreeOptions {
  prefix?: string;
}

export interface WorktreeChangeState {
  uncommitted: boolean;
  commitsAhead: number;
  hasChanges: boolean;
}

/** Inspect both working-tree changes and commits made since the immutable base
 * commit captured at creation time. */
export function inspectWorktreeChanges(
  worktreePath: string,
  baseRef?: string,
): WorktreeChangeState {
  const uncommitted =
    execGitSync(worktreePath, ["status", "--porcelain"], 10_000).trim().length > 0;
  let commitsAhead = 0;
  if (baseRef) {
    const raw = execGitSync(
      worktreePath,
      ["rev-list", "--count", `${baseRef}..HEAD`],
      10_000,
    ).trim();
    commitsAhead = Number.parseInt(raw, 10) || 0;
  }
  return { uncommitted, commitsAhead, hasChanges: uncommitted || commitsAhead > 0 };
}

/** Prevent pruning/removal while an external agent owns the worktree. */
export function lockWorktree(worktreePath: string, reason: string): void {
  execGitSync(worktreePath, ["worktree", "lock", "--reason", reason, worktreePath], 10_000);
}

/** Unlock is idempotent for lifecycle cleanup/keep paths. */
export function unlockWorktree(worktreePath: string): void {
  const entries = execGitSync(worktreePath, ["worktree", "list", "--porcelain"], 10_000);
  const block = entries
    .split(/\r?\n\r?\n/)
    .find((entry) => entry.split(/\r?\n/)[0] === `worktree ${worktreePath}`);
  if (!block || !/^locked(?: |$)/m.test(block)) return;
  execGitSync(worktreePath, ["worktree", "unlock", worktreePath], 10_000);
}

/**
 * Remove a worktree and optionally its branch.
 */
export function removeWorktree(
  worktreePath: string,
  removeBranch = false,
  opts: RemoveWorktreeOptions = {},
): RemoveWorktreeResult {
  // The MAIN repo root, not the worktree's own toplevel. `git rev-parse
  // --show-toplevel` from inside a worktree returns the worktree path, which
  // is about to be deleted; the branch-delete must run from the main repo,
  // which outlives the worktree. Derive it from the common git dir.
  let mainRoot: string;
  try {
    const commonDir = execGitSync(
      worktreePath,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      5000,
    ).trim();
    mainRoot = dirname(commonDir);
  } catch (err) {
    throw new Error(`failed to inspect worktree ${worktreePath}: ${gitErrorMessage(err)}`, {
      cause: err,
    });
  }

  // Capture the worktree's branch BEFORE removing the worktree — afterwards
  // the directory is gone and `git branch --show-current` in it would fail.
  let branch = "";
  if (removeBranch) {
    try {
      branch = execGitSync(worktreePath, ["branch", "--show-current"], 5000).trim();
    } catch (err) {
      throw new Error(
        `failed to determine branch for worktree ${worktreePath}: ${gitErrorMessage(err)}`,
        { cause: err },
      );
    }
    if (!branch) {
      throw new Error(`failed to determine branch for worktree ${worktreePath}`);
    }
    if (!isManagedWorktreeBranch(branch, opts.prefix)) {
      throw new Error(`refusing to delete non-CodeShell worktree branch ${branch}`);
    }
  }

  try {
    execGitSync(mainRoot, ["worktree", "remove", worktreePath, "--force"], 30000);
  } catch (err) {
    throw new Error(`failed to remove worktree ${worktreePath}: ${gitErrorMessage(err)}`, {
      cause: err,
    });
  }

  if (removeBranch) {
    try {
      execGitSync(mainRoot, ["branch", "-D", branch], 10000);
    } catch (err) {
      return {
        dirRemoved: true,
        branch,
        branchDeleted: false,
        branchError: gitErrorMessage(err),
      };
    }
  }
  return removeBranch ? { dirRemoved: true, branch, branchDeleted: true } : { dirRemoved: true };
}

/**
 * Symlink large directories (node_modules, .venv, etc.) from main repo to
 * worktree. Also links each monorepo workspace package's private
 * `node_modules` (e.g. `packages/desktop/node_modules`, where bun keeps
 * un-hoisted deps like electron) so a fresh worktree can build/run the whole
 * workspace, not just the packages whose deps happen to be hoisted to the root.
 */
function symlinkLargeDirectories(sourceRoot: string, worktreePath: string): void {
  const largeDirs = ["node_modules", ".venv", "vendor", ".pnpm-store"];
  for (const dir of largeDirs) {
    linkDir(join(sourceRoot, dir), join(worktreePath, dir));
  }

  // Monorepo workspace packages keep private node_modules that are NOT hoisted
  // to the root. Link `<pkg>/node_modules` for each package under `packages/`.
  const packagesDir = join(sourceRoot, "packages");
  if (!dirExists(packagesDir)) return;
  let pkgNames: string[];
  try {
    pkgNames = readdirSync(packagesDir);
  } catch {
    return;
  }
  for (const pkg of pkgNames) {
    const source = join(packagesDir, pkg, "node_modules");
    if (!dirExists(source)) continue;
    const targetPkgDir = join(worktreePath, "packages", pkg);
    // The worktree only has package dirs that exist in this branch's tree; a
    // package present in the main repo but not checked out here is skipped.
    if (!dirExists(targetPkgDir)) {
      try {
        mkdirSync(targetPkgDir, { recursive: true });
      } catch {
        continue;
      }
    }
    linkDir(source, join(targetPkgDir, "node_modules"));
  }
}

function dirExists(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function linkDir(source: string, target: string): void {
  // Windows directory symlinks need admin/Developer Mode and throw EPERM for a
  // normal user; NTFS junctions don't and behave the same for our purpose.
  const linkType = process.platform === "win32" ? "junction" : "dir";
  if (dirExists(source) && !existsSync(target)) {
    try {
      symlinkSync(source, target, linkType);
    } catch {
      // Symlink/junction might fail on some systems — non-fatal.
    }
  }
}
