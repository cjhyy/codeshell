/**
 * EnterWorktree / ExitWorktree tools — create and manage isolated git worktrees.
 */

import type { ToolDefinition } from "../../types.js";
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  validateWorktreeSlug,
  type WorktreeSession,
} from "../../git/worktree.js";

// Global worktree state
let _activeWorktree: WorktreeSession | undefined;

export function getActiveWorktree(): WorktreeSession | undefined {
  return _activeWorktree;
}

export const enterWorktreeToolDef: ToolDefinition = {
  name: "EnterWorktree",
  description:
    "Create an isolated git worktree for safe code modifications. " +
    "The worktree is a separate copy of the repository on a new branch. " +
    "Changes made in the worktree do not affect the main working directory. " +
    "Use this when you need to make experimental changes or work in isolation.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description:
          "A short identifier for the worktree (alphanumeric, dots, dashes only, max 64 chars). " +
          "Example: 'fix-auth-bug', 'refactor-api'",
      },
    },
    required: ["slug"],
  },
};

export async function enterWorktreeTool(args: Record<string, unknown>): Promise<string> {
  const slug = args.slug as string;
  if (!slug) return "Error: slug is required";

  if (_activeWorktree) {
    return `Error: Already in a worktree at ${_activeWorktree.worktreePath}. Exit it first with ExitWorktree.`;
  }

  try {
    validateWorktreeSlug(slug);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  try {
    // Use a placeholder session ID (the agent should set this properly)
    const sessionId = args.__sessionId as string ?? `wt-${Date.now()}`;
    const cwd = args.__cwd as string ?? process.cwd();

    _activeWorktree = createWorktree(cwd, slug, sessionId);

    return (
      `Worktree created:\n` +
      `  Path:   ${_activeWorktree.worktreePath}\n` +
      `  Branch: ${_activeWorktree.worktreeBranch}\n` +
      `  From:   ${_activeWorktree.originalBranch ?? "HEAD"}\n\n` +
      `You are now working in an isolated copy. Changes here won't affect the main repo.`
    );
  } catch (err) {
    return `Error creating worktree: ${(err as Error).message}`;
  }
}

export const exitWorktreeToolDef: ToolDefinition = {
  name: "ExitWorktree",
  description:
    "Exit the current worktree and return to the main working directory. " +
    "Choose whether to keep or discard the changes made in the worktree.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["keep", "discard"],
        description:
          "'keep' preserves the worktree branch for later merging. " +
          "'discard' removes the worktree and its branch entirely.",
      },
    },
    required: ["action"],
  },
};

export async function exitWorktreeTool(args: Record<string, unknown>): Promise<string> {
  if (!_activeWorktree) {
    return "Not currently in a worktree.";
  }

  const action = args.action as string;
  const session = _activeWorktree;
  _activeWorktree = undefined;

  try {
    if (action === "discard") {
      removeWorktree(session.worktreePath, true);
      return `Worktree removed and branch ${session.worktreeBranch} deleted. Back to ${session.originalCwd}.`;
    } else {
      removeWorktree(session.worktreePath, false);
      return (
        `Worktree removed. Branch ${session.worktreeBranch} preserved.\n` +
        `To merge: git merge ${session.worktreeBranch}\n` +
        `Back to ${session.originalCwd}.`
      );
    }
  } catch (err) {
    return `Error exiting worktree: ${(err as Error).message}`;
  }
}
