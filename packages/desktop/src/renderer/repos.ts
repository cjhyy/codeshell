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
