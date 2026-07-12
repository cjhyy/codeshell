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
import type { TrackedProject } from "./projects";

/** @deprecated Project semantics; use TrackedProject from projects.ts. */
export type Repo = TrackedProject;

const REPOS_KEY = "codeshell.repos";
const ACTIVE_KEY = "codeshell.activeRepoId";
const REMOVED_PATHS_KEY = "codeshell.removedRepoPaths";

/** @deprecated Project semantics; use loadProjects from projects.ts. */
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

/** @deprecated Project semantics; use saveProjects from projects.ts. */
export function saveRepos(repos: Repo[]): void {
  try {
    localStorage.setItem(REPOS_KEY, JSON.stringify(repos));
  } catch {
    // Quota / disabled storage — best effort.
  }
}

/** @deprecated Project semantics; use loadActiveProjectId from projects.ts. */
export function loadActiveRepoId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

/** @deprecated Project semantics; use saveActiveProjectId from projects.ts. */
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

/** @deprecated Project semantics; use loadRemovedProjectPaths from projects.ts. */
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

/** @deprecated Project semantics; use saveRemovedProjectPaths from projects.ts. */
export function saveRemovedRepoPaths(paths: string[]): void {
  try {
    const normalized = paths.map(normalizeRepoPath).filter(Boolean);
    localStorage.setItem(REMOVED_PATHS_KEY, JSON.stringify([...new Set(normalized)]));
  } catch {
    // best effort
  }
}

/** @deprecated Project semantics; use isProjectPathRemoved from projects.ts. */
export function isRepoPathRemoved(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return loadRemovedRepoPaths().includes(normalized);
}

/** @deprecated Project semantics; use markProjectPathRemoved from projects.ts. */
export function markRepoPathRemoved(path: string): void {
  const normalized = normalizeRepoPath(path);
  if (!normalized) return;
  saveRemovedRepoPaths([...loadRemovedRepoPaths(), normalized]);
}

/** @deprecated Project semantics; use unmarkProjectPathRemoved from projects.ts. */
export function unmarkRepoPathRemoved(path: string): void {
  const normalized = normalizeRepoPath(path);
  if (!normalized) return;
  saveRemovedRepoPaths(loadRemovedRepoPaths().filter((p) => p !== normalized));
}

/** Reasonably-unique id without pulling in nanoid. */
/** @deprecated Project semantics; use makeProjectId from projects.ts. */
export function makeRepoId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Factory for the `createRepoForCwd` callback that the disk-rebuild / run-import
 * helpers (importAutomationRuns, planDiskRebuild) call when a session's cwd
 * doesn't match any known repo. Collapses five identical inline closures in
 * App.tsx into one place.
 *
 * Mutates `repoList` in place (pushes the new repo) and persists via saveRepos,
 * matching the prior inline behavior. Skips creation for paths the user has
 * removed (returns null → the helper drops that session). `changed()` reports
 * whether any repo was added, so the caller knows to refresh React state.
 */
/** @deprecated Project semantics; use makeCreateProjectForCwd from projects.ts. */
export function makeCreateRepoForCwd(repoList: Repo[]): {
  createRepoForCwd: (cwd: string) => string | null;
  changed: () => boolean;
} {
  let didChange = false;
  // Snapshot the removed-path denylist ONCE, hoisted out of the per-cwd loop.
  // The five inline closures this replaces each called isRepoPathRemoved(cwd)
  // — which re-reads + JSON.parses localStorage every call — for every session
  // in a disk-rebuild batch. Reads happen within one synchronous import pass,
  // so a single snapshot is correct (the denylist doesn't change mid-import).
  const removedSet = new Set(loadRemovedRepoPaths());
  return {
    createRepoForCwd: (cwd: string): string | null => {
      if (removedSet.has(normalizeRepoPath(cwd))) return null;
      const id = makeRepoId();
      const name = cwd.split("/").filter(Boolean).pop() || cwd;
      const repo: Repo = { id, name, path: cwd, addedAt: Date.now() };
      repoList.push(repo);
      saveRepos(repoList);
      didChange = true;
      return id;
    },
    changed: () => didChange,
  };
}

/** @deprecated Project semantics; use ReconciledProjects from projects.ts. */
export interface ReconciledRepos {
  repos: Repo[];
  repoIdRemap: Record<string, string>;
}

/**
 * Reconcile the disk project list (source of truth for the project SET + pinned)
 * with the localStorage repo cache (source of the stable random repoId per path).
 *
 * Disk decides which projects exist and their pinned state; the cache supplies
 * each known path's existing repoId so session buckets (keyed by repoId) stay
 * intact across reloads. A disk path not in the cache gets a fresh repoId minted
 * once. Cache entries whose path is no longer on disk are dropped (the project
 * was removed/soft-deleted elsewhere). User renames (displayName) are preserved
 * from the cache since they're device-local and not synced to disk.
 */
/** @deprecated Project semantics; use reconcileProjectsFromDisk from projects.ts. */
export function reconcileReposFromDisk(
  diskProjects: Array<{ path: string; name: string; addedAt?: number; pinned?: boolean }>,
  cached: Repo[],
): Repo[] {
  return reconcileReposFromDiskWithRemap(diskProjects, cached).repos;
}

/** @deprecated Project semantics; use reconcileProjectsFromDiskWithRemap from projects.ts. */
export function reconcileReposFromDiskWithRemap(
  diskProjects: Array<{ path: string; name: string; addedAt?: number; pinned?: boolean }>,
  cached: Repo[],
): ReconciledRepos {
  const byPath = new Map(cached.map((r) => [r.path, r]));
  const repos = diskProjects.map((p) => {
    const prior = byPath.get(p.path);
    return {
      id: prior?.id ?? makeRepoId(),
      name: p.name,
      path: p.path,
      addedAt: p.addedAt ?? prior?.addedAt ?? Date.now(),
      displayName: prior?.displayName,
      pinned: p.pinned,
    };
  });
  const targetByPath = new Map(repos.map((r) => [r.path, r]));
  const repoIdRemap: Record<string, string> = {};
  for (const r of cached) {
    const target = targetByPath.get(r.path);
    if (target && target.id !== r.id) repoIdRemap[r.id] = target.id;
  }
  return { repos, repoIdRemap };
}

/** Display label for a repo — user rename wins over default basename. */
/** @deprecated Project semantics; use projectLabel from projects.ts. */
export function repoLabel(repo: Repo): string {
  return repo.displayName?.trim() || repo.name;
}

/**
 * Sort: pinned first (by addedAt asc, oldest pin on top), then unpinned
 * by recency of activity (caller may pre-bump addedAt or pass an order
 * derived from session updatedAt). Stable for the default case where
 * nothing changed.
 */
/** @deprecated Project semantics; use sortProjects from projects.ts. */
export function sortRepos(repos: Repo[]): Repo[] {
  return [...repos].sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return a.addedAt - b.addedAt;
  });
}
