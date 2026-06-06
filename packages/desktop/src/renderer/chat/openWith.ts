/**
 * Shared "open with" actions for a file reference. Centralizes the three ways
 * the desktop app opens a path so file cards, diffs, the file panel, and
 * assistant file links all behave identically (TODO 2.2/2.3). Thin wrappers
 * over `window.codeshell.*` — kept in one place so callers don't each
 * re-implement the openPath / revealInFinder / openInEditor calls.
 */

export interface OpenTarget {
  /** File path — absolute, or relative to `cwd`. May carry a `:line` suffix. */
  path: string;
  /** Workspace dir used to resolve a relative path. */
  cwd?: string | null;
}

/** Open in the OS default application. */
export function openDefault(t: OpenTarget): Promise<string> {
  return window.codeshell.openPath(t.path, t.cwd ?? undefined);
}

/** Reveal the file in Finder / Explorer. */
export async function revealInFolder(t: OpenTarget): Promise<void> {
  // openPath resolves the absolute path (and strips any :line); reveal that so
  // a relative path or one with a line suffix still lands on the right file.
  const abs = await window.codeshell.openPath(t.path, t.cwd ?? undefined);
  await window.codeshell.revealInFinder(abs);
}

/**
 * Open in the configured external editor. Resolves to the editor command, or
 * falls back to the OS "open" when no editor is on PATH (so the action never
 * silently no-ops).
 */
export async function openInEditor(t: OpenTarget): Promise<void> {
  try {
    await window.codeshell.openInEditor(t.path, t.cwd ?? undefined);
  } catch {
    await openDefault(t);
  }
}
