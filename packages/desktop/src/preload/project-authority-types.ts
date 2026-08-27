import type { SessionWorkspace } from "@cjhyy/code-shell-core";
import type {
  ReviewGitCommit,
  ReviewGitDiffRequest,
  ReviewGitDiffResult,
  ReviewGitStatusResult,
} from "../shared/review";
import type {
  GitBranches,
  GitStatus,
  SessionWorkspaceList,
  Unsubscribe,
  WorktreeDiffSummary,
  WorkspaceProfileSummary,
} from "./types";

export interface SessionWorkspaceAuthority {
  workspace: SessionWorkspace;
  projectId: string | null;
  mainRootId: string | null;
  mainRoot: string;
  mainRootName: string;
  rootStatus: "ok" | "dir_missing" | "root_removed" | "root_replaced";
  rootStatusReason?:
    | "directory_missing"
    | "project_missing"
    | "root_not_mounted"
    | "identity_mismatch";
  rootStatusMessage?: string;
}

export type WorkspaceReleaseResult =
  | { sessionId: string; ok: true; status: "released"; workspace: SessionWorkspace }
  | { sessionId: string; ok: true; status: "missing"; reason: string }
  | { sessionId: string; ok: false; status: "error"; error: string };

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FileContent {
  path: string;
  text: string | null;
  reason?: "too-large" | "binary";
  size: number;
}

export interface LocalProjectRoot {
  id: string;
  path: string;
  canonicalIdentity?: string;
  name: string;
  addedAt: number;
}

export interface LocalProject {
  id: string;
  name: string;
  displayName?: string;
  roots: LocalProjectRoot[];
  primaryRootId: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  deletedAt?: number;
  revision: number;
}

export type ProjectResolveSource = "disk-rebuild" | "automation-import" | "live";
export type ProjectCwdResolution =
  | { projectId: string; rootId: string; created: boolean }
  | { noRepo: true }
  | null;

export interface ProjectAuthorityApi {
  getProjectGitStatus(projectId: string): Promise<GitStatus>;
  getProjectGitBranches(projectId: string): Promise<GitBranches>;
  switchProjectGitBranch(projectId: string, branch: string): Promise<GitBranches>;
  stashAndSwitchProjectGitBranch(projectId: string, branch: string): Promise<GitBranches>;
  getSessionWorkspace(sessionId: string, cwd: string): Promise<SessionWorkspace>;
  getSessionWorkspaceAuthority(sessionId: string): Promise<SessionWorkspaceAuthority>;
  getSessionGitStatus(sessionId: string): Promise<GitStatus>;
  getSessionGitBranches(sessionId: string): Promise<GitBranches>;
  getReviewStatus(sessionId: string): Promise<ReviewGitStatusResult>;
  getReviewDiff(sessionId: string, request: ReviewGitDiffRequest): Promise<ReviewGitDiffResult>;
  getReviewRecentCommits(sessionId: string, limit?: number): Promise<ReviewGitCommit[]>;
  listSessionProfiles(sessionId: string): Promise<WorkspaceProfileSummary[]>;
  listSessionWorktrees(sessionId: string, cwd: string): Promise<SessionWorkspaceList>;
  getSessionWorktreeDiff(sessionId: string, worktreePath: string): Promise<WorktreeDiffSummary>;
  switchSessionWorkspace(
    sessionId: string,
    cwd: string,
    target: string,
  ): Promise<SessionWorkspaceList>;
  releaseSessionWorkspace(sessionId: string): Promise<WorkspaceReleaseResult>;
  releaseManySessionWorkspaces(sessionIds: string[]): Promise<WorkspaceReleaseResult[]>;
  onWorkspaceChanged(
    cb: (event: { sessionId: string; workspace?: SessionWorkspace; mainRoot?: string }) => void,
  ): Unsubscribe;
  cleanupSessionWorktree(
    sessionId: string,
    cwd: string,
    worktreePath: string,
    action: "detach" | "discard",
  ): Promise<SessionWorkspaceList>;
  projectRegistry: {
    list(): Promise<LocalProject[]>;
    sessionMainRoots(projectId: string): Promise<Record<string, string[]>>;
    createFromPicker(): Promise<LocalProject | null>;
    addRootFromPicker(
      projectId: string,
    ): Promise<{ project: LocalProject; folded?: { picked: string; root: string } } | null>;
    removeRoot(projectId: string, rootId: string): Promise<LocalProject>;
    migrateSessionMainRoot(
      sessionId: string,
      targetRootId: string,
    ): Promise<{
      sessionId: string;
      projectId: string;
      previousMainRootId: string;
      targetRootId: string;
      mainRoot: string;
      workspace: SessionWorkspace;
    }>;
    setPrimary(projectId: string, rootId: string): Promise<LocalProject>;
    revealRoot(projectId: string, rootId: string): Promise<void>;
    openRoot(projectId: string, rootId: string): Promise<string>;
    rename(projectId: string, name: string): Promise<LocalProject>;
    setPinned(projectId: string, pinned: boolean): Promise<LocalProject>;
    remove(projectId: string): Promise<void>;
    resolveForCwd(cwd: string, source: ProjectResolveSource): Promise<ProjectCwdResolution>;
    resolveForCwdBatch(
      cwds: string[],
      source: ProjectResolveSource,
    ): Promise<ProjectCwdResolution[]>;
    beginLegacyMigration(paths: string[]): Promise<{ completed: boolean; token?: string }>;
    authorizeLegacyMigration(
      token: string,
      path: string,
    ): Promise<{
      path: string;
      status: "migrated" | "reauthorization_required" | "failed";
      project?: LocalProject;
      error?: string;
    }>;
    completeLegacyMigration(token: string): Promise<void>;
    onChanged(cb: (projects: LocalProject[]) => void): Unsubscribe;
  };
  readProjectDir(projectId: string, rootId: string, dir?: string): Promise<FsEntry[]>;
  readProjectFileContent(projectId: string, rootId: string, path: string): Promise<FileContent>;
  projectFileExists(projectId: string, rootId: string, path: string): Promise<boolean>;
  readSessionDir(sessionId: string, rootId: string, dir?: string): Promise<FsEntry[]>;
  readSessionFileContent(sessionId: string, rootId: string, path: string): Promise<FileContent>;
  sessionFileExists(sessionId: string, rootId: string, path: string): Promise<boolean>;
}
