/**
 * Persisted repo list — the sidebar's "项目" section.
 *
 * Storage: localStorage key "codeshell.repos" → JSON of Repo[].
 * Active repo selection: localStorage key "codeshell.activeRepoId" → string | null.
 *
 * Why localStorage and not Electron's `app.getPath('userData')` / file:
 *   - The list is renderer-owned UI state. Going through ipc on every read
 *     would be a needless round-trip. If a future feature needs the list
 *     from main (e.g. dock menu listing recent projects), we promote then.
 */

export interface Repo {
  id: string;
  name: string;
  path: string;
  addedAt: number;
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
