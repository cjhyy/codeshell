import { migrateHostedSession } from "./project-migration-client.js";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import type { IpcMainInvokeEvent } from "electron";
import type {
  ProjectRegistryCommand,
  ProjectRegistryOperations,
} from "../shared/project-registry-operations.js";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import { projectRegistryEdits } from "./hosted-project-registry.js";
import type { LocalProject } from "./project-store.js";
import type { AgentBridge } from "./agent-bridge.js";
import type { ExternalRuntimeService } from "./external-runtime-service.js";
import { createLegacyProjectMigrationService } from "./legacy-project-migration.js";
import type { ProjectStore, ProjectResolveSource } from "./project-store.js";
import { requireRendererProjectRoot } from "./renderer-project-path.js";
import {
  cleanupSessionWorktreeForUi,
  getSessionWorkspaceAuthorityForUi,
  getSessionWorkspaceForUi,
  releaseSessionWorkspaceForUi,
  switchSessionWorkspaceForUi,
  type SessionWorkspaceReleaseResult,
  type WorkspaceCleanupAction,
} from "./session-workspace-service.js";

interface ProjectAuthorityWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload?: unknown): void };
}

export interface ProjectAuthorityIpcDependencies {
  host?: {
    callBusiness: CallShellBusiness;
    documentSignal(event: IpcMainInvokeEvent): AbortSignal;
    generationSignal(document: AbortSignal): Promise<AbortSignal>;
    projectRegistryListeners: Set<(projects: LocalProject[]) => Promise<void>>;
  };

