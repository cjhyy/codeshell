/**
 * EnterWorktree / ExitWorktree tools — switch a session between git workspaces.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  SessionManager,
  SessionWorkspace,
  ToolContext,
  ToolDefinition,
} from "@cjhyy/code-shell-core";
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  validateWorktreeSlug,
  selectPlatformScript,
  runWorktreeSetup,
  worktreeHasUncommittedOrAheadChanges,
  currentBranch,
  cleanupAbortedWorktree,
  type RemoveWorktreeResult,
  type WorktreeSession,
} from "../git/worktree.js";
import { codingToolService } from "../capability-runtime.js";

export const switchSessionWorkspaceToolDef: ToolDefinition = {
  name: "SwitchSessionWorkspace",
  description:
    "Switch this current conversation session into or out of a workspace through the host UI path. " +
    "Use this when you need isolated or parallel work in a git worktree, when you need to move " +
    "this conversation to an existing worktree path/branch, or when you are done and should return " +
    "this current conversation to main. This is the correct way to move THIS conversation's session " +
    "into or out of a worktree on desktop.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description:
          "Workspace target: 'main', a new slug, an existing worktree path, or an existing branch name.",
      },
    },
    required: ["target"],
  },
};

export async function switchSessionWorkspaceTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const target = stringArg(args.target);
  if (!target) return "Error: target is required";
  const bridge = ctx?.workspace;
  if (!bridge) {
    return (
      "SwitchSessionWorkspace is not available in this host. " +
      "Use the host's supported workspace controls instead."
    );
  }
  try {
    const workspace = await bridge.switch(target);
    ctx?.setSessionWorkspace?.(workspace);
    const details =
      workspace.kind === "worktree" && workspace.worktree
        ? `\n  Branch: ${workspace.worktree.branch}`
        : "";
    return (
      `Switched session workspace:\n` +
      `  Path: ${workspace.root}` +
      details +
      `\n\n` +
      nextTurnNotice(workspace.root, ctx?.cwd ?? workspace.root)
    );
  } catch (err) {
    return `Error: switching workspace failed: ${(err as Error).message}`;
  }
}

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
    required: [],
  },
};

export async function enterWorktreeTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const target = stringArg(args.target) ?? stringArg(args.slug);
  if (!target) return "Error: target is required";

  const resolved = sessionServices(ctx);
  if (!resolved.ok) return resolved.error;
  const { sessionId, sessionManager } = resolved;

  const mainRoot = sessionManager.readSessionMainRoot(sessionId) ?? ctx?.cwd ?? process.cwd();
  const fromWorkspace = sessionManager.getSessionWorkspace(sessionId) ?? {
    root: mainRoot,
    kind: "main" as const,
  };
  const fromRoot = fromWorkspace.root;
  const currentTurnRoot = ctx?.cwd ?? fromRoot;
  const branchPrefix = codingToolService(ctx)?.readWorktreeBranchPrefix(mainRoot);

  try {
    if (target === "main") {
      ctx?.signal?.throwIfAborted();
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

    const selected = await resolveWorktreeTarget({
      target,
      cwd: ctx?.cwd ?? mainRoot,
      mainRoot,
      sessionId,
      currentWorkspace: fromWorkspace,
      branchPrefix,
      signal: ctx?.signal,
    });
    if (ctx?.signal?.aborted) {
      if (selected.created) {
        await cleanupAbortedWorktree(
          mainRoot,
          selected.session.worktreePath,
          selected.session.worktreeBranch,
        );
      }
      throw new Error("Worktree creation aborted");
    }

    const workspace = toSessionWorkspace(selected, fromWorkspace);
    const setupNote = selected.created
      ? await runSetupIfConfigured(selected.session.worktreePath, mainRoot, ctx)
      : "";
    if (ctx?.signal?.aborted) {
      if (selected.created) {
        await cleanupAbortedWorktree(
          mainRoot,
          selected.session.worktreePath,
          selected.session.worktreeBranch,
        );
      }
      throw new Error("Worktree creation aborted");
    }
    persistSessionWorkspace(sessionManager, sessionId, workspace, ctx);
    sessionManager.recordWorkspaceHandoff(sessionId, fromWorkspace, workspace);
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
    return `Error: switching worktree failed: ${(err as Error).message}`;
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
  const stateRevision = sessionManager.setSessionWorkspace(sessionId, workspace);
  ctx?.setSessionWorkspace?.(workspace, stateRevision);
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
  const resolved = sessionServices(ctx);
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
    (await worktreeHasUncommittedOrAheadChanges(
      workspace.worktree.path,
      workspace.worktree.baseRef,
    ));
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

  const mainRoot = sessionManager.readSessionMainRoot(sessionId) ?? workspace.root;
  const currentTurnRoot = ctx?.cwd ?? workspace.root;
  const branchPrefix = codingToolService(ctx)?.readWorktreeBranchPrefix(mainRoot);
  try {
    let removal: RemoveWorktreeResult | undefined;
    if (action === "discard" || action === "detach") {
      const otherOwners = await otherSessionOwnersForWorktree(
        sessionManager,
        sessionId,
        mainRoot,
        workspace.worktree.path,
      );
      if (otherOwners.length > 0) {
        const mainWorkspace: SessionWorkspace = { root: mainRoot, kind: "main" };
        persistSessionWorkspace(sessionManager, sessionId, mainWorkspace, ctx);
        sessionManager.recordWorkspaceHandoff(sessionId, workspace, mainWorkspace);
        return sharedWorktreeRemovalSkippedMessage(otherOwners, mainRoot, currentTurnRoot);
      }
    }
    if (action === "discard") {
      removal = removeWorktree(workspace.worktree.path, true, { prefix: branchPrefix });
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
    return `Error: exiting worktree failed: ${(err as Error).message}`;
  }
}

type SessionResolution =
  | { ok: true; sessionId: string; sessionManager: SessionManager }
  | { ok: false; error: string };

function sessionServices(ctx?: ToolContext): SessionResolution {
  const sessionId = ctx?.sessionId;
  if (!sessionId) return { ok: false, error: "Error: worktree tools require a sessionId." };
  const sessionManager = codingToolService(ctx)?.getSessionManager();
  if (!sessionManager) {
    return { ok: false, error: "Error: worktree tools require a session manager." };
  }
  return { ok: true, sessionId, sessionManager };
}

async function otherSessionOwnersForWorktree(
  sessionManager: SessionManager,
  sessionId: string,
  mainRoot: string,
  worktreePath: string,
): Promise<string[]> {
  const workspaceOwners = sessionManager
    .list(Number.MAX_SAFE_INTEGER)
    .map((session) => ({ sessionId: session.sessionId, workspace: session.workspace }))
    .filter((owner) => owner.workspace !== undefined);
  const entry = (
    await listWorktrees(mainRoot, {
      currentSessionId: sessionId,
      workspaceOwners,
    })
  ).find((worktree) => resolve(worktree.path) === resolve(worktreePath));
  return (entry?.occupiedBySessionIds ?? []).filter((owner) => owner !== sessionId);
}

function sharedWorktreeRemovalSkippedMessage(
  otherOwners: string[],
  mainRoot: string,
  currentTurnRoot: string,
): string {
  return (
    `Error: this worktree is also in use by session(s) ${otherOwners.join(", ")}; ` +
    `switching to main, but removal has been skipped.\n` +
    `Back to ${mainRoot} starting next turn.\n` +
    nextTurnNotice(mainRoot, currentTurnRoot)
  );
}

interface ResolvedTarget {
  created: boolean;
  session: WorktreeSession;
  from: string;
}

async function resolveWorktreeTarget(opts: {
  target: string;
  cwd: string;
  mainRoot: string;
  sessionId: string;
  currentWorkspace: SessionWorkspace;
  branchPrefix?: string;
  signal?: AbortSignal;
}): Promise<ResolvedTarget> {
  const entries = await listWorktrees(opts.mainRoot);
  opts.signal?.throwIfAborted();
  const pathTarget = pathLike(opts.target) ? resolvePathTarget(opts.target, opts.cwd) : undefined;
  const branchTarget = normalizeBranchName(opts.target);
  const match = entries.find((entry) => {
    if (pathTarget && resolve(entry.path) === pathTarget) return true;
    return entry.branch === branchTarget;
  });

  if (match) {
    const originalBranch = await currentBranch(opts.mainRoot);
    opts.signal?.throwIfAborted();
    return {
      created: false,
      session: {
        originalCwd: opts.mainRoot,
        worktreePath: match.path,
        worktreeName: match.path.split(/[\\/]/).pop() ?? match.branch,
        worktreeBranch: match.branch,
        originalBranch,
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
  const created = await createWorktree(opts.mainRoot, opts.target, opts.sessionId, {
    prefix: opts.branchPrefix,
    signal: opts.signal,
  });
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
  const services = codingToolService(ctx);
  const setupScripts = services?.readWorktreeSetupScripts(mainRoot);
  const script = selectPlatformScript(setupScripts);
  if (!script) return "";
  const setupSandbox = services
    ? await services.resolveWorktreeSetupSandbox(worktreePath)
    : ctx?.sandbox;
  const setupShellEnv = services?.readWorktreeSetupShellEnv(worktreePath) ?? ctx?.shellEnv;
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
