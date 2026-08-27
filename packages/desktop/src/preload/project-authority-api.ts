import type { IpcRenderer, IpcRendererEvent } from "electron";
import type {
  ReviewGitCommit,
  ReviewGitDiffRequest,
  ReviewGitDiffResult,
  ReviewGitStatusResult,
} from "../shared/review";

type ProjectAuthorityIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

/** Renderer-safe transport for project registry and Session workspace authority. */
export function createProjectAuthorityApi(ipcRenderer: ProjectAuthorityIpcRenderer) {
  return {
    getProjectGitStatus: (projectId: string) => ipcRenderer.invoke("git:projectStatus", projectId),
    getProjectGitBranches: (projectId: string) =>
      ipcRenderer.invoke("git:projectBranches", projectId),
    switchProjectGitBranch: (projectId: string, branch: string) =>
      ipcRenderer.invoke("git:projectSwitchBranch", projectId, branch),
    stashAndSwitchProjectGitBranch: (projectId: string, branch: string) =>
      ipcRenderer.invoke("git:projectStashAndSwitchBranch", projectId, branch),
    getSessionWorkspace: (sessionId: string, cwd: string) =>
      ipcRenderer.invoke("workspace:current", sessionId, cwd),
    getSessionWorkspaceAuthority: (sessionId: string) =>
      ipcRenderer.invoke("workspace:authority", sessionId),
    getSessionGitStatus: (sessionId: string) =>
      ipcRenderer.invoke("workspace:gitStatus", sessionId),
    getSessionGitBranches: (sessionId: string) =>
      ipcRenderer.invoke("workspace:gitBranches", sessionId),
    getReviewStatus: (sessionId: string) =>
      ipcRenderer.invoke("review:status", sessionId) as Promise<ReviewGitStatusResult>,
    getReviewDiff: (sessionId: string, request: ReviewGitDiffRequest) =>
      ipcRenderer.invoke("review:diff", sessionId, request) as Promise<ReviewGitDiffResult>,
    getReviewRecentCommits: (sessionId: string, limit?: number) =>
      ipcRenderer.invoke("review:recentCommits", sessionId, limit) as Promise<ReviewGitCommit[]>,
    listSessionProfiles: (sessionId: string) => ipcRenderer.invoke("workspace:profiles", sessionId),
    listSessionWorktrees: (sessionId: string, cwd: string) =>
      ipcRenderer.invoke("workspace:list", sessionId, cwd),
    getSessionWorktreeDiff: (sessionId: string, worktreePath: string) =>
      ipcRenderer.invoke("workspace:diff", sessionId, worktreePath),
    switchSessionWorkspace: (sessionId: string, cwd: string, target: string) =>
      ipcRenderer.invoke("workspace:switch", sessionId, cwd, target),
    releaseSessionWorkspace: (sessionId: string) =>
      ipcRenderer.invoke("workspace:release", sessionId),
    releaseManySessionWorkspaces: (sessionIds: string[]) =>
      ipcRenderer.invoke("workspace:releaseMany", sessionIds),
    onWorkspaceChanged: (
      cb: (event: { sessionId: string; workspace?: unknown; mainRoot?: string }) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        event: { sessionId: string; workspace?: unknown; mainRoot?: string },
      ) => cb(event);
      ipcRenderer.on("workspace:changed", handler);
      return () => ipcRenderer.removeListener("workspace:changed", handler);
    },
    cleanupSessionWorktree: (
      sessionId: string,
      cwd: string,
      worktreePath: string,
      action: "detach" | "discard",
    ) => ipcRenderer.invoke("workspace:cleanup", sessionId, cwd, worktreePath, action),
    projectRegistry: {
      list: () => ipcRenderer.invoke("projectRegistry:list"),
      sessionMainRoots: (projectId: string) =>
        ipcRenderer.invoke("projectRegistry:sessionMainRoots", projectId),
      createFromPicker: () => ipcRenderer.invoke("projectRegistry:createFromPicker"),
      addRootFromPicker: (projectId: string) =>
        ipcRenderer.invoke("projectRegistry:addRootFromPicker", projectId),
      removeRoot: (projectId: string, rootId: string) =>
        ipcRenderer.invoke("projectRegistry:removeRoot", projectId, rootId),
      migrateSessionMainRoot: (sessionId: string, targetRootId: string) =>
        ipcRenderer.invoke("projectRegistry:migrateSessionMainRoot", sessionId, targetRootId),
      setPrimary: (projectId: string, rootId: string) =>
        ipcRenderer.invoke("projectRegistry:setPrimary", projectId, rootId),
      revealRoot: (projectId: string, rootId: string) =>
        ipcRenderer.invoke("projectRegistry:revealRoot", projectId, rootId),
      openRoot: (projectId: string, rootId: string) =>
        ipcRenderer.invoke("projectRegistry:openRoot", projectId, rootId),
      rename: (projectId: string, name: string) =>
        ipcRenderer.invoke("projectRegistry:rename", projectId, name),
      setPinned: (projectId: string, pinned: boolean) =>
        ipcRenderer.invoke("projectRegistry:setPinned", projectId, pinned),
      remove: (projectId: string) => ipcRenderer.invoke("projectRegistry:remove", projectId),
      resolveForCwd: (cwd: string, source: "disk-rebuild" | "automation-import" | "live") =>
        ipcRenderer.invoke("projectRegistry:resolveForCwd", cwd, source),
      resolveForCwdBatch: (cwds: string[], source: "disk-rebuild" | "automation-import" | "live") =>
        ipcRenderer.invoke("projectRegistry:resolveForCwdBatch", cwds, source),
      beginLegacyMigration: (paths: string[]) =>
        ipcRenderer.invoke("projectRegistry:beginLegacyMigration", paths),
      authorizeLegacyMigration: (token: string, path: string) =>
        ipcRenderer.invoke("projectRegistry:authorizeLegacyMigration", token, path),
      completeLegacyMigration: (token: string) =>
        ipcRenderer.invoke("projectRegistry:completeLegacyMigration", token),
      onChanged: (cb: (projects: unknown[]) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, projects: unknown[]) => cb(projects);
        ipcRenderer.on("projectRegistry:changed", handler);
        return () => ipcRenderer.removeListener("projectRegistry:changed", handler);
      },
    },
    readProjectDir: (projectId: string, rootId: string, dir?: string) =>
      ipcRenderer.invoke("fsRoot:readDir", projectId, rootId, dir),
    readProjectFileContent: (projectId: string, rootId: string, path: string) =>
      ipcRenderer.invoke("fsRoot:readFile", projectId, rootId, path),
    projectFileExists: (projectId: string, rootId: string, path: string) =>
      ipcRenderer.invoke("fsRoot:exists", projectId, rootId, path),
    readSessionDir: (sessionId: string, rootId: string, dir?: string) =>
      ipcRenderer.invoke("fsSession:readDir", sessionId, rootId, dir),
    readSessionFileContent: (sessionId: string, rootId: string, path: string) =>
      ipcRenderer.invoke("fsSession:readFile", sessionId, rootId, path),
    sessionFileExists: (sessionId: string, rootId: string, path: string) =>
      ipcRenderer.invoke("fsSession:exists", sessionId, rootId, path),
  };
}