  ipcMain: Pick<typeof import("electron").ipcMain, "handle">;
  getAllWindows(): ProjectAuthorityWindow[];
  showOpenDialog(options: {
    title: string;
    properties: Array<"openDirectory" | "createDirectory">;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  applyGitPathFromSettings(): Promise<void>;
  projectStore: ProjectStore;
  getBridge(): AgentBridge | null | undefined;
  getExternalRuntimeService?(): Pick<ExternalRuntimeService, "withWorkspaceMutation"> | null;
  getTrust: typeof import("./trust-store.js").getTrust;
  assertSessionId(value: unknown): asserts value is string;
  trackGitRoot(root: string): void;
  broadcastMobileProjects(): Promise<void>;
  revealInFinder: typeof import("./desktop-services.js").revealInFinder;
  openPath: typeof import("./desktop-services.js").openPath;
}

export function registerProjectAuthorityIpc(deps: ProjectAuthorityIpcDependencies): void {
  function withWorkspaceOwner<T>(
    sessionId: string,
    ownerWebContentsId: number,
    operation: (
      bridge: AgentBridge | null | undefined,
      beforePersist?: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const mutate = (beforePersist?: () => Promise<void>) =>
      operation(beforePersist ? undefined : deps.getBridge(), beforePersist);
    const external = deps.getExternalRuntimeService?.();
    return external
      ? external.withWorkspaceMutation(sessionId, mutate, ownerWebContentsId)
      : mutate();
  }

  function releaseWorkspace(sessionId: string, ownerWebContentsId: number) {
    return withWorkspaceOwner(sessionId, ownerWebContentsId, (bridge, beforePersist) =>
      releaseSessionWorkspaceForUi(sessionId, {
        releaseLiveWorkspace: beforePersist
          ? () => beforePersist()
          : bridge?.hasKnownSession(sessionId)
            ? (id) => bridge.releaseWorkspace(id)
            : undefined,
      }),
    );
  }

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

  async function broadcastProjectRegistry(snapshot?: LocalProject[]): Promise<void> {
    const projects = snapshot ?? (await deps.projectStore.list());
    for (const window of deps.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("projectRegistry:changed", projects);
    }
    await deps.broadcastMobileProjects();
  }

  deps.host?.projectRegistryListeners.add(broadcastProjectRegistry);
  const localEdits = projectRegistryEdits(deps.projectStore, deps.getTrust);
  function edits(event: IpcMainInvokeEvent) {
    const signal = deps.host?.documentSignal(event);
    return async <K extends ProjectRegistryCommand>(
      method: K,
      input: ProjectRegistryOperations[K]["input"],
    ): Promise<ProjectRegistryOperations[K]["result"]> => {
      if (deps.host) return deps.host.callBusiness(method, input, signal);
      const result = await localEdits[method](input);
      await broadcastProjectRegistry();
      return result;
    };
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
  deps.ipcMain.handle("projectRegistry:createFromPicker", async (event) => {
    const call = edits(event);
    const picked = await pickProjectDirectory();
    if (!picked) return null;
    return call("projects/createPicked", { pickedPath: picked });
  });
  deps.ipcMain.handle("projectRegistry:addRootFromPicker", async (event, projectId: string) => {
    const call = edits(event);
    const picked = await pickProjectDirectory();
    if (!picked) return null;
    return call("projects/addPickedRoot", { projectId, pickedPath: picked });
  });
  deps.ipcMain.handle(
    "projectRegistry:removeRoot",
    async (event, projectId: string, rootId: string) => {
      if (deps.host) {
        const signal = deps.host.documentSignal(event);
        const path = await deps.host.callBusiness(
          "projects/removalPath",
          { projectId, rootId },
          signal,
        );
        const index = getSessionCwdIndex();
        await index.ensureLoaded();
        const observedIds = index.confirmedIdsForProjectRoot(projectId, rootId, path);
        return deps.host.callBusiness(
          "projects/removeRoot",
          { projectId, rootId, path, observedIds },
          signal,
        );
      }
      const project = await deps.projectStore.removeRoot(projectId, rootId);
      await broadcastProjectRegistry();
      return project;
    },
  );
  deps.ipcMain.handle(
    "projectRegistry:migrateSessionMainRoot",
    async (event, sessionId: string, targetRootId: string) => {
      deps.assertSessionId(sessionId);
      if (typeof targetRootId !== "string" || !targetRootId || targetRootId.length > 512) {
        throw new Error("target root id is required");
      }
      const currentBridge = deps.getBridge();
      if (deps.host) {
        const signal = deps.host.documentSignal(event);
        if (!currentBridge) throw Error("Session migration owner is unavailable");
        const migrated = await migrateHostedSession(
          sessionId,
          targetRootId,
          signal,
          await deps.host.generationSignal(signal),
          deps.host.callBusiness,
          currentBridge,
          deps.getTrust,
        );
        broadcastWorkspaceChanged({
          sessionId,
          workspace: migrated.workspace,
          mainRoot: migrated.mainRoot,
        });
        signal.throwIfAborted();
        return migrated;
      }
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
  deps.ipcMain.handle("projectRegistry:setPrimary", (event, projectId: string, rootId: string) =>
    edits(event)("projects/setPrimary", { projectId, rootId }),
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
  deps.ipcMain.handle("projectRegistry:rename", (event, projectId: string, name: string) =>
    edits(event)("projects/rename", { projectId, name }),
  );
  deps.ipcMain.handle("projectRegistry:setPinned", (event, projectId: string, pinned: boolean) =>
    edits(event)("projects/setPinned", { projectId, pinned }),
  );
  deps.ipcMain.handle("projectRegistry:remove", (event, projectId: string) =>
    edits(event)("projects/remove", { projectId }),
  );
  async function resolveCwds(
    event: IpcMainInvokeEvent,
    cwds: string[],
    source: ProjectResolveSource,
  ) {
    const host = deps.host;
    const signal = host?.documentSignal(event);
    const resolutions = await deps.projectStore.resolveProjectForCwdBatch(
      cwds,
      source,
      host
        ? (cwd) => host.callBusiness("projects/restoreHistoricalCwd", { cwd }, signal)
        : undefined,
    );
    if (!host && resolutions.some((row) => row && "created" in row && row.created)) {
      await broadcastProjectRegistry();
    }
    return resolutions;
  }
  deps.ipcMain.handle(
    "projectRegistry:resolveForCwd",
    async (event, cwd: string, source: ProjectResolveSource) =>
      (await resolveCwds(event, [cwd], source))[0] ?? null,
  );
  deps.ipcMain.handle("projectRegistry:resolveForCwdBatch", resolveCwds);
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
  deps.ipcMain.handle("workspace:authority", async (event, sessionId: string) => {
    deps.assertSessionId(sessionId);
    const bridge = deps.getBridge();
    const reservation = bridge?.hostReservation(sessionId);
    return getSessionWorkspaceAuthorityForUi(sessionId, {
      getHostWorkspace: () => {
        if (!bridge || !reservation || deps.getBridge() !== bridge) return undefined;
        const current = bridge.hostReservation(sessionId);
        if (
          !current ||
          current.reservedAt !== reservation.reservedAt ||
          current.cwd !== reservation.cwd ||
          current.mainRoot !== reservation.mainRoot ||
          bridge.panelOwnerWebContentsId(sessionId) !== event.sender.id
        ) {
          return undefined;
        }
        return { mainRoot: current.mainRoot ?? current.cwd, cwd: current.cwd };
      },
    });
  });
  deps.ipcMain.handle(
    "workspace:switch",
    async (event, sessionId: string, cwd: string, target: string) => {
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
      const list = await withWorkspaceOwner(sessionId, event.sender.id, (bridge, beforePersist) =>
        switchSessionWorkspaceForUi(sessionId, cwd, target, {
          beforePersist,
          setLiveWorkspace:
            bridge?.hasLiveWorker() && bridge.hasKnownSession(sessionId)
              ? (id, workspace) => bridge.setWorkspace(id, workspace)
              : undefined,
        }),
      );
      deps.trackGitRoot(list.mainRoot);
      broadcastWorkspaceChanged({ sessionId, workspace: list.current, mainRoot: list.mainRoot });
      return list;
    },
  );
  deps.ipcMain.handle("workspace:release", async (event, sessionId: string) => {
    deps.assertSessionId(sessionId);
    const released = await releaseWorkspace(sessionId, event.sender.id);
    if (released.status === "released") {
      broadcastWorkspaceChanged({ sessionId, workspace: released.workspace });
    }
    return released;
  });
  deps.ipcMain.handle("workspace:releaseMany", async (event, sessionIds: string[]) => {
    if (!Array.isArray(sessionIds) || sessionIds.length > 500) {
      throw new Error("workspace:releaseMany requires sessionIds");
    }
    for (const id of sessionIds) deps.assertSessionId(id);
    const ids = [...new Set(sessionIds)];
    const released: SessionWorkspaceReleaseResult[] = [];
    for (const sessionId of ids) {
      try {
        released.push(await releaseWorkspace(sessionId, event.sender.id));
      } catch (error) {
        released.push({ sessionId, ok: false, status: "error", error: String(error) });
      }
    }
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
      event,
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
      const list = await withWorkspaceOwner(sessionId, event.sender.id, (bridge, beforePersist) =>
        cleanupSessionWorktreeForUi(sessionId, cwd, worktreePath, action, {
          beforePersist,
          setLiveWorkspace:
            bridge?.hasLiveWorker() && bridge.hasKnownSession(sessionId)
              ? (id, workspace) => bridge.setWorkspace(id, workspace)
              : undefined,
        }),
      );
      deps.trackGitRoot(list.mainRoot);
      broadcastWorkspaceChanged({ sessionId, workspace: list.current, mainRoot: list.mainRoot });
      return list;
    },
  );
}
