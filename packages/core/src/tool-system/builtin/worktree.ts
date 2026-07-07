/**
 * EnterWorktree / ExitWorktree tools — switch a session between git workspaces.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolDefinition, SessionWorkspace } from "../../types.js";
import type { ToolContext } from "../context.js";
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  validateWorktreeSlug,
  selectPlatformScript,
  runWorktreeSetup,
  worktreeHasUncommittedOrAheadChanges,
  currentBranch,
  type RemoveWorktreeResult,
  type WorktreeSession,
} from "../../git/worktree.js";
import type { SessionManager } from "../../session/session-manager.js";

export const enterWorktreeToolDef: ToolDefinition = {
  name: "EnterWorktree",
  description:
    "Switch the current session workspace. Target can be a new worktree slug, " +
    "an existing worktree path or branch, or 'main' to return to the main repository. " +
    "Switching leaves the previous worktree on disk.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description:
          "Workspace target: 'main', a new slug (alphanumeric, dots, dashes, underscores), " +
          "or an existing worktree path/branch to switch to.",
      },
      slug: {
        type: "string",
        description: "Deprecated alias for target. Prefer target.",
      },
    },
    required: ["target"],
  },
};

export async function enterWorktreeTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const target = stringArg(args.target) ?? stringArg(args.slug);
  if (!target) return "Error: target is required";

  const resolved = sessionServices(args, ctx);
  if (!resolved.ok) return resolved.error;
  const { sessionId, sessionManager } = resolved;

  const mainRoot =
    sessionManager.readCwd(sessionId) ?? stringArg(args.__cwd) ?? ctx?.cwd ?? process.cwd();
  const fromWorkspace = sessionManager.getSessionWorkspace(sessionId) ?? {
    root: mainRoot,
    kind: "main" as const,
  };
  const fromRoot = fromWorkspace.root;
  const currentTurnRoot = ctx?.cwd ?? fromRoot;

  try {
    if (target === "main") {
      const workspace: SessionWorkspace = { root: mainRoot, kind: "main" };
      persistSessionWorkspace(sessionManager, sessionId, workspace, ctx);
      sessionManager.recordWorkspaceHandoff(sessionId, fromWorkspace, workspace);
      return (
        `Switched to main workspace:\n` +
        `  Path: ${mainRoot}\n` +
        `  From: ${fromRoot}\n\n` +
        nextTurnNotice(mainRoot, currentTurnRoot)
      );
    }

    const selected = resolveWorktreeTarget({
      target,
      cwd: ctx?.cwd ?? mainRoot,
      mainRoot,
      sessionId,
      currentWorkspace: fromWorkspace,
    });

    const workspace = toSessionWorkspace(selected, fromWorkspace);
    persistSessionWorkspace(sessionManager, sessionId, workspace, ctx);
    sessionManager.recordWorkspaceHandoff(sessionId, fromWorkspace, workspace);

    const setupNote = selected.created
      ? await runSetupIfConfigured(selected.session.worktreePath, mainRoot, ctx)
      : "";
    const verb = selected.created ? "Worktree created and switched" : "Switched to worktree";
    return (
      `${verb}:\n` +
      `  Path:   ${workspace.worktree!.path}\n` +
      `  Branch: ${workspace.worktree!.branch}\n` +
      `  From:   ${selected.from}\n` +
      `  Previous: ${fromRoot}\n\n` +
      nextTurnNotice(workspace.root, currentTurnRoot) +
      setupNote
    );
  } catch (err) {
    return `Error switching worktree: ${(err as Error).message}`;
  }
}

/** Keep setup output from bloating the tool result — head+tail-ish trim. */
function truncate(s: string, max = 2000): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…(${s.length - max} more chars)`;
}

function persistSessionWorkspace(
  sessionManager: SessionManager,
  sessionId: string,
  workspace: SessionWorkspace,
  ctx?: ToolContext,
): void {
  sessionManager.setSessionWorkspace(sessionId, workspace);
  ctx?.setSessionWorkspace?.(workspace);
}

function nextTurnNotice(nextRoot: string, currentTurnRoot: string): string {
  return (
    `Workspace switched to ${nextRoot}. This takes effect on the next turn - ` +
    `file/shell/sandbox tools in the CURRENT turn still target ${currentTurnRoot}.`
  );
}

export const exitWorktreeToolDef: ToolDefinition = {
  name: "ExitWorktree",
  description:
    "Switch the current session back to the main working directory. " +
    "Choose whether to keep the worktree, detach it while preserving the branch, " +
    "or discard it entirely.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["keep", "detach", "discard"],
        description:
          "'keep' preserves the worktree directory and branch for later. " +
          "'detach' removes the directory but keeps the branch. " +
          "'discard' removes the directory and its branch entirely. " +
          "If omitted, a clean worktree is detached automatically; a dirty worktree requires keep/discard.",
      },
    },
    required: [],
  },
};

export async function exitWorktreeTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const resolved = sessionServices(args, ctx);
  if (!resolved.ok) return resolved.error;
  const { sessionId, sessionManager } = resolved;

  const workspace = sessionManager.getSessionWorkspace(sessionId);
  if (!workspace || workspace.kind !== "worktree" || !workspace.worktree) {
    return "Not currently in a worktree.";
  }

  const requested = args.action as string | undefined;
  if (
    requested !== undefined &&
    requested !== "keep" &&
    requested !== "detach" &&
    requested !== "discard"
  ) {
    return `Error: unknown action "${requested}" (expected keep, detach, or discard).`;
  }

  const hasPendingChanges =
    existsSync(workspace.worktree.path) &&
    worktreeHasUncommittedOrAheadChanges(workspace.worktree.path, workspace.worktree.baseRef);
  const action = requested ?? (hasPendingChanges ? undefined : "detach");
  if (!action) {
    return (
      `Error: worktree has uncommitted changes or new commits. Choose action "keep" to preserve ` +
      `the directory or "discard" to delete the worktree and branch.`
    );
  }
  if (action === "detach" && hasPendingChanges) {
    return (
      `Error: detach would drop uncommitted changes or new commits. Choose action "keep" to preserve ` +
      `the directory or "discard" to delete the worktree and branch.`
    );
  }

  const mainRoot = sessionManager.readCwd(sessionId) ?? workspace.root;
  const currentTurnRoot = ctx?.cwd ?? workspace.root;
  try {
    let removal: RemoveWorktreeResult | undefined;
    if (action === "discard") {
      removal = removeWorktree(workspace.worktree.path, true);
    } else if (action === "detach") {
      removal = removeWorktree(workspace.worktree.path, false);
    }
    const mainWorkspace: SessionWorkspace = { root: mainRoot, kind: "main" };
    persistSessionWorkspace(sessionManager, sessionId, mainWorkspace, ctx);
    sessionManager.recordWorkspaceHandoff(sessionId, workspace, mainWorkspace);

    if (action === "keep") {
      return (
        `Worktree preserved at ${workspace.worktree.path}. ` +
        `Branch ${workspace.worktree.branch} preserved.\n` +
        `Back to ${mainRoot} starting next turn.\n` +
        nextTurnNotice(mainRoot, currentTurnRoot)
      );
    }
    if (action === "discard") {
      if (removal?.branchDeleted === false) {
        const branch = removal.branch ?? workspace.worktree.branch;
        return (
          `WARNING: worktree removed; branch ${branch} could not be deleted: ` +
          `${removal.branchError ?? "unknown error"}\n` +
          `Delete it manually with git branch -D ${branch}.\n` +
          `Back to ${mainRoot} starting next turn.\n` +
          nextTurnNotice(mainRoot, currentTurnRoot)
        );
      }
      return (
        `Worktree removed and branch ${workspace.worktree.branch} deleted. ` +
        `Back to ${mainRoot} starting next turn.\n` +
        nextTurnNotice(mainRoot, currentTurnRoot)
      );
    }
    return (
      `Worktree removed${requested ? "" : " (auto-detached clean worktree)"}. ` +
      `Branch ${workspace.worktree.branch} preserved.\n` +
      `To merge: git merge ${workspace.worktree.branch}\n` +
      `Back to ${mainRoot} starting next turn.\n` +
      nextTurnNotice(mainRoot, currentTurnRoot)
    );
  } catch (err) {
    return `Error exiting worktree: ${(err as Error).message}`;
  }
}

type SessionResolution =
  | { ok: true; sessionId: string; sessionManager: SessionManager }
  | { ok: false; error: string };

function sessionServices(args: Record<string, unknown>, ctx?: ToolContext): SessionResolution {
  const sessionId = stringArg(args.__sessionId) ?? ctx?.sessionId;
  if (!sessionId) return { ok: false, error: "Error: worktree tools require a sessionId." };
  const sessionManager = ctx?.engine?.getSessionManager?.();
  if (!sessionManager) {
    return { ok: false, error: "Error: worktree tools require a session manager." };
  }
  return { ok: true, sessionId, sessionManager };
}

interface ResolvedTarget {
  created: boolean;
  session: WorktreeSession;
  from: string;
}

function resolveWorktreeTarget(opts: {
  target: string;
  cwd: string;
  mainRoot: string;
  sessionId: string;
  currentWorkspace: SessionWorkspace;
}): ResolvedTarget {
  const entries = listWorktrees(opts.mainRoot);
  const pathTarget = pathLike(opts.target) ? resolvePathTarget(opts.target, opts.cwd) : undefined;
  const branchTarget = normalizeBranchName(opts.target);
  const match = entries.find((entry) => {
    if (pathTarget && resolve(entry.path) === pathTarget) return true;
    return entry.branch === branchTarget;
  });

  if (match) {
    return {
      created: false,
      session: {
        originalCwd: opts.mainRoot,
        worktreePath: match.path,
        worktreeName: match.path.split(/[\\/]/).pop() ?? match.branch,
        worktreeBranch: match.branch,
        originalBranch: currentBranch(opts.mainRoot),
        sessionId: opts.sessionId,
        createdAt: Date.now(),
      },
      from: opts.currentWorkspace.root,
    };
  }

  if (pathTarget) {
    throw new Error(`no existing worktree found at ${opts.target}`);
  }

  validateWorktreeSlug(opts.target);
  const created = createWorktree(opts.mainRoot, opts.target, opts.sessionId);
  return { created: true, session: created, from: created.originalBranch ?? "HEAD" };
}

function toSessionWorkspace(
  selected: ResolvedTarget,
  currentWorkspace: SessionWorkspace,
): SessionWorkspace {
  const previous =
    currentWorkspace.kind === "worktree" &&
    currentWorkspace.worktree &&
    resolve(currentWorkspace.worktree.path) === resolve(selected.session.worktreePath)
      ? currentWorkspace.worktree
      : undefined;
  return {
    root: selected.session.worktreePath,
    kind: "worktree",
    worktree: {
      path: selected.session.worktreePath,
      branch: selected.session.worktreeBranch,
      baseRef: previous?.baseRef ?? selected.session.originalBranch ?? "HEAD",
      createdBy: "codeshell",
    },
  };
}

async function runSetupIfConfigured(
  worktreePath: string,
  mainRoot: string,
  ctx?: ToolContext,
): Promise<string> {
  const setupScripts = ctx?.engine?.readWorktreeSetupScripts(mainRoot);
  const script = selectPlatformScript(setupScripts);
  if (!script) return "";
  const setupSandbox = ctx?.engine?.resolveWorktreeSetupSandbox
    ? await ctx.engine.resolveWorktreeSetupSandbox(worktreePath)
    : ctx?.sandbox;
  const setupShellEnv = ctx?.engine?.readWorktreeSetupShellEnv
    ? ctx.engine.readWorktreeSetupShellEnv(worktreePath)
    : ctx?.shellEnv;
  const setup = await runWorktreeSetup(worktreePath, script, {
    sandbox: setupSandbox,
    shellEnv: setupShellEnv,
    signal: ctx?.signal,
  });
  if (setup.ok) {
    return `\n\nRan setup script (exit 0).${setup.output ? `\n${truncate(setup.output)}` : ""}`;
  }
  return (
    `\n\n⚠️ Setup script failed (exit ${setup.exitCode ?? "?"}) — continuing anyway. ` +
    `You may need to run setup manually.${setup.output ? `\n${truncate(setup.output)}` : ""}`
  );
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pathLike(target: string): boolean {
  return (
    isAbsolute(target) || target.startsWith(".") || target.includes("/") || target.includes("\\")
  );
}

function resolvePathTarget(target: string, cwd: string): string {
  return resolve(cwd, target);
}

function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, "");
}
