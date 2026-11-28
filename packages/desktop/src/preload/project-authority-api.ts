import type { DesktopHostClient } from "./desktop-host-client.js";
import type { WorkspaceReadContracts } from "../shared/workspace-read-contracts.js";
import type { ExternalGitBlobRef, SessionWorkspace } from "@cjhyy/code-shell-core";
import type { LocalProject } from "./project-authority-types";
import type { IpcRenderer, IpcRendererEvent } from "electron";
import {
  reviewAvailabilityFromStatus,
  type ReviewAiPromptRequest,
  type ReviewGitDiffRequest,
} from "../shared/review";

type ProjectAuthorityIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

/** Renderer-safe transport for project registry and Session workspace authority. */
export function createProjectAuthorityApi(
  ipcRenderer: ProjectAuthorityIpcRenderer,
  listProjects = (fallback: () => Promise<LocalProject[]>) => fallback(),
  host?: Pick<DesktopHostClient, "readBusiness">,
) {
  function read<K extends keyof WorkspaceReadContracts>(
    name: K,
    params: WorkspaceReadContracts[K]["params"],
    fallback?: () => Promise<WorkspaceReadContracts[K]["result"]>,
  ) {
    if (host) return host.readBusiness(name, params, fallback);
    return Promise.reject(new Error("Workspace reads require the workbench Host"));
  }
  return {
    searchProjectFiles: (projectId: string, query: string, rootId?: string) =>
      read("files/searchProject", { projectId, query, rootId }),
    getProjectGitStatus: (projectId: string) => read("git/projectStatus", { projectId }),
    getProjectGitBranches: (projectId: string) => read("git/projectBranches", { projectId }),
    switchProjectGitBranch: (projectId: string, branch: string) =>
      ipcRenderer.invoke("git:projectSwitchBranch", projectId, branch),
    stashAndSwitchProjectGitBranch: (projectId: string, branch: string) =>
      ipcRenderer.invoke("git:projectStashAndSwitchBranch", projectId, branch),
    getSessionWorkspace: (sessionId: string, cwd: string) =>
      ipcRenderer.invoke("workspace:current", sessionId, cwd),
    getSessionWorkspaceAuthority: (sessionId: string) =>
      ipcRenderer.invoke("workspace:authority", sessionId),
    getSessionGitStatus: (sessionId: string) => read("workspace/gitStatus", { sessionId }),
    getSessionGitHead: (sessionId: string) =>
      read("workspace/gitHead", { sessionId }, () => read("workspace/gitBranches", { sessionId })),
    getSessionGitBranches: (sessionId: string) => read("workspace/gitBranches", { sessionId }),
    getReviewAvailability: (sessionId: string) =>
      read("review/availability", { sessionId }, async () =>
        reviewAvailabilityFromStatus(await read("review/status", { sessionId })),
      ),
    getReviewStatus: (sessionId: string) => read("review/status", { sessionId }),
    getReviewDiff: (sessionId: string, request: ReviewGitDiffRequest) =>
      read("review/diff", { sessionId, request }),
    prepareReviewPrompt: (sessionId: string, request: ReviewAiPromptRequest) =>
      read("review/prompt", { sessionId, request }),
    getReviewRecentCommits: (sessionId: string, limit?: number) =>
      read("review/commits", { sessionId, limit }),
    listSessionProfiles: (sessionId: string) => read("workspace/profiles", { sessionId }),
    listSessionWorktrees: (sessionId: string, cwd: string) =>
      read("workspace/list", { sessionId, cwd }),
    getSessionWorktreeDiff: (sessionId: string, worktreePath: string) =>
      read("workspace/diff", { sessionId, worktreePath }),
    switchSessionWorkspace: (sessionId: string, cwd: string, target: string) =>
      ipcRenderer.invoke("workspace:switch", sessionId, cwd, target),
    releaseSessionWorkspace: (sessionId: string) =>
      ipcRenderer.invoke("workspace:release", sessionId),
    releaseManySessionWorkspaces: (sessionIds: string[]) =>
      ipcRenderer.invoke("workspace:releaseMany", sessionIds),
    onWorkspaceChanged: (
      cb: (event: { sessionId: string; workspace?: SessionWorkspace; mainRoot?: string }) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        event: { sessionId: string; workspace?: SessionWorkspace; mainRoot?: string },
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
      list: () => listProjects(() => ipcRenderer.invoke("projectRegistry:list")),
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
      onChanged: (cb: (projects: LocalProject[]) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, projects: LocalProject[]) => cb(projects);
        ipcRenderer.on("projectRegistry:changed", handler);
        return () => ipcRenderer.removeListener("projectRegistry:changed", handler);
      },
    },
    readProjectDir: (projectId: string, rootId: string, dir?: string) =>
      read("files/list", { owner: { projectId }, rootId, dir }),
    readProjectFileContent: (projectId: string, rootId: string, path: string) =>
      read("files/read", { owner: { projectId }, rootId, path }),
    projectFileExists: (projectId: string, rootId: string, path: string) =>
      read("files/exists", { owner: { projectId }, rootId, path }),
    readProjectFileVersion: (projectId: string, rootId: string, ref: ExternalGitBlobRef) =>
      read("files/version", { owner: { projectId }, rootId, ref }),
    readSessionDir: (sessionId: string, rootId: string, dir?: string) =>
      read("files/list", { owner: { sessionId }, rootId, dir }),
    readSessionFileContent: (sessionId: string, rootId: string, path: string) =>
      read("files/read", { owner: { sessionId }, rootId, path }),
    sessionFileExists: (sessionId: string, rootId: string, path: string) =>
      read("files/exists", { owner: { sessionId }, rootId, path }),
    readSessionFileVersion: (sessionId: string, rootId: string, ref: ExternalGitBlobRef) =>
      read("files/version", { owner: { sessionId }, rootId, ref }),
    localFileExists: (absPath: string) => ipcRenderer.invoke("fsLocal:exists", absPath),
    readLocalFilePreview: (absPath: string) => ipcRenderer.invoke("fsLocal:readPreview", absPath),
  };
}
