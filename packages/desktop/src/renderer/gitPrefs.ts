/**
 * Electron-local Git preferences.
 *
 * Client-side preferences for how the desktop app drives Git. Not part
 * of the per-project / per-user settings.json the core engine reads —
 * stored in localStorage, same pattern as uiLanguage.ts.
 */

export interface GitPrefs {
  /** Prefix prepended to branch names when codeshell creates a worktree. */
  branchPrefix: string;
  /** Background cleanup of stale worktrees under .worktrees/. */
  autoDeleteWorktrees: boolean;
  /**
   * Worktrees with mtime older than this many minutes get removed when
   * autoDeleteWorktrees is on. The user-facing label is "分钟".
   */
  autoDeleteWorktreesGraceMins: number;
}

const KEY = "codeshell.gitPrefs";

export const DEFAULT_GIT_PREFS: GitPrefs = {
  branchPrefix: "codeshell/",
  autoDeleteWorktrees: true,
  autoDeleteWorktreesGraceMins: 60 * 24 * 7, // one week
};

export function loadGitPrefs(): GitPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_GIT_PREFS };
    const parsed = JSON.parse(raw) as Partial<GitPrefs> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_GIT_PREFS };
    const grace = Number(parsed.autoDeleteWorktreesGraceMins);
    return {
      branchPrefix:
        typeof parsed.branchPrefix === "string" && parsed.branchPrefix.trim()
          ? parsed.branchPrefix
          : DEFAULT_GIT_PREFS.branchPrefix,
      autoDeleteWorktrees: parsed.autoDeleteWorktrees !== false,
      autoDeleteWorktreesGraceMins:
        Number.isFinite(grace) && grace > 0
          ? Math.floor(grace)
          : DEFAULT_GIT_PREFS.autoDeleteWorktreesGraceMins,
    };
  } catch {
    return { ...DEFAULT_GIT_PREFS };
  }
}

export function saveGitPrefs(prefs: GitPrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
  window.dispatchEvent(new Event("codeshell:git-prefs-changed"));
}

/**
 * Normalize a branch prefix: trim, allow only [a-zA-Z0-9._/-], ensure
 * trailing slash. Returns the default if the input is unusable.
 * Pure — safe to call from main or renderer.
 */
export function normalizeBranchPrefix(input: string | null | undefined): string {
  const raw = (input ?? "").trim();
  if (!raw) return DEFAULT_GIT_PREFS.branchPrefix;
  const cleaned = raw.replace(/[^a-zA-Z0-9._/-]/g, "");
  if (!cleaned) return DEFAULT_GIT_PREFS.branchPrefix;
  return cleaned.endsWith("/") ? cleaned : cleaned + "/";
}
