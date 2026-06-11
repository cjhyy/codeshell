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

/**
 * Open in the in-app Files panel (App listens for `codeshell:open-file`,
 * surfaces the dock + Files panel, and reveals the file). This is the default
 * for a plain click on any file reference — assistant links, file-change card
 * rows, etc. — so clicking a path stays inside the app instead of handing off
 * to the OS default app. The `:line` suffix is preserved for the panel.
 */
export function openInternalPanel(t: OpenTarget): void {
  window.dispatchEvent(
    new CustomEvent("codeshell:open-file", {
      detail: { path: t.path, cwd: t.cwd ?? null },
    }),
  );
}

/**
 * Click contract shared by every clickable file reference: a plain click opens
 * the in-app Files panel; ⌘/Ctrl-click escapes to the OS default app. Used by
 * assistant path links (Markdown) and file-change card rows so they behave
 * identically (#13). `isScheme` skips passing cwd for `codeshell-path:` links,
 * whose relative paths are resolved in main.
 */
export function openFileTarget(
  e: { metaKey: boolean; ctrlKey: boolean; preventDefault(): void },
  opts: { path: string; cwd?: string | null; line?: number; isScheme?: boolean },
): void {
  e.preventDefault();
  const { path, cwd, line, isScheme } = opts;
  if (e.metaKey || e.ctrlKey) {
    const arg = line ? `${path}:${line}` : path;
    void openDefault({ path: arg, cwd: isScheme ? undefined : cwd });
  } else {
    openInternalPanel({ path, cwd });
  }
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
