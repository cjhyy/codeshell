/**
 * The git block of the coding capability's dynamic context.
 *
 * A git status changes on almost every run of a coding session. Resending it
 * would append a full copy to history each time, so it is a point-in-time
 * snapshot instead: shown once per context snapshot (the context ledger's
 * "snapshot-only" mode) and saying so itself. Bounded and deterministic: the
 * same repository state always renders the same bytes.
 */
import type { GitLogEntry, GitStatusEntry } from "./utils.js";

export const GIT_SNAPSHOT_NOTE =
  "This git status is a snapshot taken when this context was last refreshed. " +
  "It will not update during the conversation; run git to see the current state.";

/** Status lines shown before the rest is counted. */
export const GIT_SNAPSHOT_STATUS_LIMIT = 40;
/** Recent commits shown. */
export const GIT_SNAPSHOT_COMMIT_LIMIT = 5;
/** Characters of a commit subject shown. */
const COMMIT_SUBJECT_LIMIT = 160;

function statusLine(entry: GitStatusEntry): string {
  return entry.origPath
    ? `${entry.status} ${entry.origPath} -> ${entry.path}`
    : `${entry.status} ${entry.path}`;
}

function commitLine(entry: GitLogEntry): string {
  const subject =
    entry.message.length > COMMIT_SUBJECT_LIMIT
      ? `${entry.message.slice(0, COMMIT_SUBJECT_LIMIT)}…`
      : entry.message;
  return `${entry.hash} ${subject}`;
}

export function renderGitContextSnapshot(args: {
  branch: string;
  status: readonly GitStatusEntry[];
  log: readonly GitLogEntry[];
}): string {
  const parts = [`gitStatus: ${GIT_SNAPSHOT_NOTE}\nCurrent branch: ${args.branch}`];
  if (args.status.length > 0) {
    const shown = args.status.slice(0, GIT_SNAPSHOT_STATUS_LIMIT).map(statusLine);
    const more = args.status.length - shown.length;
    if (more > 0) shown.push(`… ${more} more`);
    parts.push(`Status:\n${shown.join("\n")}`);
  }
  if (args.log.length > 0) {
    const commits = args.log.slice(0, GIT_SNAPSHOT_COMMIT_LIMIT).map(commitLine);
    parts.push(`Recent commits:\n${commits.join("\n")}`);
  }
  return parts.join("\n\n");
}
