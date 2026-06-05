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

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePath, sep } from "node:path";
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
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production, …
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /auth/i,
  /token/i,
  /credential/i,
  /secret/i,
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
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(p);
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
  return `Error: path requires approval — ${c.reason}. Path: ${c.resolvedPath}. ` +
    `Set CODESHELL_PATH_POLICY=off to disable enforcement during a rollback.`;
}

export async function enforcePathPolicyWithApproval(
  filePath: string,
  operation: PathOperation,
  ctx?: ToolContext,
): Promise<string | null> {
  if (ctx?.cwd === undefined) return null;
  const c = classifyPath(filePath, { workspaceRoot: ctx.cwd, operation });
  if (c.decision === "allow") return null;
  if (c.decision === "deny") {
    return `Error: blocked by path policy — ${c.reason}. Path: ${c.resolvedPath}`;
  }
  if (operation === "write" && ctx.planMode) {
    return `Error: blocked by path policy — ${c.reason}. Path: ${c.resolvedPath}. ` +
      `Plan mode does not allow file writes.`;
  }
  if (!ctx.askUser) {
    return `Error: path requires approval — ${c.reason}. Path: ${c.resolvedPath}. ` +
      `No interactive approval UI is available in this run.`;
  }

  const answer = await ctx.askUser(
    `工具想${operation === "read" ? "读取" : "写入"}工作区外路径：\n${c.resolvedPath}\n\n原因：${c.reason}\n是否允许本次操作？`,
    {
      header: "路径权限",
      options: [
        { label: "允许本次", description: "仅允许当前这一次文件操作继续执行" },
        { label: "拒绝", description: "阻止当前文件操作" },
      ],
    },
  );
  if (answer.trim().startsWith("允许本次")) return null;
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
