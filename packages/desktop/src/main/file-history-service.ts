/**
 * Turn-level undo / redo for the desktop Files-Changed card, backed by core's
 * FileHistory snapshots (NOT git). Mirrors the CLI `/undo`'s snapshot path so
 * both entry points share one semantics: undo reverts the most recent
 * conversation turn's file edits to their pre-turn state (and deletes files the
 * turn created); redo re-applies them. See packages/core FileHistory /
 * latestTurnUndoTargets / latestRedoTargets.
 *
 * Keyed by engine sessionId — the FileHistory lives under the session dir, not
 * the cwd. Operations always act on "the latest turn" internally, so the
 * renderer never needs to pass a turnSeq (it has none — its turnEpoch is a
 * separate client-side counter).
 */
import * as path from "node:path";
import {
  FileHistory,
  latestTurnUndoTargets,
  latestRedoTargets,
  sessionsRoot,
} from "@cjhyy/code-shell-core";

const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

export interface TurnUndoState {
  /** The latest turn can be undone (it has live, not-yet-undone snapshots). */
  undoable: boolean;
  /** The latest turn was undone and can be re-applied. */
  redoable: boolean;
  /** Number of files the undo/redo would touch (for the card's label). */
  fileCount: number;
}

export interface TurnUndoResult {
  filePath: string;
  ok: boolean;
}

function historyFor(sessionId: string): FileHistory | null {
  if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId)) return null;
  return FileHistory.loadFromDir(path.join(sessionsRoot(), sessionId));
}

/** Read-only: what the latest turn's card should show (undo vs redo vs nothing). */
export function turnUndoState(sessionId: string): TurnUndoState {
  const history = historyFor(sessionId);
  if (!history) return { undoable: false, redoable: false, fileCount: 0 };
  const undoTargets = latestTurnUndoTargets(history.getAllSnapshots());
  if (undoTargets.length > 0) {
    return { undoable: true, redoable: false, fileCount: undoTargets.length };
  }
  const redoTargets = latestRedoTargets(history.getRedoRecords(), history.getAllSnapshots());
  if (redoTargets.length > 0) {
    return { undoable: false, redoable: true, fileCount: redoTargets.length };
  }
  return { undoable: false, redoable: false, fileCount: 0 };
}

/** Undo the most recent turn's file changes. Per-file results. */
export function undoTurn(sessionId: string): TurnUndoResult[] {
  const history = historyFor(sessionId);
  if (!history) return [];
  const targets = latestTurnUndoTargets(history.getAllSnapshots());
  if (targets.length === 0) return [];
  return history.undoLatestTurn(targets);
}

/** Re-apply the most recently undone turn's file changes. Per-file results. */
export function redoTurn(sessionId: string): TurnUndoResult[] {
  const history = historyFor(sessionId);
  if (!history) return [];
  const targets = latestRedoTargets(history.getRedoRecords(), history.getAllSnapshots());
  if (targets.length === 0) return [];
  return history.redoLatestTurn(targets);
}
