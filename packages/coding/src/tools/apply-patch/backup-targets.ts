/**
 * Coding capability files an ApplyPatch would modify-in-place or delete — i.e. the files
 * that already exist and therefore have pre-patch content worth snapshotting
 * for /undo. Pure (parse-only, no fs): given the patch text and the cwd to
 * resolve relative paths against, return absolute target paths.
 *
 * "add" hunks are excluded: a newly-created file has no prior content to back
 * up (undo of an add = delete, handled separately if/when /undo grows that).
 */

import { resolve as resolvePath } from "node:path";
import { parsePatch } from "./parser.js";

export function patchBackupTargets(patchText: string, cwd: string): string[] {
  let parsed;
  try {
    parsed = parsePatch(patchText, "lenient");
  } catch {
    // Unparseable patch → nothing to back up; the tool itself will reject it.
    return [];
  }
  const out: string[] = [];
  for (const hunk of parsed.hunks) {
    if (hunk.kind === "update" || hunk.kind === "delete") {
      out.push(resolvePath(cwd, hunk.path));
    }
  }
  // De-dupe while preserving order (a patch shouldn't target one file twice,
  // but be defensive — saveSnapshot is idempotent on identical content anyway).
  return [...new Set(out)];
}

/**
 * Every filesystem destination an ApplyPatch can change. Unlike undo backup
 * targets, turn diffs need absent paths too: additions and move destinations
 * must be captured before execution to distinguish creation from overwrite.
 * Moves are represented by their source and destination; the tracker compares
 * each path's real before/after state rather than inferring a rename from text.
 */
export function patchDiffTargets(patchText: string, cwd: string): string[] {
  let parsed;
  try {
    parsed = parsePatch(patchText, "lenient");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const hunk of parsed.hunks) {
    out.push(resolvePath(cwd, hunk.path));
    if (hunk.kind === "update" && hunk.movePath) {
      out.push(resolvePath(cwd, hunk.movePath));
    }
  }
  return [...new Set(out)];
}
