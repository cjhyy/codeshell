import type { AgentBridge } from "./agent-bridge.js";
import { createLegacyProjectMigrationService } from "./legacy-project-migration.js";
import type { ProjectStore } from "./project-store.js";
import { requireRendererProjectRoot } from "./renderer-project-path.js";
import {
  cleanupSessionWorktreeForUi,
  getSessionWorktreeDiffForUi,
  getSessionWorkspaceAuthorityForUi,
  getSessionWorkspaceForUi,
  listSessionWorktreesForUi,
  releaseManySessionWorkspacesForUi,
  releaseSessionWorkspaceForUi,
  requireUsableSessionRootAuthority,
  switchSessionWorkspaceForUi,
  type WorkspaceCleanupAction,
} from "./session-workspace-service.js";
import { listProfiles } from "./profiles-service.js";

interface ProjectAuthorityWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload?: unknown): void };
}

export interface ProjectAuthorityIpcDependencies {
  ipcMain: Pick<typeof import("electron").ipcMain, "handle">;
  getAllWindows(): ProjectAuthorityWindow[];
  showOpenDialog(options: {
    title: string;
    properties: Array<"openDirectory" | "createDirectory">;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  applyGitPathFromSettings(): Promise<void>;
  projectStore: ProjectStore;
  getBridge(): AgentBridge | null | undefined;
  getTrust: typeof import("./trust-store.js").getTrust;
  assertSessionId(value: unknown): asserts value is string;
  trackGitRoot(root: string): void;
  broadcastMobileProjects(): Promise<void>;
  getGitStatus: typeof import("./desktop-services.js").getGitStatus;
  getGitBranches: typeof import("./desktop-services.js").getGitBranches;
  revealInFinder: typeof import("./desktop-services.js").revealInFinder;
  openPath: typeof import("./desktop-services.js").openPath;
}

export function registerProjectAuthorityIpc(deps: ProjectAuthorityIpcDependencies): void {
  async function pickProjectDirectory(): Promise<string | null> {
    const result = await deps.showOpenDialog({
      title: "选择项目目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    await deps.applyGitPathFromSettings();
    return result.filePaths[0] ?? null;
  }

  const legacyProjectMigration = createLegacyProjectMigrationService({
    store: deps.projectStore,
    pickDirectory: pickProjectDirectory,
  });

  async function broadcastProjectRegistry(): Promise<void> {
    const projects = await deps.projectStore.list();
    for (const window of deps.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("projectRegistry:changed", projects);
    }
    await deps.broadcastMobileProjects();
  }

  function broadcastWorkspaceChanged(payload: {
    sessionId: string;
    workspace?: unknown;
    mainRoot?: string;
  }): void {
    for (const window of deps.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("workspace:changed", payload);
    }
  }

  deps.ipcMain.handle("projectRegistry:list", async () => deps.projectStore.list());
  deps.ipcMain.handle("projectRegistry:sessionMainRoots", async (_event, projectId: string) =>
    deps.projectStore.sessionMainRoots(projectId),
  );
  deps.ipcMain.handle("projectRegistry:createFromPicker", async () => {
    const picked = await pickProjectDirectory();
    if (!picked) return null;
    const project = await deps.projectStore.createFromPath(picked);
    await broadcastProjectRegistry();
    return project;
  });
  deps.ipcMain.handle("projectRegistry:addRootFromPicker", async (_event, projectId: string) => {
    const picked = await pickProjectDirectory();
    if (!picked) return null;
    const result = await deps.projectStore.addRoot(projectId, picked);
    await broadcastProjectRegistry();
    return result;
  });
  deps.ipcMain.handle(
    "projectRegistry:removeRoot",
    async (_event, projectId: string, rootId: string) => {
      const project = await deps.projectStore.removeRoot(projectId, rootId);
      await broadcastProjectRegistry();
      return project;
    },
  );
  deps.ipcMain.handle(
    "projectRegistry:migrateSessionMainRoot",
    async (_event, sessionId: string, targetRootId: string) => {
      deps.assertSessionId(sessionId);
      if (typeof targetRootId !== "string" || !targetRootId || targetRootId.length > 512) {
        throw new Error("target root id is required");
      }
      const currentBridge = deps.getBridge();
      const migrated = await deps.projectStore.migrateSessionMainRoot(sessionId, targetRootId, {
        owner: currentBridge
          ? {
              migrate: async ({
                sessionId: id,
                projectId,
                mainRootId,
                mainRoot,
                workspaceContext,
              }) =>
                currentBridge.migrateSessionMainRoot(id, { projectId, mainRootId }, mainRoot, {
                  workspaceContext,
                  projectTrusted: (await deps.getTrust(mainRoot)) === "trusted",
                }),
              complete: ({ sessionId: id, ownershipToken }) =>
                currentBridge.completeSessionMainRootMigration(id, ownershipToken),
            }
          : undefined,
      });
      broadcastWorkspaceChanged({
        sessionId,
        workspace: migrated.workspace,
        mainRoot: migrated.mainRoot,
      });
      return migrated;
    },
  );
  deps.ipcMain.handle(
    "projectRegistry:setPrimary",
    async (_event, projectId: string, rootId: string) => {
      const root = await requireRendererProjectRoot(projectId, rootId);
      if ((await deps.getTrust(root.path)) !== "trusted") {
        throw new Error("project root must be trusted before it can become primary");
      }
      const project = await deps.projectStore.setPrimary(projectId, rootId);
      await broadcastProjectRegistry();
      return project;
    },
  );
  deps.ipcMain.handle(
    "projectRegistry:revealRoot",
    async (_event, projectId: string, rootId: string) => {
      const root = await requireRendererProjectRoot(projectId, rootId);
      await deps.revealInFinder(root.path, root.path);
    },
  );
  deps.ipcMain.handle(
    "projectRegistry:openRoot",
    async (_event, projectId: string, rootId: string) => {
      const root = await requireRendererProjectRoot(projectId, rootId);
      return deps.openPath(root.path, root.path);
    },
  );
  deps.ipcMain.handle("projectRegistry:rename", async (_event, projectId: string, name: string) => {
    const project = await deps.projectStore.rename(projectId, name);
    await broadcastProjectRegistry();
    return project;
  });
  deps.ipcMain.handle(
    "projectRegistry:setPinned",
    async (_event, projectId: string, pinned: boolean) => {
      const project = await deps.projectStore.setPinned(projectId, pinned);
      await broadcastProjectRegistry();
      return project;
    },
  );
  deps.ipcMain.handle("projectRegistry:remove", async (_event, projectId: string) => {
    await deps.projectStore.remove(projectId);
    await broadcastProjectRegistry();
  });
  deps.ipcMain.handle(
    "projectRegistry:resolveForCwd",
    async (_event, cwd: string, source: "disk-rebuild" | "automation-import" | "live") => {
      const resolution = await deps.projectStore.resolveProjectForCwd(cwd, source);
      if (resolution && "created" in resolution && resolution.created) {
        await broadcastProjectRegistry();
      }
      return resolution;
    },
  );
  deps.ipcMain.handle(
    "projectRegistry:resolveForCwdBatch",
    async (_event, cwds: string[], source: "disk-rebuild" | "automation-import" | "live") => {
      const resolutions = await deps.projectStore.resolveProjectForCwdBatch(cwds, source);
      if (
        resolutions.some(
          (resolution) => resolution && "created" in resolution && resolution.created,
        )
      ) {
        await broadcastProjectRegistry();
      }
      return resolutions;
    },
  );
  deps.ipcMain.handle("projectRegistry:beginLegacyMigration", async (_event, paths: string[]) =>
    legacyProjectMigration.begin(paths),
  );
  deps.ipcMain.handle(
    "projectRegistry:authorizeLegacyMigration",
    async (_event, token: string, path: string) => {
      const result = await legacyProjectMigration.authorizePath(token, path);
      if (result.status === "migrated") await broadcastProjectRegistry();
      return result;
    },
  );
  deps.ipcMain.handle("projectRegistry:completeLegacyMigration", async (_event, token: string) => {
    await legacyProjectMigration.complete(token);
  });

  deps.ipcMain.handle("workspace:current", async (_event, sessionId: string, cwd: string) => {
    deps.assertSessionId(sessionId);
    if (typeof cwd !== "string" || !cwd) throw new Error("workspace:current requires cwd");
    return getSessionWorkspaceForUi(sessionId, cwd);
  });
  deps.ipcMain.handle("workspace:authority", async (_event, sessionId: string) => {
    deps.assertSessionId(sessionId);
    return getSessionWorkspaceAuthorityForUi(sessionId);
  });
  deps.ipcMain.handle("workspace:gitStatus", async (_event, sessionId: string) => {
    deps.assertSessionId(sessionId);
    const authority = await getSessionWorkspaceAuthorityForUi(sessionId);
    requireUsableSessionRootAuthority(authority);
    deps.trackGitRoot(authority.mainRoot);
    return deps.getGitStatus(authority.mainRoot);
  });
  deps.ipcMain.handle("workspace:gitBranches", async (_event, sessionId: string) => {
    deps.assertSessionId(sessionId);
    const authority = await getSessionWorkspaceAuthorityForUi(sessionId);
    requireUsableSessionRootAuthority(authority);
    deps.trackGitRoot(authority.mainRoot);
    return deps.getGitBranches(authority.mainRoot);
  });
  deps.ipcMain.handle("workspace:profiles", async (_event, sessionId: string) => {
    deps.assertSessionId(sessionId);
    const authority = await getSessionWorkspaceAuthorityForUi(sessionId);
    requireUsableSessionRootAuthority(authority);
    return listProfiles(authority.mainRoot);
  });
  deps.ipcMain.handle("workspace:list", async (_event, sessionId: string, cwd: string) => {
    deps.assertSessionId(sessionId);
    if (typeof cwd !== "string" || !cwd) throw new Error("workspace:list requires cwd");
    const list = await listSessionWorktreesForUi(sessionId, cwd);
    deps.trackGitRoot(list.mainRoot);
    return list;
  });
  deps.ipcMain.handle("workspace:diff", async (_event, sessionId: string, worktreePath: string) => {
    deps.assertSessionId(sessionId);
    if (
      typeof worktreePath !== "string" ||
      !worktreePath ||
      worktreePath.length > 32_768 ||
      worktreePath.includes("\0")
    ) {
      throw new Error("workspace:diff requires worktreePath");
    }
    return getSessionWorktreeDiffForUi(sessionId, worktreePath);
  });
  deps.ipcMain.handle(
    "workspace:switch",
    async (_event, sessionId: string, cwd: string, target: string) => {
      deps.assertSessionId(sessionId);
      if (typeof cwd !== "string" || !cwd) throw new Error("workspace:switch requires cwd");
      if (
        typeof target !== "string" ||
        !target.trim() ||
        target.length > 32_768 ||
        target.includes("\0")
      ) {
        throw new Error("workspace:switch requires target");
      }
      const currentBridge = deps.getBridge();
      const list = await switchSessionWorkspaceForUi(sessionId, cwd, target, {
        setLiveWorkspace:
          currentBridge?.hasLiveWorker() && currentBridge.hasKnownSession(sessionId)
            ? (id, workspace) => currentBridge.setWorkspace(id, workspace)
            : undefined,
      });
      deps.trackGitRoot(list.mainRoot);
      broadcastWorkspaceChanged({ sessionId, workspace: list.current, mainRoot: list.mainRoot });
      return list;
    },
  );
  deps.ipcMain.handle("workspace:release", async (_event, sessionId: string) => {
    deps.assertSessionId(sessionId);
    const currentBridge = deps.getBridge();
    const released = await releaseSessionWorkspaceForUi(sessionId, {
      releaseLiveWorkspace:
        currentBridge && currentBridge.hasKnownSession(sessionId)
          ? (id) => currentBridge.releaseWorkspace(id)
          : undefined,
    });
    if (released.status === "released") {
      broadcastWorkspaceChanged({ sessionId, workspace: released.workspace });
    }
    return released;
  });
  deps.ipcMain.handle("workspace:releaseMany", async (_event, sessionIds: string[]) => {
    if (!Array.isArray(sessionIds) || sessionIds.length > 500) {
      throw new Error("workspace:releaseMany requires sessionIds");
    }
    for (const id of sessionIds) deps.assertSessionId(id);
    const ids = [...new Set(sessionIds)];
    const currentBridge = deps.getBridge();
    const released = await releaseManySessionWorkspacesForUi(ids, {
      releaseLiveWorkspace: currentBridge
        ? async (id) => {
            if (!currentBridge.hasKnownSession(id)) return;
            await currentBridge.releaseWorkspace(id);
          }
        : undefined,
    });
    for (const item of released) {
      if (item.status === "released") {
        broadcastWorkspaceChanged({ sessionId: item.sessionId, workspace: item.workspace });
      }
    }
    return released;
  });
  deps.ipcMain.handle(
    "workspace:cleanup",
    async (
      _event,
      sessionId: string,
      cwd: string,
      worktreePath: string,
      action: WorkspaceCleanupAction,
    ) => {
      deps.assertSessionId(sessionId);
      if (typeof cwd !== "string" || !cwd) throw new Error("workspace:cleanup requires cwd");
      if (
        typeof worktreePath !== "string" ||
        !worktreePath ||
        worktreePath.length > 32_768 ||
        worktreePath.includes("\0")
      ) {
        throw new Error("workspace:cleanup requires worktreePath");
      }
      if (action !== "detach" && action !== "discard") {
        throw new Error("workspace:cleanup requires action detach or discard");
      }
      const currentBridge = deps.getBridge();
      const list = await cleanupSessionWorktreeForUi(sessionId, cwd, worktreePath, action, {
        setLiveWorkspace:
          currentBridge?.hasLiveWorker() && currentBridge.hasKnownSession(sessionId)
            ? (id, workspace) => currentBridge.setWorkspace(id, workspace)
            : undefined,
      });
      deps.trackGitRoot(list.mainRoot);
      broadcastWorkspaceChanged({ sessionId, workspace: list.current, mainRoot: list.mainRoot });
      return list;
    },
  );
}
