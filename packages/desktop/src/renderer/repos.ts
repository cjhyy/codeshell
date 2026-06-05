/**
 * Persisted repo list — the sidebar's "项目" section.
 *
 * Storage: localStorage key "codeshell.repos" → JSON of Repo[].
 * Active repo selection: localStorage key "codeshell.activeRepoId" → string | null.
 *
 * Active repo == null means "no project" — the chat operates without
 * a cwd and any sessions created live under the sidebar-bottom
 * `对话` section (NO_REPO_KEY bucket in transcripts.ts).
 */

import { isCaseInsensitivePlatform, normalizeCwd } from "./automation/pathMatch";

export interface Repo {
  id: string;
  /** Default name derived from path basename when first added. */
  name: string;
  /** Absolute project path. */
  path: string;
  addedAt: number;
  /** User-set rename — overrides `name` in the sidebar when present. */
  displayName?: string;
  /** Pinned projects render before unpinned in the sidebar. */
  pinned?: boolean;
}

const REPOS_KEY = "codeshell.repos";
const ACTIVE_KEY = "codeshell.activeRepoId";
const REMOVED_PATHS_KEY = "codeshell.removedRepoPaths";

export function loadRepos(): Repo[] {
  try {
    const raw = localStorage.getItem(REPOS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as Repo[]).filter(
      (r): r is Repo =>
        typeof r?.id === "string" &&
        typeof r?.name === "string" &&
        typeof r?.path === "string" &&
        typeof r?.addedAt === "number",
    );
  } catch {
    return [];
  }
}

export function saveRepos(repos: Repo[]): void {
  try {
    localStorage.setItem(REPOS_KEY, JSON.stringify(repos));
  } catch {
    // Quota / disabled storage — best effort.
  }
}

export function loadActiveRepoId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveRepoId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // best effort
  }
}

function normalizeRepoPath(path: string): string {
  // Reuse the canonical cwd→repo matcher's normalization so the removed-path
  // denylist agrees with matchRepoIdForCwd: strip trailing slashes, keep a
  // lone "/", and lowercase on case-insensitive platforms (macOS/Windows).
  // Without this, a repo removed as /Users/Me/Proj wouldn't match an
  // auto-create for /users/me/proj and would silently resurrect.
  //
  // Empty input stays empty (callers drop it via `!path` / filter(Boolean)) —
  // we must NOT let normalizeCwd turn "" into "/" and persist a bogus
  // "root removed" entry.
  const trimmed = path.trim();
  if (!trimmed) return "";
  return normalizeCwd(trimmed, isCaseInsensitivePlatform());
}

export function loadRemovedRepoPaths(): string[] {
  try {
    const raw = localStorage.getItem(REMOVED_PATHS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const path = normalizeRepoPath(item);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  } catch {
    return [];
  }
}

export function saveRemovedRepoPaths(paths: string[]): void {
  try {
    const normalized = paths.map(normalizeRepoPath).filter(Boolean);
    localStorage.setItem(REMOVED_PATHS_KEY, JSON.stringify([...new Set(normalized)]));
  } catch {
    // best effort
  }
}

export function isRepoPathRemoved(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return loadRemovedRepoPaths().includes(normalized);
}

export function markRepoPathRemoved(path: string): void {
  const normalized = normalizeRepoPath(path);
  if (!normalized) return;
  saveRemovedRepoPaths([...loadRemovedRepoPaths(), normalized]);
}

export function unmarkRepoPathRemoved(path: string): void {
  const normalized = normalizeRepoPath(path);
  if (!normalized) return;
  saveRemovedRepoPaths(loadRemovedRepoPaths().filter((p) => p !== normalized));
}

/** Reasonably-unique id without pulling in nanoid. */
export function makeRepoId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Display label for a repo — user rename wins over default basename. */
export function repoLabel(repo: Repo): string {
  return repo.displayName?.trim() || repo.name;
}

/**
 * Sort: pinned first (by addedAt asc, oldest pin on top), then unpinned
 * by recency of activity (caller may pre-bump addedAt or pass an order
 * derived from session updatedAt). Stable for the default case where
 * nothing changed.
 */
export function sortRepos(repos: Repo[]): Repo[] {
  return [...repos].sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return a.addedAt - b.addedAt;
  });
}
