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
  type ReconciledRepos,
  type Repo,
} from "./repos";

export type ProjectId = string;
export type TrackedProject = Repo;
export type ReconciledProjects = ReconciledRepos;

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
export const makeCreateProjectForCwd = makeCreateRepoForCwd;
export const reconcileProjectsFromDisk = reconcileReposFromDisk;
export const reconcileProjectsFromDiskWithRemap = reconcileReposFromDiskWithRemap;
export const projectLabel = repoLabel;
export const sortProjects = sortRepos;
