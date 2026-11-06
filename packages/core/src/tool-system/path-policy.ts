/**
 * PathPolicy — shared classifier for file-tool path safety.
 *
 * Today the file tools (Read, Write, Edit, ApplyPatch, NotebookEdit) operate
 * directly on host paths with no shared safety layer. acceptEdits / Bash
 * sandboxing don't help here: a Write that an LLM points at ~/.aws/credentials
 * or a path outside the workspace gets silently honored.
 *
 * This module is the MVP boundary called out in
 * docs/superpowers/plans/2026-05-27-core-quality-iteration.md, Workstream B.
 *
 * Decision shape (aligned with Codex / Claude Code):
 *   "allow"  — every read; writes inside the workspace that touch no
 *              protected path
 *   "ask"    — writes outside the workspace, and writes to protected paths
 *              (credentials, .git, agent/IDE config, shell rc files) even
 *              inside it
 *   "deny"   — only degenerate input (empty path)
 *
 * The classifier is pure: it resolves symlinks (best effort), checks against
 * an explicit protected list, then compares against the workspace root. It
 * never reads the file; the caller is the one with IO.
 *
 * Rollout escape hatch:
 *   CODESHELL_PATH_POLICY=off  → classifyPath returns "allow" for everything
 *   (logged once per process). This is the reversible-rollout switch
 *   recorded in the plan's Definition of Done.
 *
 * acceptEdits cannot bypass this layer — by design, acceptEdits is a
 * permission-system shortcut that lets routine in-workspace edits skip an
 * approval round-trip; it is not an authority to write anywhere on disk.
 * Callers must consult classifyPath before honoring acceptEdits.
 */

import { constants, realpathSync, existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { SettingsManager } from "../settings/manager.js";
import { basename, dirname, join, parse, relative, sep } from "node:path";
import { readInstalledPlugins } from "../plugins/installedPlugins.js";
import { canonicalPath } from "../workspace/canonical-key.js";
import type { ToolContext } from "./context.js";

export type PathDecision = "allow" | "ask" | "deny";

export type PathOperation = "read" | "write";

export interface PathClassification {
  decision: PathDecision;
  /**
   * Short, user-facing rationale. Suitable for the approval prompt or for
   * the deny error message. Examples: "outside workspace",
   * "sensitive: ~/.ssh", "ok".
   */
  reason: string;
  /** Resolved absolute path (with symlinks followed when possible). */
  resolvedPath: string;
  /** Canonical workspace root containing resolvedPath, when one matched. */
  matchedRoot?: string;
  /**
   * Set for a protected-path write: the protected item (`<root>/.git/`, or
   * `<dir>/.env/` for a single file) as a prefix ending in `sep`. Remembered
   * approvals cover exactly this item.
   */
  protectedScope?: string;
}

export interface ClassifyOptions {
  /** Absolute path of the active workspace (Engine.cwd). */
  workspaceRoot: string;
  /** Complete authorized root set. Omitted preserves legacy single-root behavior. */
  workspaceRoots?: readonly string[];
  /** "read" or "write" — different defaults for sensitive paths. */
  operation: PathOperation;
}

export interface FinalWritePathSnapshot {
  resolvedPath: string;
  workspacePath: string;
  insideWorkspace: boolean;
  matchedRoot?: string;
  rootsDigest?: string;
}

const FINAL_WRITE_PATH_SNAPSHOT = Symbol("codeshell.finalWritePathSnapshot");

/**
 * Home-relative credential/config directories whose writes are protected.
 * These are evaluated AFTER home-expansion and resolution, so a literal
 * "$HOME/.ssh" and a symlink at /tmp/x → ~/.ssh are both caught.
 */
const SENSITIVE_DIR_PATTERNS = [
  ".ssh",
  ".aws",
  ".config/gcloud",
  ".code-shell",
  ".claude",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gh",
  "Library/Keychains",
] as const;

/**
 * Files that are sensitive regardless of where they live: an `.env` next to
 * the code, an `id_rsa` in a random folder, etc.
 */
// Data/config extensions a credential FILE typically carries. Deliberately
// excludes source-code extensions (.ts/.tsx/.js/.py/.go/.rs/…) so a code file
// whose NAME happens to contain a secret-y word is never treated as a secret.
const SECRET_DATA_EXT = String.raw`(json|ya?ml|txt|ini|conf|cfg|toml|xml|properties|env|key|secret)`;

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production, …
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  // Credential/secret ARTIFACT files: the secret word is the dominant stem AND
  // the file carries a data/config extension (or none). This still catches
  // credentials.json / secrets.yaml / auth.json / token.txt / api-secret.conf,
  // but NOT source files like authController.ts, token-counter.ts,
  // oauth-handler.ts whose code extension excludes them.
  //
  // Was previously bare substrings (/auth/i, /token/i, …) tested against the
  // basename, which denied WRITES to any code file containing those words —
  // breaking the agent's ability to edit ordinary auth/token source. See
  // path-policy-sensitive-file.test.ts.
  new RegExp(
    String.raw`^[^/]*\b(secrets?|credentials?|auth|token|apikey|api[-_]?key)\b[^/]*\.${SECRET_DATA_EXT}$`,
    "i",
  ),
  // Bare (extensionless) credential files: `secret`, `credentials`, `token`.
  /^(secrets?|credentials?|token)$/i,
  // Well-known credential files matched by EXACT name (anchored both ends, so
  // npmrc-helper.ts / git-credentials.md stay writable). These carry no
  // secret-y stem and aren't .env/.pem, so the patterns above miss them, yet
  // they routinely hold auth tokens / passwords:
  //   .git-credentials (git creds), .npmrc (_authToken), .netrc (login creds),
  //   .pgpass (postgres passwords).
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
] as const;

