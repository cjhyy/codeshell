import type { Stats } from "node:fs";
/**
 * Pure interpretation of persisted Session state fields.
 *
 * Owns the compatibility readings of state.json that several Session owners
 * share: ephemeral (process-local) classification, kind normalization, the
 * workspace-pointer shape check, the legacy `cwd` main-root reading, and the
 * filesystem validation of a worktree root before resume. Nothing here writes.
 */

import { existsSync, lstatSync } from "node:fs";
import type { SessionKind, SessionState, SessionWorkspace } from "../types.js";
import type { SessionWorkspaceCapability } from "../capabilities/index.js";

/**
 * Runtime source of truth for sessions whose state must not outlive their UI
 * lifecycle. The explicit marker covers modern side forks; the qchat namespace
 * keeps historical/blank quick chats fail-closed if their older state file did
 * not contain the marker yet.
 */
export function isEphemeralSessionState(
  state: Pick<SessionState, "sessionId" | "ephemeral">,
): boolean {
  return state.ephemeral === true || state.sessionId.startsWith("qchat-");
}

export function normalizedSessionKind(kind: unknown): SessionKind {
  return kind === "pet" ? "pet" : "work";
}

export function isSessionWorkspace(value: unknown): value is SessionWorkspace {
  if (!value || typeof value !== "object") return false;
  const ws = value as Partial<SessionWorkspace>;
  if (typeof ws.root !== "string" || ws.root.length === 0) return false;
  if (ws.kind !== "main" && ws.kind !== "worktree") return false;
  if (ws.kind === "main") return ws.worktree === undefined;
  const wt = ws.worktree as SessionWorkspace["worktree"] | undefined;
  return (
    !!wt &&
    typeof wt.path === "string" &&
    wt.path.length > 0 &&
    typeof wt.branch === "string" &&
    wt.branch.length > 0 &&
    typeof wt.baseRef === "string" &&
    wt.baseRef.length > 0 &&
    wt.createdBy === "codeshell"
  );
}

/**
 * Read the session's persisted main-project root from the legacy `state.cwd`
 * field. The field name is part of the state.json compatibility contract and
 * must not be rewritten to `projectRoot`; `state.workspace.root` separately
 * identifies the current main/worktree execution root used on resume.
 */
export function sessionMainRoot(state: Pick<SessionState, "cwd">): string | undefined {
  return typeof state.cwd === "string" && state.cwd.length > 0 ? state.cwd : undefined;
}

export async function validateResumeWorktreeRoot(
  root: string,
  workspaceCapability: SessionWorkspaceCapability,
): Promise<string | null> {
  if (!existsSync(root)) return "no longer exists";
  let stat: Stats;
  try {
    stat = lstatSync(root);
  } catch {
    return "no longer exists";
  }
  if (stat.isSymbolicLink()) return "is not a valid git worktree (symbolic link)";
  if (!stat.isDirectory()) return "is not a valid git worktree (not a directory)";
  if (!(await workspaceCapability.validateRoot(root))) return "is not a valid workspace root";
  return null;
}
