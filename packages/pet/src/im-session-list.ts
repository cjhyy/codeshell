/**
 * Rendering the Session list a user sees in a chat app.
 *
 * Two things separate this from the desktop sidebar. First, a chat message
 * must never carry a raw sessionId: the Sessions tool returns both the id and
 * an opaque selector, and only the selector is safe to put in front of a
 * channel where it may be quoted, forwarded or logged. Second, there is no
 * stored "已完成 / 运行中" status to read — SessionStatus on disk is only
 * active/paused/terminal-reason, and `active` is never repaired after a crash,
 * so the label has to be derived from the live projection instead.
 *
 * Ordinals are 1-based and belong to one rendering. The host resolves "enter
 * 2" against the list it actually sent, never against the model's retelling.
 */

import type { PetSessionRunState, PetTerminalStatus } from "./types.js";

/** What the user reads next to a Session name. */
export type ImSessionDisplayStatus =
  | "running"
  | "waiting-approval"
  | "completed"
  | "interrupted"
  | "idle";

export interface ImSessionRow {
  ordinal: number;
  /** Opaque Sessions selector. The only identifier that leaves the host. */
  selector: string;
  title: string;
  workspace?: string;
  status: ImSessionDisplayStatus;
  updatedAt: number;
}

export interface ImSessionCandidate {
  selector: string;
  title: string;
  workspace?: string;
  runState: PetSessionRunState;
  terminal?: { status: PetTerminalStatus; at: number };
  pendingDecisionCount?: number;
  archived?: boolean;
  updatedAt: number;
}

/** A chat list stays short enough to scan on a phone. */
export const IM_SESSION_LIST_LIMIT = 5;

/**
 * Derive the label from the projection rather than the stored status.
 * A pending decision outranks "running" because it is the one state where the
 * user has something to do.
 */
export function imSessionDisplayStatus(candidate: ImSessionCandidate): ImSessionDisplayStatus {
  if (candidate.terminal) {
    return candidate.terminal.status === "completed" ? "completed" : "interrupted";
  }
  if ((candidate.pendingDecisionCount ?? 0) > 0) return "waiting-approval";
  if (candidate.runState === "running" || candidate.runState === "queued") return "running";
  if (candidate.runState === "idle") return "idle";
  return "idle";
}

/**
 * Build the numbered rows for one message. Archived Sessions are dropped
 * rather than shown greyed out: they cannot be entered, so offering one only
 * produces a refusal after the user has already chosen it.
 */
export function buildImSessionList(
  candidates: readonly ImSessionCandidate[],
  limit: number = IM_SESSION_LIST_LIMIT,
): ImSessionRow[] {
  return candidates
    .filter((candidate) => !candidate.archived)
    .slice(0, Math.max(0, limit))
    .map((candidate, index) => ({
      ordinal: index + 1,
      selector: candidate.selector,
      title: candidate.title,
      ...(candidate.workspace ? { workspace: candidate.workspace } : {}),
      status: imSessionDisplayStatus(candidate),
      updatedAt: candidate.updatedAt,
    }));
}

/**
 * Resolve a user's ordinal against the rows actually sent. Returns undefined
 * for anything out of range so an unmatched "enter 9" asks again instead of
 * binding whatever happens to be last.
 */
export function resolveImSessionOrdinal(
  rows: readonly ImSessionRow[],
  ordinal: number,
): ImSessionRow | undefined {
  if (!Number.isSafeInteger(ordinal)) return undefined;
  return rows.find((row) => row.ordinal === ordinal);
}

/**
 * True when the rendered rows cannot identify a Session by title alone, so
 * the host must keep the user choosing rather than guessing for them.
 */
export function hasAmbiguousImSessionTitles(rows: readonly ImSessionRow[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.title.trim().toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
