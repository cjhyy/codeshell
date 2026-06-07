/**
 * Pure selection of the "most recent file modification" to undo, given a
 * FileHistory snapshot list. Kept fs-free so the "what does /undo target"
 * decision is unit-testable and shared between the TUI command and any future
 * desktop entry point.
 *
 * A snapshot is the *pre-modification* backup of a file (see file-history.ts:
 * saveSnapshot runs before Write/Edit/ApplyPatch). So the newest snapshot's
 * backup is the content to restore for a single-step undo: it is the state the
 * file had immediately before the last edit.
 */

import type { FileSnapshot } from "./file-history.js";

/**
 * The snapshot for the most recent modification. Returns the entry with the
 * greatest `timestamp`; on a tie (same-millisecond snapshots of different
 * files) the LAST such entry in array order wins — saveSnapshot pushes in
 * chronological order, so the last pushed is the most recently recorded, which
 * is the stable, predictable choice. Returns null for an empty history.
 */
export function latestUndoTarget(snapshots: FileSnapshot[]): FileSnapshot | null {
  let best: FileSnapshot | null = null;
  for (const s of snapshots) {
    // `>=` so a later array entry with an equal timestamp supersedes an
    // earlier one (last-pushed wins on a tie).
    if (best === null || s.timestamp >= best.timestamp) best = s;
  }
  return best;
}

/**
 * For "/undo all": each tracked file's EARLIEST snapshot — its content before
 * the *first* AI edit this session. Restoring all of these reverts the whole
 * session's file changes (vs. latestUndoTarget, which is the single last step).
 *
 * Returns one snapshot per file path, ordered by that file's first-edit time
 * (oldest first) so a preview reads chronologically. On a same-millisecond tie
 * for a given file, the FIRST array entry wins (earliest recorded).
 */
export function earliestSnapshotsPerFile(snapshots: FileSnapshot[]): FileSnapshot[] {
  const earliest = new Map<string, FileSnapshot>();
  for (const s of snapshots) {
    const cur = earliest.get(s.filePath);
    // strict `<` so the first-seen entry wins on a tie (earliest recorded).
    if (!cur || s.timestamp < cur.timestamp) earliest.set(s.filePath, s);
  }
  return [...earliest.values()].sort((a, b) => a.timestamp - b.timestamp);
}
