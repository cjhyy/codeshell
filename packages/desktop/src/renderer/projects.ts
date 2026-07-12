/**
 * Canonical renderer terminology for user-tracked projects.
 *
 * Persistence deliberately remains implemented by the legacy `repos.ts`
 * module for this compatibility phase. In particular, these exports keep
 * reading and writing the existing `codeshell.repos`,
 * `codeshell.activeRepoId`, and `codeshell.removedRepoPaths` contracts.
 */
import {
  isRepoPathRemoved,
  loadActiveRepoId,
  loadRemovedRepoPaths,
  loadRepos,
  makeCreateRepoForCwd,
  makeRepoId,
  markRepoPathRemoved,
  reconcileReposFromDisk,
  reconcileReposFromDiskWithRemap,
  repoLabel,
  saveActiveRepoId,
  saveRemovedRepoPaths,
  saveRepos,
  sortRepos,
  unmarkRepoPathRemoved,
  type Repo,
} from "./repos";

export type ProjectId = string;

/** Canonical renderer model for a project tracked in the sidebar. */
export interface TrackedProject {
  /** Stable project id. Persisted as the legacy `id` JSON field for compatibility. */
  id: ProjectId;
  /** Default name derived from the path basename when first added. */
  name: string;
  /** Absolute canonical project path. */
  path: string;
  addedAt: number;
  /** User-set rename, which wins over `name` in project UI. */
  displayName?: string;
  /** Pinned projects render before unpinned projects. */
  pinned?: boolean;
}

export interface ReconciledProjects {
  projects: TrackedProject[];
  projectIdRemap: Record<ProjectId, ProjectId>;
}

/** Convert a value read through the legacy Repo API into the canonical project model. */
export function adaptLegacyRepo(repo: Repo): TrackedProject {
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    addedAt: repo.addedAt,
    displayName: repo.displayName,
    pinned: repo.pinned,
  };
}

export const loadProjects = loadRepos;
export const saveProjects = saveRepos;
export const loadActiveProjectId = loadActiveRepoId;
export const saveActiveProjectId = saveActiveRepoId;
export const loadRemovedProjectPaths = loadRemovedRepoPaths;
export const saveRemovedProjectPaths = saveRemovedRepoPaths;
export const isProjectPathRemoved = isRepoPathRemoved;
export const markProjectPathRemoved = markRepoPathRemoved;
export const unmarkProjectPathRemoved = unmarkRepoPathRemoved;
export const makeProjectId = makeRepoId;
export const reconcileProjectsFromDisk = reconcileReposFromDisk;
export const projectLabel = repoLabel;
export const sortProjects = sortRepos;

export function makeCreateProjectForCwd(projectList: TrackedProject[]): {
  createProjectForCwd: (cwd: string) => ProjectId | null;
  changed: () => boolean;
} {
  const legacy = makeCreateRepoForCwd(projectList);
  return {
    createProjectForCwd: legacy.createRepoForCwd,
    changed: legacy.changed,
  };
}

export function reconcileProjectsFromDiskWithRemap(
  diskProjects: Array<{ path: string; name: string; addedAt?: number; pinned?: boolean }>,
  cached: TrackedProject[],
): ReconciledProjects {
  const legacy = reconcileReposFromDiskWithRemap(diskProjects, cached);
  return {
    projects: legacy.repos,
    projectIdRemap: legacy.repoIdRemap,
  };
}
