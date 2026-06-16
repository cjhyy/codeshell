/**
 * Directory containing a skill's SKILL.md — used as the `cwd` when rendering
 * the skill body, so relative links in the doc (e.g. `references/codex-tools.md`)
 * resolve against the SKILL's own folder rather than the active project. Without
 * this, mentions like `references/copilot-tools.md` / `GEMINI.md` in the doc
 * body get resolved against the current repo and 404 (and dead-link existence
 * checks misfire). Returns null when the path has no directory component.
 */
export function skillBaseDir(filePath: string): string | null {
  if (!filePath) return null;
  // Drop a defensive trailing slash, then strip the final `/segment`.
  const trimmed = filePath.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return null; // no directory (bare filename) or root-only
  return trimmed.slice(0, idx);
}
