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
 * Decision shape:
 *   "allow"  — proceed without prompting (in-workspace and not sensitive)
 *   "ask"    — caller must obtain user approval (outside workspace, OR
 *              sensitive-path read)
 *   "deny"   — refuse outright (sensitive-path write)
 *
 * The classifier is pure: it resolves symlinks (best effort), checks against
 * an explicit sensitive list, then compares against the workspace root. It
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

import {
  realpathSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
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
}

export interface ClassifyOptions {
  /** Absolute path of the active workspace (Engine.cwd). */
  workspaceRoot: string;
  /** "read" or "write" — different defaults for sensitive paths. */
  operation: PathOperation;
}

/**
 * Default sensitive path patterns. These are evaluated AFTER home-expansion
 * and resolution, so a literal "$HOME/.ssh" and a symlink at /tmp/x → ~/.ssh
 * are both caught.
 *
 * Mirrors the existing list in sandbox/index.ts so Bash and file tools agree
 * on what "sensitive" means — keep them in sync when adding entries.
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
// so reading 5 files in one dir prompts once.
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
): boolean {
  const target = normPath(resolved.endsWith(sep) ? resolved : resolved + sep);
  for (const g of grants) {
    if (!grantCoversOp(g.op, operation)) continue;
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
        out.push({ prefix: (entry as { path: string }).path, op });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Has the user already approved `operation` on a directory covering `resolved`? */
function isPathPreApproved(
  resolved: string,
  operation: PathOperation,
  cwd: string,
  sessionId?: string,
): boolean {
  if (sessionId) {
    const s = sessionPathGrants.get(sessionId);
    if (s && coveredBy(s, resolved, operation)) return true;
  }
  return coveredBy(projectPathGrants(cwd), resolved, operation);
}

/** A persisted project grant: object form carries the operation. */
type StoredGrant = string | { path: string; op: PathOperation };

function storedPrefix(g: StoredGrant): string {
  return typeof g === "string" ? g : g.path;
}
function storedOp(g: StoredGrant): PathOperation {
  return typeof g === "string" ? "read" : g.op;
}

/**
 * Record a session/project grant for the DIRECTORY containing `resolved`,
 * tagged with the OPERATION the user approved. A write grant subsumes read,
 * so granting write where a read grant already exists upgrades it.
 */
