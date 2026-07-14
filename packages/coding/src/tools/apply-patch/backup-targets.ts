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
