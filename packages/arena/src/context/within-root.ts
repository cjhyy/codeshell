import * as path from "node:path";

/**
 * True when `target` is the root itself or a descendant of it. Uses the
 * platform separator (the old check hardcoded "/", which broke on Windows)
 * and avoids the sibling-prefix trap (/repo vs /repo-evil). Both inputs are
 * assumed already resolved to absolute paths.
 */
export function isWithinRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  // Outside the root iff the relative path climbs out ("..") or is absolute
  // (different drive on Windows).
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