/**
 * Directory names that are protected wherever they appear below the
 * workspace root (or anywhere in an outside path): writing into them can run
 * code later (git hooks, IDE/devcontainer tasks, build config) or rewrite an
 * agent's own permissions. Union of Codex's read-only workspace paths and
 * Claude Code's protected paths, plus CodeShell's own config dir. A `.git`
 * worktree pointer FILE is matched by the same name.
 */
const PROTECTED_DIR_NAMES = new Set([
  ".git",
  ".husky",
  ".code-shell",
  ".claude",
  ".codex",
  ".agents",
  ".vscode",
  ".idea",
  ".devcontainer",
  ".cargo",
  ".mvn",
]);

/** Exact basenames protected anywhere: git/agent/package config, shell rc files. */
const PROTECTED_FILE_NAMES = new Set([
  ".gitmodules",
  ".gitconfig",
  ".mcp.json",
  ".claude.json",
  ".yarnrc",
  ".yarnrc.yml",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".profile",
]);

const ENV_DISABLE = "CODESHELL_PATH_POLICY";
let warnedDisabled = false;

function policyDisabled(): boolean {
  const v = process.env[ENV_DISABLE];
  return v === "off" || v === "0" || v === "false";
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~" + sep)) {
    return homedir() + p.slice(1);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Remembered path approvals (so a project-external dir isn't re-prompted on
// every file op). Two scopes mirror the tool-permission card's session/project:
//   - session: in-memory, keyed by sessionId → set of approved directory
//     prefixes. Cleared when the process ends.
//   - project: persisted to <cwd>/.code-shell/settings.local.json under
//     `pathApprovals` (per-developer, git-ignored), so it survives restarts.
// A grant covers the directory of the approved path and everything beneath it,
// so writing 5 files in one dir prompts once. A protected-path grant instead
// covers only the protected item (`<root>/.git/`, or the single `.env` file),
// and only protected grants satisfy a protected-path ask — so approving `.env`
// at the repo root never authorizes `.git/hooks` beneath the same directory.
// ---------------------------------------------------------------------------

export type PathApprovalScope = "once" | "session" | "project";

/**
 * A remembered grant carries the OPERATION it was granted for. A `read` grant
 * covers only reads; a `write` grant covers reads AND writes (if you may write
 * a file you may certainly read it). This is the fix for "approving a read of a
 * folder silently let the agent write to it too" — grants used to be bare
 * directory prefixes compared without regard to operation.
 */
interface PathGrant {
  /** Absolute directory prefix ending in `sep`. */
  prefix: string;
  op: PathOperation;
  /** Granted from a protected-path ask; `prefix` is the protected item. */
  protected?: boolean;
}

/** sessionId → set of approved directory grants (prefix + operation). */
const sessionPathGrants = new Map<string, Set<PathGrant>>();

/** Session ids explicitly closed by ChatSessionManager; late approvals must not recreate grants. */
const closedPathApprovalSessions = new Set<string>();

/** Per-session prompt chains for enforcePathPolicyWithApproval (see comment there). */
const askChains = new Map<string, Promise<void>>();

/** True if a grant for `grantOp` authorizes an operation of `wantOp`. */
function grantCoversOp(grantOp: PathOperation, wantOp: PathOperation): boolean {
  // write ⊇ {read, write}; read ⊇ {read}.
  return grantOp === "write" || grantOp === wantOp;
}

/**
 * Normalize a path for comparison. Windows file systems are case-INsensitive,
 * so `C:\Users\Admin\.ssh` and `c:\users\admin\.ssh` are the same path — a
 * case-sensitive `startsWith` would let a sensitive-path or workspace-boundary
 * check be bypassed by varying case (or just fail to match a legit prefix).
 * Lowercase on win32 only; POSIX stays exact (macOS APFS can be case-sensitive,
 * and the existing contract is case-sensitive there).
 */
function normPath(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** Normalize a directory to an absolute prefix ending in `sep` for prefix tests. */
function dirPrefix(absPath: string): string {
  const d = absPath.endsWith(sep) ? absPath : absPath + sep;
  return d;
}

/**
 * True if `resolved` sits inside any grant whose prefix covers it AND whose
 * operation authorizes `operation` (write grants cover reads; read grants do
 * not cover writes).
 */
function coveredBy(
  grants: Iterable<PathGrant>,
  resolved: string,
  operation: PathOperation,
  protectedOnly: boolean,
): boolean {
  const target = normPath(resolved.endsWith(sep) ? resolved : resolved + sep);
  for (const g of grants) {
    if (!grantCoversOp(g.op, operation)) continue;
    if (protectedOnly && !g.protected) continue;
    const gn = normPath(g.prefix);
    if (target === gn || target.startsWith(gn)) return true;
  }
  return false;
}

/**
 * Read persisted project grants. Two on-disk shapes are accepted:
 *   - legacy bare string  "/dir/"            → interpreted as a READ-only grant
 *     (conservative: pre-fix entries were written without an operation, and we
 *     must not retroactively treat them as write authority).
 *   - object  { path: "/dir/", op: "write" } → operation as stored.
 */
function projectPathGrants(cwd: string): PathGrant[] {
  const file = join(cwd, ".code-shell", "settings.local.json");
  if (!existsSync(file)) return [];
  try {
    const s = JSON.parse(readFileSync(file, "utf-8")) as {
      pathApprovals?: unknown;
    };
    if (!Array.isArray(s.pathApprovals)) return [];
    const out: PathGrant[] = [];
    for (const entry of s.pathApprovals) {
      if (typeof entry === "string") {
        out.push({ prefix: entry, op: "read" });
      } else if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { path?: unknown }).path === "string"
      ) {
        const op = (entry as { op?: unknown }).op === "write" ? "write" : "read";
        const isProtected = (entry as { protected?: unknown }).protected === true;
        out.push({ prefix: (entry as { path: string }).path, op, protected: isProtected });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Has the user already approved `operation` on a grant covering this ask? */
function isPathPreApproved(
  c: PathClassification,
  operation: PathOperation,
  cwd: string,
  sessionId?: string,
): boolean {
  const protectedOnly = c.protectedScope !== undefined;
  if (sessionId) {
    const s = sessionPathGrants.get(sessionId);
    if (s && coveredBy(s, c.resolvedPath, operation, protectedOnly)) return true;
  }
  return coveredBy(projectPathGrants(cwd), c.resolvedPath, operation, protectedOnly);
}

/** A persisted project grant: object form carries the operation. */
type StoredGrant = string | { path: string; op: PathOperation; protected?: boolean };

function storedPrefix(g: StoredGrant): string {
  return typeof g === "string" ? g : g.path;
}
function storedOp(g: StoredGrant): PathOperation {
  return typeof g === "string" ? "read" : g.op;
}
function storedProtected(g: StoredGrant): boolean {
  return typeof g === "object" && g.protected === true;
}

/** The prefix a remembered approval of this ask covers. */
function grantPrefixFor(c: PathClassification): string {
  return c.protectedScope ?? dirPrefix(dirname(c.resolvedPath));
}

/**
 * Record a session/project grant for the DIRECTORY containing the path (or
 * the protected item, for a protected-path ask), tagged with the OPERATION
 * the user approved. A write grant subsumes read, so granting write where a
 * read grant already exists upgrades it.
 */
function recordPathApproval(
  scope: PathApprovalScope,
  c: PathClassification,
  operation: PathOperation,
  cwd: string,
  sessionId?: string,
): void {
  if (scope === "once") return;
  if (sessionId && closedPathApprovalSessions.has(sessionId)) return;
  const prefix = grantPrefixFor(c);
  const isProtected = c.protectedScope !== undefined;
  if (scope === "session") {
    if (!sessionId) return;
    let s = sessionPathGrants.get(sessionId);
    if (!s) {
      s = new Set();
      sessionPathGrants.set(sessionId, s);
    }
    // Drop a weaker (read) grant for the same prefix when upgrading to write,
    // and skip adding a redundant read when a write grant already covers it.
    for (const g of s) {
      if (g.prefix !== prefix || Boolean(g.protected) !== isProtected) continue;
      if (grantCoversOp(g.op, operation)) return; // already covered
      if (operation === "write" && g.op === "read") s.delete(g); // upgrade
    }
    s.add(isProtected ? { prefix, op: operation, protected: true } : { prefix, op: operation });
    return;
  }
  // Use the same cross-process lock and strict YAML-aware read as Settings.
  try {
    if (!existsSync(cwd)) return;
    new SettingsManager(cwd).mutateSettingsForScope("local", cwd, (current) => {
      const settings = current as { pathApprovals?: StoredGrant[] };
      if (!Array.isArray(settings.pathApprovals)) settings.pathApprovals = [];
      const matches = (g: StoredGrant) =>
        storedPrefix(g) === prefix && storedProtected(g) === isProtected;
      const entry: StoredGrant = isProtected
        ? { path: prefix, op: operation, protected: true }
        : { path: prefix, op: operation };
      const existing = settings.pathApprovals.find(matches);
      if (existing) {
        if (grantCoversOp(storedOp(existing), operation)) return false;
        if (operation !== "write") return false;
        settings.pathApprovals = settings.pathApprovals.map((g) => (matches(g) ? entry : g));
      } else {
        settings.pathApprovals.push(entry);
      }
    });
  } catch {
    // The current authorization remains valid; preserve malformed/unwritable config.
  }
}

/** Test seam: clear the in-memory session grants. */
export function _resetSessionPathGrants(): void {
  sessionPathGrants.clear();
  closedPathApprovalSessions.clear();
  askChains.clear();
}

export function openSessionPathApprovals(sessionId: string): void {
  closedPathApprovalSessions.delete(sessionId);
}

export function clearSessionPathApprovals(sessionId: string): void {
  sessionPathGrants.delete(sessionId);
  closedPathApprovalSessions.add(sessionId);
  askChains.delete(sessionId);
}

/** Revoke only grants that point into a root removed from a live project. */
export function clearSessionPathApprovalsUnderRoot(sessionId: string, root: string): void {
  const grants = sessionPathGrants.get(sessionId);
  if (!grants) return;
  const canonicalRoot = safeRealpath(root);
  for (const grant of [...grants]) {
    const grantPath = safeRealpath(grant.prefix);
    if (isInsideDir(grantPath, canonicalRoot)) grants.delete(grant);
  }
  if (grants.size === 0) sessionPathGrants.delete(sessionId);
}

/**
 * Best-effort resolution. realpath fails when the path doesn't exist yet —
 * the common case for Write creating a new file. We walk up to the nearest
 * existing ancestor, realpath *that*, then re-append the remaining segments.
 *
 * Why this matters: on macOS, /var is a symlink to /private/var, so a
 * tmpdir() workspace at /var/folders/... realpaths to /private/var/folders/...
 * If we naively `resolve()` a non-existing child of the workspace, its
 * prefix won't match the realpathed workspace and an in-workspace write
 * would be misclassified as outside-workspace.
 */
function safeRealpath(p: string): string {
  return canonicalPath(p);
}

/**
 * Capture the concrete target approved by the executor's first path-policy
 * pass. The snapshot is carried on the internal args object via a symbol, so
 * it cannot collide with an LLM-supplied schema property or leak into logs.
 */
export function attachFinalWritePathSnapshot(
  args: Record<string, unknown>,
  filePath: string,
  workspaceRoot: string,
  workspaceRoots?: readonly string[],
  rootsDigest?: string,
): Record<string, unknown> {
  const resolvedPath = safeRealpath(filePath);
  const workspacePath = safeRealpath(workspaceRoot);
  const roots = (workspaceRoots?.length ? workspaceRoots : [workspaceRoot]).map(safeRealpath);
  const matchedRoot = roots.find((root) => isInsideDir(resolvedPath, root));
  const snapshot: FinalWritePathSnapshot = {
    resolvedPath,
    workspacePath,
    insideWorkspace: matchedRoot !== undefined,
    matchedRoot,
    rootsDigest,
  };
  return { ...args, [FINAL_WRITE_PATH_SNAPSHOT]: snapshot };
}

export function getFinalWritePathSnapshot(
  args: Record<string, unknown>,
  filePath: string,
  workspaceRoot: string,
  workspaceRoots?: readonly string[],
  rootsDigest?: string,
): FinalWritePathSnapshot {
  const carried = (args as Record<string, unknown> & { [FINAL_WRITE_PATH_SNAPSHOT]?: unknown })[
    FINAL_WRITE_PATH_SNAPSHOT
  ];
  if (carried && typeof carried === "object") {
    return carried as FinalWritePathSnapshot;
  }
  // Direct tool calls do not pass through ToolExecutor. Preserve that API by
  // taking the baseline at handler entry, while still protecting Edit's
  // read-to-write interval with a second check before its writeFile.
  const resolvedPath = safeRealpath(filePath);
  const workspacePath = safeRealpath(workspaceRoot);
  const roots = (workspaceRoots?.length ? workspaceRoots : [workspaceRoot]).map(safeRealpath);
  const matchedRoot = roots.find((root) => isInsideDir(resolvedPath, root));
  return {
    resolvedPath,
    workspacePath,
    insideWorkspace: matchedRoot !== undefined,
    matchedRoot,
    rootsDigest,
  };
}

export function revalidateFinalWritePath(
  filePath: string,
  workspaceRoot: string,
  approved: FinalWritePathSnapshot,
  workspaceRoots?: readonly string[],
  rootsDigest?: string,
): { resolvedPath: string } | { error: string } {
  const currentPath = safeRealpath(filePath);
  const currentWorkspace = safeRealpath(workspaceRoot);
  const sameTarget = normPath(currentPath) === normPath(approved.resolvedPath);
  const sameWorkspace = normPath(currentWorkspace) === normPath(approved.workspacePath);
  const currentRoots = (workspaceRoots?.length ? workspaceRoots : [workspaceRoot]).map(
    safeRealpath,
  );
  const currentMatchedRoot = currentRoots.find((root) => isInsideDir(currentPath, root));
  const crossedWorkspaceBoundary = approved.insideWorkspace && currentMatchedRoot === undefined;
  const changedMatchedRoot =
    approved.matchedRoot !== undefined &&
    normPath(currentMatchedRoot ?? "") !== normPath(approved.matchedRoot);
  const changedRootsDigest =
    approved.rootsDigest !== undefined && rootsDigest !== approved.rootsDigest;

  if (
    crossedWorkspaceBoundary ||
    changedMatchedRoot ||
    changedRootsDigest ||
    !sameTarget ||
    !sameWorkspace
  ) {
    const reason = crossedWorkspaceBoundary
      ? "final write path resolved outside the workspace after approval"
      : "final write path changed after approval";
    return {
      error:
        `Error: ${reason}; refusing to write. ` +
        `Approved target: ${approved.resolvedPath}. Current target: ${currentPath}`,
    };
  }

  return { resolvedPath: currentPath };
}

/** Open the already-revalidated final path without following its last segment. */
export async function writeFileNoFollow(filePath: string, content: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const handle = await open(filePath, flags, 0o666);
  try {
    await handle.writeFile(content, "utf-8");
  } finally {
    await handle.close();
  }
}

function isInsideDir(child: string, parent: string): boolean {
  const c = normPath(child);
  const par = normPath(parent);
  const p = par.endsWith(sep) ? par : par + sep;
  return c === par || c.startsWith(p);
}

function configuredUserHome(): string {
  return process.env.HOME ?? homedir();
}

/**
 * Whether `resolved` belongs to one concrete Skill tree rooted below
 * `<skillsRoot>/<skill>/`.
 *
 * Both the root and manifest are realpathed, so a reference symlink cannot
 * turn this read-only exception into access outside the managed Skill tree.
 */
function isSkillTreeResource(resolved: string, skillsRoot: string): boolean {
  try {
    const realSkillsRoot = realpathSync(skillsRoot);
    if (!isInsideDir(resolved, realSkillsRoot)) return false;
    const rel = relative(realSkillsRoot, resolved);
    const skillName = rel.split(sep).filter(Boolean)[0];
    if (!skillName || skillName === "..") return false;

    const skillRoot = realpathSync(join(realSkillsRoot, skillName));
    if (!isInsideDir(skillRoot, realSkillsRoot)) return false;
    const manifest = realpathSync(join(skillRoot, "SKILL.md"));
    if (!isInsideDir(manifest, skillRoot) || !statSync(manifest).isFile()) return false;
    return isInsideDir(resolved, skillRoot);
  } catch {
    return false;
  }
}

function registeredPluginSkillBases(codeShellRoot: string): string[] {
  let cacheRoot: string;
  try {
    cacheRoot = realpathSync(join(codeShellRoot, "plugins", "cache"));
  } catch {
    return [];
  }

  const bases: string[] = [];
  const installed = readInstalledPlugins();
  for (const entries of Object.values(installed.plugins)) {
    for (const entry of entries) {
      try {
        const installRoot = realpathSync(entry.installPath);
        if (installRoot === cacheRoot || !isInsideDir(installRoot, cacheRoot)) continue;
        const skillsRoot = realpathSync(join(installRoot, "skills"));
        if (!isInsideDir(skillsRoot, installRoot)) continue;
        if (isInsideDir(skillsRoot, codeShellRoot)) bases.push(skillsRoot);
      } catch {
        // A stale/tampered registry entry must never broaden read authority.
      }
    }
  }
  return bases;
}

/** Enumerate the same managed Skill trees accepted by the file-read policy. */
export function registeredSkillResourceRoots(): string[] {
  let homeRoot: string;
  try {
    homeRoot = realpathSync(join(configuredUserHome(), ".code-shell"));
  } catch {
    return [];
  }
  const bases = [join(homeRoot, "skills"), ...registeredPluginSkillBases(homeRoot)];
  const roots = new Set<string>();
  for (const base of bases) {
    try {
      for (const name of readdirSync(base)) {
        try {
          const root = realpathSync(join(base, name));
          if (isInsideDir(root, homeRoot) && isSkillTreeResource(root, base)) roots.add(root);
        } catch {
          // One dangling link must not hide the remaining installed Skills.
        }
      }
    } catch {
      // Missing or inaccessible installs never grant sandbox access.
    }
  }
  return [...roots];
}

/**
 * Returns the protected item a write to `resolved` lands in, if any: a label
 * for the prompt and the item's prefix (ending in `sep`) for remembered
 * approvals.
 *
 * Inside a workspace only the part below the root is examined, so a workspace
 * opened inside a protected directory (a Codex worktree under ~/.codex, the
 * no-repo workspace under ~/.code-shell) owns its ordinary files.
 */
function matchProtectedPath(
  resolved: string,
  root: string | undefined,
): { label: string; scope: string } | undefined {
  const home = configuredUserHome();
  for (const rel of SENSITIVE_DIR_PATTERNS) {
    const full = safeRealpath(join(home, rel));
    if (isInsideDir(resolved, full) && !(root && isInsideDir(root, full))) {
      return { label: "~/" + rel, scope: dirPrefix(full) };
    }
  }

  const start = root ?? parse(resolved).root;
  const parts = relative(start, resolved).split(sep).filter(Boolean);
  let prefix = start;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    prefix = join(prefix, name);
    // Claude Code keeps its own worktrees here; they are ordinary checkouts.
    if (name === ".claude" && parts[i + 1] === "worktrees") {
      prefix = join(prefix, parts[++i]!);
      continue;
    }
    if (PROTECTED_DIR_NAMES.has(name)) return { label: name, scope: dirPrefix(prefix) };
  }

  const base = basename(resolved);
  if (PROTECTED_FILE_NAMES.has(base) || matchSensitiveFile(resolved)) {
    return { label: base, scope: dirPrefix(resolved) };
  }
  return undefined;
}

/**
 * Returns the matching pattern label if the basename matches a sensitive
 * file rule, else undefined.
 */
function matchSensitiveFile(resolved: string): string | undefined {
  const base = resolved.slice(resolved.lastIndexOf(sep) + 1);
  // Atomic credential writes use <name>.<pid>.<uuid>.tmp. Backups and
  // temporary copies retain the original file's confidentiality.
  const original = base.replace(/\.(?:bak|backup|old|(?:\d+\.[A-Za-z0-9_-]+\.)?tmp)$/i, "");
  for (const re of SENSITIVE_FILE_PATTERNS) {
    if (re.test(base) || re.test(original)) return base;
  }
  return undefined;
}

/** Shared with sandbox resource enumeration; keep credential filtering identical. */
export function isSensitiveResourcePath(path: string): boolean {
  return matchSensitiveFile(path) !== undefined;
}

/**
 * Classify a file path against the workspace + protected-path policy.
 *
 * Decision matrix (aligned with Codex / Claude Code):
 *
 *                                  read      write
 *   inside workspace, ordinary     allow     allow
 *   inside workspace, protected    allow     ask
 *   outside workspace              allow     ask
 *
 * Reads are never gated: like Codex's sandbox and Claude Code's defaults,
 * there is no built-in read deny list. Protected paths (credentials, .git,
 * agent/IDE config, shell rc files) win over workspace placement for writes,
 * since writing them can run code later or widen an agent's own permissions.
 */
export function classifyPath(rawPath: string, opts: ClassifyOptions): PathClassification {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { decision: "deny", reason: "empty path", resolvedPath: "" };
  }

  if (policyDisabled()) {
    if (!warnedDisabled) {
      // One-shot stderr nudge so an operator who flipped the flag sees it
      // surfaced. We deliberately don't import the logger here to keep this
      // module dependency-light — sanitize-messages can find this entry
      // separately when callers log their PathPolicy decisions.
      // eslint-disable-next-line no-console
      console.warn(
        `[path-policy] CODESHELL_PATH_POLICY=${process.env[ENV_DISABLE]} — file path enforcement is OFF`,
      );
      warnedDisabled = true;
    }
    return { decision: "allow", reason: "policy disabled", resolvedPath: rawPath };
  }

  const expanded = expandTilde(rawPath);
  const resolved = safeRealpath(expanded);
  const workspaceRoots = opts.workspaceRoots?.length ? opts.workspaceRoots : [opts.workspaceRoot];
  const workspaces = workspaceRoots.map((root) => safeRealpath(root));
  const matchedRoot = workspaces.find((workspace) => isInsideDir(resolved, workspace));

  if (opts.operation === "read") {
    return matchedRoot
      ? { decision: "allow", reason: "inside workspace", resolvedPath: resolved, matchedRoot }
      : { decision: "allow", reason: "outside workspace read", resolvedPath: resolved };
  }

  const protectedPath = matchProtectedPath(resolved, matchedRoot);
  if (protectedPath) {
    return {
      decision: "ask",
      reason: `protected path (${protectedPath.label}): write requires approval`,
      resolvedPath: resolved,
      protectedScope: protectedPath.scope,
      ...(matchedRoot ? { matchedRoot } : {}),
    };
  }

  if (matchedRoot) {
    return {
      decision: "allow",
      reason: "inside workspace",
      resolvedPath: resolved,
      matchedRoot,
    };
  }

  return {
    decision: "ask",
    reason: "outside workspace: caller approval required",
    resolvedPath: resolved,
  };
}

/**
 * Convenience wrapper for the file-tool integration. Pass the ToolContext's
 * cwd (or undefined for non-LLM call sites), the target path, and the
 * operation; returns either null (proceed) or an error string (refuse).
 *
 * Semantics:
 *   - decision="allow" → returns null.
 *   - decision="deny"  → returns a "blocked by path policy" message.
 *   - decision="ask"   → MVP: without a hooked-up askUser path here, we
 *                        translate ask → refuse with an explanatory error
 *                        so the LLM sees the refusal and can choose a
 *                        different path. This is the conservative choice
 *                        the plan calls out for the MVP rollout.
 *
 * `workspaceRoot === undefined` is the explicit signal that the caller is
 * NOT an LLM-driven tool invocation (the ToolRegistry always threads ctx
 * through, ctx always carries cwd). Standalone tests, scripts importing
 * a tool function directly, and a few legacy CLI paths can be in this
 * shape — we bypass policy for them rather than pretending process.cwd()
 * is a meaningful workspace. The CODESHELL_PATH_POLICY=off env switch
 * remains the rollback knob for the LLM-driven path.
 */
export function enforcePathPolicy(
  filePath: string,
  operation: PathOperation,
  workspaceRoot?: string,
): string | null {
  if (workspaceRoot === undefined) return null;
  const c = classifyPath(filePath, { workspaceRoot, operation });
  if (c.decision === "allow") return null;
  if (c.decision === "deny") {
    return `Error: blocked by path policy — ${c.reason}. Path: ${c.resolvedPath}`;
  }
  // ask — MVP refuses with explanatory message until askUser plumbing
  // lands. The conservative bias matches the plan's leaning answer for Q1.
  return (
    `Error: path requires approval — ${c.reason}. Path: ${c.resolvedPath}. ` +
    `Set CODESHELL_PATH_POLICY=off to disable enforcement during a rollback.`
  );
}

export async function enforcePathPolicyWithApproval(
  filePath: string,
  operation: PathOperation,
  ctx?: ToolContext,
): Promise<string | null> {
  if (ctx?.signal?.aborted) return "Error: path approval cancelled — run stopped";
  if (ctx?.cwd === undefined) return null;
  // Full access skips path approval. External tool hosts bind pathAccess
  // separately so their classifier can still honor explicit tool deny rules.
  if (ctx.permissionMode === "bypassPermissions" || ctx.pathAccess === "full") return null;

  const c = classifyPath(filePath, {
    workspaceRoot: ctx.cwd,
    workspaceRoots: ctx.workspace?.roots.map((root) => root.path),
    operation,
  });
  if (c.decision === "allow") return null;
  if (c.decision === "deny") {
    return `Error: blocked by path policy — ${c.reason}. Path: ${c.resolvedPath}`;
  }
  if (operation === "write" && ctx.planMode) {
    return (
      `Error: blocked by path policy — ${c.reason}. Path: ${c.resolvedPath}. ` +
      `Plan mode does not allow file writes.`
    );
  }
  // Already approved this directory for this OPERATION (this session or
  // persisted for the project)? Proceed without re-prompting — this is the fix
  // for "I keep having to click allow for the same folder". A read grant does
  // NOT cover a write; a write grant covers both. Protected paths need a
  // grant made for that protected item.
  if (isPathPreApproved(c, operation, ctx.cwd, ctx.sessionId)) return null;
  if (!ctx.askUser) {
    return (
      `Error: path requires approval — ${c.reason}. Path: ${c.resolvedPath}. ` +
      `No interactive approval UI is available in this run.`
    );
  }

  // Serialize concurrent asks (per session) and RE-CHECK grants when our turn
  // comes. Parallel tools hitting the same not-yet-approved directory all pass
  // the pre-approved check above before the first grant lands, so each used to
  // queue its own card — the user got a burst of identical 路径权限 prompts.
  // Now the first "本目录允许" answer silently absorbs the queued rest.
  const chainKey = ctx.sessionId ?? "__global__";
  const prevTurn = askChains.get(chainKey) ?? Promise.resolve();
  let release!: () => void;
  const currentTurn = new Promise<void>((r) => (release = r));
  askChains.set(chainKey, currentTurn);
  try {
    await prevTurn;
    // Stop drains the visible prompt; queued paths must not create another one.
    if (ctx.signal?.aborted) return "Error: path approval cancelled — run stopped";
    if (isPathPreApproved(c, operation, ctx.cwd, ctx.sessionId)) return null;
    return await promptForPathApproval(
      c,
      operation,
      ctx as ToolContext & { askUser: NonNullable<ToolContext["askUser"]> },
    );
  } finally {
    release();
    if (askChains.get(chainKey) === currentTurn) {
      askChains.delete(chainKey);
    }
  }
}

/** The actual interactive ask — split out so the serialized section reads flat.
 *  Caller has already verified ctx.askUser and ctx.cwd are present. */
async function promptForPathApproval(
  c: PathClassification,
  operation: PathOperation,
  ctx: ToolContext & { askUser: NonNullable<ToolContext["askUser"]> },
): Promise<string | null> {
  // Title by the ACTUAL reason, not always "工作区外": a protected path
  // (e.g. .git/hooks, .env) can sit INSIDE the workspace.
  const isProtected = c.protectedScope !== undefined;
  const what = operation === "read" ? "读取" : "写入";
  const title = isProtected ? `工具想${what}受保护路径` : `工具想${what}工作区外路径`;
  const header = isProtected ? "受保护路径" : "路径权限";

  // Scope options carry remembered grants for the directory of this path (or
  // the protected item itself), so it isn't re-prompted. Labels are matched by
  // exact string (the ask is optionsOnly — no free-text box that could
  // silently fail to match). 仅本次 carries no memory.
  const grantPrefix = grantPrefixFor(c);
  const grantTarget = grantPrefix.slice(0, -sep.length);
  const grantSubject =
    grantPrefix === dirPrefix(c.resolvedPath) ? grantTarget : `${grantTarget} 下的文件`;
  const ALLOW_ONCE = "允许本次";
  const ALLOW_SESSION = "本目录本会话允许";
  const ALLOW_PROJECT = "本目录本项目允许";
  const answer = (
    await ctx.askUser(`${title}：\n${c.resolvedPath}\n\n原因：${c.reason}\n是否允许本次操作？`, {
      header,
      options: [
        { label: ALLOW_ONCE, description: "仅允许当前这一次文件操作继续执行", tone: "ok" },
        {
          label: ALLOW_SESSION,
          description: `本会话内不再询问 ${grantSubject}`,
          tone: "ok",
        },
        {
          label: ALLOW_PROJECT,
          description: `永久允许 ${grantSubject}（写入 .code-shell/settings.local.json）`,
          tone: "ok",
        },
        { label: "拒绝", description: "阻止当前文件操作", tone: "danger" },
      ],
      // Closed-set decision: no free-text "其它…" box. The answer is matched
      // against the labels below by exact string, so a typed answer must not
      // be allowed (it could never match and would silently deny).
      optionsOnly: true,
    })
  ).trim();

  // A late answer must not grant access or persist permission after Stop.
  if (ctx.signal?.aborted) return "Error: path approval cancelled — run stopped";
  if (answer === ALLOW_ONCE) return null;
  if (answer === ALLOW_SESSION) {
    recordPathApproval("session", c, operation, ctx.cwd!, ctx.sessionId);
    return null;
  }
  if (answer === ALLOW_PROJECT) {
    recordPathApproval("project", c, operation, ctx.cwd!, ctx.sessionId);
    return null;
  }
  return (
    `Error: path approval denied — ${c.reason}. Path: ${c.resolvedPath}` +
    (answer && answer !== "拒绝" ? ` Approval response: ${answer}` : "")
  );
}

/**
 * Internal: reset the "disabled warning" latch. Tests flip the env var
 * between cases and need each one to be able to re-trigger the warning.
 * Not exported on the public surface beyond test usage.
 */
export function __resetPathPolicyWarnLatchForTests(): void {
  warnedDisabled = false;
}
