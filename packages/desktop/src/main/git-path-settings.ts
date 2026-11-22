import { setGitPathOverride } from "@cjhyy/code-shell-core/internal";
import { readSettings } from "./settings-service.js";

/**
 * Push the user's `git.path` setting (if any) into core's git resolver, so
 * marketplace clones / worktrees use the configured binary even when a GUI
 * launch didn't inherit the user's PATH. Re-run after settings change. Reads
 * only the user scope — git location is a machine-level preference.
 */
export async function applyGitPathFromSettings(): Promise<void> {
  try {
    const s = ((await readSettings("user").catch(() => null)) ?? {}) as {
      git?: { path?: unknown };
    };
    const p = typeof s.git?.path === "string" ? s.git.path : null;
    setGitPathOverride(p);
  } catch {
    setGitPathOverride(null);
  }
}