function recordPathApproval(
  scope: PathApprovalScope,
  resolved: string,
  operation: PathOperation,
  cwd: string,
  sessionId?: string,
): void {
  if (scope === "once") return;
  if (sessionId && closedPathApprovalSessions.has(sessionId)) return;
  const prefix = dirPrefix(dirname(resolved));
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
      if (g.prefix !== prefix) continue;
      if (grantCoversOp(g.op, operation)) return; // already covered
      if (operation === "write" && g.op === "read") s.delete(g); // upgrade
    }
    s.add({ prefix, op: operation });
    return;
  }
  // project: persist to settings.local.json (atomic, idempotent).
  const dir = join(cwd, ".code-shell");
  const file = join(dir, "settings.local.json");
  try {
    // Don't resurrect a deleted project root: a recursive mkdir of
    // <cwd>/.code-shell recreates `cwd` itself as an empty shell when cwd is
    // gone. Persistence here is best-effort, so skip when the root is missing.
    if (!existsSync(cwd)) return;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let settings: { pathApprovals?: StoredGrant[] } = {};
    if (existsSync(file)) {
      try {
        settings = JSON.parse(readFileSync(file, "utf-8"));
      } catch {
        /* start fresh on parse error */
      }
    }
    if (!Array.isArray(settings.pathApprovals)) settings.pathApprovals = [];
    const existing = settings.pathApprovals.find((g) => storedPrefix(g) === prefix);
    if (existing) {
      // Already covered (read-or-better matching the request)? Nothing to do.
      if (grantCoversOp(storedOp(existing), operation)) return;
      // Upgrade read → write in place.
      if (operation === "write") {
        settings.pathApprovals = settings.pathApprovals.map((g) =>
          storedPrefix(g) === prefix ? { path: prefix, op: "write" as const } : g,
        );
      } else {
        return;
      }
    } else {
      settings.pathApprovals.push({ path: prefix, op: operation });
    }
    // randomUUID() guards against temp-name collisions between writers in
    // the same millisecond; the rename keeps the swap atomic.
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    renameSync(tmp, file);
  } catch {
    // Persistence is best-effort; an unwritable disk must not break the op.
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
  const abs = isAbsolute(p) ? p : resolvePath(process.cwd(), p);
  // Walk up to the nearest existing ancestor.
  let candidate = abs;
  const segments: string[] = [];
  // Cap the walk so a pathological input can't spin forever.
  for (let i = 0; i < 64; i++) {
    try {
      const resolved = realpathSync(candidate);
      if (segments.length === 0) return resolved;
      return resolvePath(resolved, ...segments.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) {
        // Reached root without finding anything that exists — return the
        // original absolute form so the caller still has a usable path.
        return abs;
      }
      segments.push(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      candidate = parent;
    }
  }
  return abs;
}

function isInsideDir(child: string, parent: string): boolean {
  const c = normPath(child);
  const par = normPath(parent);
  const p = par.endsWith(sep) ? par : par + sep;
  return c === par || c.startsWith(p);
}

/**
 * Returns the matching sensitive-dir entry (with the user's home prefix) if
 * `resolved` lives underneath any sensitive directory, else undefined.
 */
function matchSensitiveDir(resolved: string): string | undefined {
  const home = homedir();
  for (const rel of SENSITIVE_DIR_PATTERNS) {
    const full = home + sep + rel;
    if (isInsideDir(resolved, full)) return "~/" + rel;
  }
  return undefined;
}

/**
 * Returns the matching pattern label if the basename matches a sensitive
 * file rule, else undefined.
 */
function matchSensitiveFile(resolved: string): string | undefined {
  const base = resolved.slice(resolved.lastIndexOf(sep) + 1);
  for (const re of SENSITIVE_FILE_PATTERNS) {
    if (re.test(base)) return base;
  }
  return undefined;
}

function isSafeCodeShellDiagnosticRead(resolved: string): boolean {
  const home = homedir();
  const root = home + sep + ".code-shell";
  if (!isInsideDir(resolved, root)) return false;

  const rel = resolved.slice(root.length + 1);
  const parts = rel.split(sep).filter(Boolean);
  if (parts[0] === "sessions" && /^s-[A-Za-z0-9_-]+$/.test(parts[1] ?? "")) {
    return parts[2] === "tool-results" || parts[2] === "logs" || parts[2] === "transcript";
  }
  if (parts[0] === "logs") {
    const name = parts[1] ?? "";
    return /^(desktop|tui|agent|main)-.+\.log$/i.test(name);
  }
  return false;
}

function isNoRepoAttachmentRead(resolved: string, operation: PathOperation): boolean {
  if (operation !== "read") return false;
  const root = join(homedir(), ".code-shell", "no-repo", ".code-shell", "attachments");
  return isInsideDir(resolved, root);
}

/**
 * Classify a file path against the workspace + sensitive-path policy.
 *
 * Decision matrix:
 *
 *                                  read      write
 *   inside workspace, not sens.    allow     allow
 *   inside workspace, sensitive    ask       deny
 *   outside workspace, not sens.   ask       ask
 *   outside workspace, sensitive   ask       deny
 *
 * Sensitive wins over workspace placement: a `.env` checked into the project
 * still asks on read and denies on write.
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
  const workspace = safeRealpath(opts.workspaceRoot);

  const sensitiveDir = matchSensitiveDir(resolved);
  const sensitiveFile = matchSensitiveFile(resolved);
  const sensitiveLabel = sensitiveDir ?? sensitiveFile;
  const insideWorkspace = isInsideDir(resolved, workspace);

  // Sensitive: write is always denied, read always asks. Workspace placement
  // doesn't soften the rule — an `.env` in the project still asks on read.
  if (sensitiveLabel) {
    if (isNoRepoAttachmentRead(resolved, opts.operation)) {
      return {
        decision: "allow",
        reason: "no-repo attachment read",
        resolvedPath: resolved,
      };
    }
    if (opts.operation === "read" && isSafeCodeShellDiagnosticRead(resolved)) {
      return {
        decision: "allow",
        reason: "safe CodeShell diagnostic read",
        resolvedPath: resolved,
      };
    }
    if (opts.operation === "write") {
      return {
        decision: "deny",
        reason: `sensitive path (${sensitiveLabel}): writes are not permitted`,
        resolvedPath: resolved,
      };
    }
    return {
      decision: "ask",
      reason: `sensitive path (${sensitiveLabel}): read requires approval`,
      resolvedPath: resolved,
    };
  }

  if (insideWorkspace) {
    return { decision: "allow", reason: "inside workspace", resolvedPath: resolved };
  }

  // Outside workspace: ask for both read and write. The conservative bias
  // matches the plan's leaning answer to Q1 — ask on sensitive reads, deny
  // on silently-allowed writes; outside-workspace falls in between.
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
  if (ctx?.cwd === undefined) return null;
  // bypassPermissions ("完全访问") skips the path-approval layer entirely,
  // matching the tool-permission backend and CC (bypass skips ALL checks,
  // including path validation). This is what makes "完全访问" actually mean
  // full access — previously path policy ran regardless of mode, so a user
  // who chose full access still got prompted for project-external reads.
  if (ctx.permissionMode === "bypassPermissions") return null;

  const c = classifyPath(filePath, { workspaceRoot: ctx.cwd, operation });
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
  // NOT cover a write; a write grant covers both.
  if (isPathPreApproved(c.resolvedPath, operation, ctx.cwd, ctx.sessionId)) return null;
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
    if (isPathPreApproved(c.resolvedPath, operation, ctx.cwd, ctx.sessionId)) return null;
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
  c: { resolvedPath: string; reason: string },
  operation: PathOperation,
  ctx: ToolContext & { askUser: NonNullable<ToolContext["askUser"]> },
): Promise<string | null> {
  // Title by the ACTUAL reason, not always "工作区外": a sensitive file
  // (e.g. ~/.ssh, .env) can sit INSIDE the workspace, so the old fixed
  // "工作区外路径" header was misleading for sensitive-path asks.
  const isSensitive = c.reason.startsWith("sensitive");
  const what = operation === "read" ? "读取" : "写入";
  const title = isSensitive ? `工具想${what}敏感文件` : `工具想${what}工作区外路径`;
  const header = isSensitive ? "敏感文件权限" : "路径权限";

  // Scope options carry remembered grants for the directory of this path, so
  // the same folder isn't re-prompted. Labels are matched by exact string
  // (the ask is optionsOnly — no free-text box that could silently fail to
  // match). 仅本次 carries no memory.
  const grantDir = dirname(c.resolvedPath);
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
          description: `本会话内不再询问 ${grantDir} 下的文件`,
          tone: "ok",
        },
        {
          label: ALLOW_PROJECT,
          description: `永久允许 ${grantDir} 下的文件（写入 .code-shell/settings.local.json）`,
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

  if (answer === ALLOW_ONCE) return null;
  if (answer === ALLOW_SESSION) {
    recordPathApproval("session", c.resolvedPath, operation, ctx.cwd!, ctx.sessionId);
    return null;
  }
  if (answer === ALLOW_PROJECT) {
    recordPathApproval("project", c.resolvedPath, operation, ctx.cwd!, ctx.sessionId);
    return null;
  }
  return `Error: path approval denied by user — ${c.reason}. Path: ${c.resolvedPath}`;
}

/**
 * Internal: reset the "disabled warning" latch. Tests flip the env var
 * between cases and need each one to be able to re-trigger the warning.
 * Not exported on the public surface beyond test usage.
 */
export function __resetPathPolicyWarnLatchForTests(): void {
  warnedDisabled = false;
}
