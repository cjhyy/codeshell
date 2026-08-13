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

import type { FileSnapshot, RedoRecord } from "./file-history.js";

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
    // Undone snapshots belong to a reverted turn: their content is no longer on
    // disk and they are not the session baseline, so skip them — otherwise an
    // undone (earlier) snapshot could win the baseline and `/undo all` would
    // restore stale content.
    if (s.undone) continue;
    const cur = earliest.get(s.filePath);
    // strict `<` so the first-seen entry wins on a tie (earliest recorded).
    if (!cur || s.timestamp < cur.timestamp) earliest.set(s.filePath, s);
  }
  return [...earliest.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * For turn-level "/undo": the snapshots needed to revert just the MOST RECENT
 * conversation turn (one user message = one turn, see SessionState.turnSeq).
 *
 * The latest turn = the greatest `turnSeq` present. A turn boundary is defined
 * by turnSeq, NOT wall-clock — a clock skew must not move the boundary. Within
 * that turn, each touched file is restored to its EARLIEST snapshot of the turn
 * (its content before the *first* edit that turn), so re-editing a file twice
 * in one turn still reverts to the pre-turn baseline — and edits from *earlier*
 * turns are left intact (that's the whole point vs. earliestSnapshotsPerFile,
 * which spans the whole session).
 *
 * Backward compatibility: snapshots written before this feature have no
 * `turnSeq`. They share the `undefined` bucket. `undefined` sorts as the
 * smallest "turn", so any real (tagged) turn supersedes the legacy bucket; a
 * history that is ALL-legacy degrades to whole-session behaviour (each file's
 * earliest) rather than throwing.
 *
 * Returns one snapshot per file, ordered by that file's first-edit time within
 * the turn (oldest first) so a preview reads chronologically. Empty → [].
 */
export function latestTurnUndoTargets(snapshots: FileSnapshot[]): FileSnapshot[] {
  if (snapshots.length === 0) return [];

  // Find the latest turn, SKIPPING undone turns: once a turn is undone (marked,
  // not deleted) its snapshots stay on disk for redo but must not be re-selected
  // by undo — so the next /undo peels the prior live turn ("onion" behaviour).
  // undefined (legacy) is treated as the smallest turn so it loses to any tagged
  // turn; a key of `-Infinity` models that ordering.
  const turnKey = (s: FileSnapshot): number => s.turnSeq ?? -Infinity;
  let maxTurn = -Infinity;
  let found = false;
  for (const s of snapshots) {
    if (s.undone) continue;
    const k = turnKey(s);
    if (k > maxTurn) maxTurn = k;
    found = true;
  }
  if (!found) return [];

  // Within the latest live turn, each file's earliest snapshot = its pre-turn
  // state. Undone snapshots are skipped here too (defensive: they share neither
  // the selected turn nor the baseline).
  const earliest = new Map<string, FileSnapshot>();
  for (const s of snapshots) {
    if (s.undone) continue;
    if (turnKey(s) !== maxTurn) continue;
    const cur = earliest.get(s.filePath);
    // strict `<` so the first-seen entry wins on a same-ms tie (earliest).
    if (!cur || s.timestamp < cur.timestamp) earliest.set(s.filePath, s);
  }
  return [...earliest.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * For "/redo": the RedoRecord[] of the MOST RECENT undone turn — the turn that
 * `redoLatestTurn` should re-apply — but ONLY when that turn is still the latest
 * undone state (i.e. nothing newer happened since the undo). Otherwise [].
 *
 * Rule: let R = the LOWEST turnSeq present in `redoRecords` (a RedoRecord exists
 * only for a turn that was undone and not yet redone). Undo walks BACKWARD down
 * the turn stack, so after `undo(2); undo(1)` both records are pending and the
 * one to re-apply first is turn 1 — the most recently undone, i.e. the lowest.
 * Selecting the greatest instead replayed turns out of order: `redo` jumped
 * straight to turn 2, skipping turn 1's state entirely and stranding turn 1's
 * record forever (its snapshots stay `undone`, so it never becomes selectable).
 * With two files that also produced a state that never existed — turn 1 still
 * reverted while turn 2 was applied.
 *
 * R is redoable iff NO snapshot belongs to a strictly newer LIVE (non-undone)
 * turn — a fresh edit after the undo supersedes the redo and invalidates it
 * (spec: "新轮使 redo 失效"). Created-only turns have no pre-turn snapshot, so
 * the RedoRecord itself is the sole evidence and is honoured as long as nothing
 * newer superseded it.
 *
 * Empty `redoRecords` → []. fs-free so /redo's target decision is unit-testable.
 */
export function latestRedoTargets(
  redoRecords: RedoRecord[],
  snapshots: FileSnapshot[],
): RedoRecord[] {
  if (redoRecords.length === 0) return [];

  // The most recently undone turn is the LOWEST pending one (undo pops the
  // stack from the top down), and it is the next one to re-apply.
  let nextRedoTurn = Infinity;
  for (const r of redoRecords) {
    if (r.turnSeq < nextRedoTurn) nextRedoTurn = r.turnSeq;
  }

  // Supersession is still judged against the NEWEST pending redo turn: a live
  // snapshot newer than that is a fresh edit made after the undo, which
  // invalidates the whole pending redo chain rather than just one turn.
  let maxRedoTurn = -Infinity;
  for (const r of redoRecords) {
    if (r.turnSeq > maxRedoTurn) maxRedoTurn = r.turnSeq;
  }
  for (const s of snapshots) {
    if (s.undone) continue;
    const k = s.turnSeq ?? -Infinity;
    if (k > maxRedoTurn) return [];
  }

  return redoRecords.filter((r) => r.turnSeq === nextRedoTurn);
}
