import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { panelExecutionGate } from "@cjhyy/code-shell-server/panels";
import {
  resolvePanelAppBindingProjectPath,
  type GitPanelAppSourceInput,
  type PanelAppSourceInput,
} from "@cjhyy/code-shell-core";
import { readSettings, writeSettings } from "./settings-service.js";
import {
  listPanelAppExtensions,
  listPanelApps,
  listPanelAppsForProjects,
} from "./panel-apps-service.js";
import { discoverGitPanelAppsForUi, uninstallPanelAppForUi } from "./panel-app-install-service.js";
import { createDesktopPanelManagement } from "./panel-app-management.js";
import {
  panelAppUpdateService,
  createProjectPanelAppUpdateService,
} from "./panel-app-update-service.js";

/** Owns project review leases, update caches and their IPC lifecycle. */
export function registerProjectPanelIpc(deps: {
  ipcMain: Pick<IpcMain, "handle">;
  requireRendererProjectPath: (cwd: string) => Promise<string>;
  withMutation: <T>(cwd: string, write: () => Promise<T>) => Promise<T>;
  onChanged: () => void;
  revokeAppId: (id: string) => void;
  onCleanupError: (id: string, error: unknown) => void;
}) {
  const { ipcMain, requireRendererProjectPath } = deps;
  const desktopPanelManagers = new Map<
    string,
    {
      management: ReturnType<typeof createDesktopPanelManagement>;
      updates: ReturnType<typeof createProjectPanelAppUpdateService>;
    }
  >();
  const panelReviewOwners = new Set<number>();
  function desktopPanelManager(cwd: string) {
    const key = JSON.stringify([cwd, resolvePanelAppBindingProjectPath(cwd)]);
    const existing = desktopPanelManagers.get(key);
    if (existing) {
      desktopPanelManagers.delete(key);
      desktopPanelManagers.set(key, existing);
      return existing;
    }
    const entry = {
      management: createDesktopPanelManagement(cwd, {
        withMutation: (write) => deps.withMutation(cwd, write),
        onChanged: (id) => {
          for (const value of desktopPanelManagers.values()) value.updates.invalidate(id);
          panelAppUpdateService.invalidate(id);
          deps.onChanged();
        },
      }),
      updates: createProjectPanelAppUpdateService(cwd),
    };
    desktopPanelManagers.set(key, entry);
    while (desktopPanelManagers.size > 64) {
      const oldest = desktopPanelManagers.keys().next().value!;
      desktopPanelManagers.get(oldest)!.management.close();
      desktopPanelManagers.delete(oldest);
    }
    return entry;
  }
  function desktopPanelContext(event: IpcMainInvokeEvent, cwd: string) {
    const ownerId = `desktop:${event.sender.id}`;
    if (!panelReviewOwners.has(event.sender.id)) {
      const id = event.sender.id;
      panelReviewOwners.add(id);
      event.sender.once("destroyed", () => {
        panelReviewOwners.delete(id);
        for (const value of desktopPanelManagers.values()) value.management.cancelOwner(ownerId);
      });
    }
    return {
      ownerId,
      authorize: async () =>
        !event.sender.isDestroyed() && (await requireRendererProjectPath(cwd)) === cwd,
    };
  }
  async function desktopPanelOperation<T>(work: () => Promise<T>) {
    try {
      return { ok: true as const, ...(await work()) };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
        ...((error as { code?: string })?.code === "already_installed"
          ? { alreadyInstalled: true as const }
          : {}),
      };
    }
  }

  ipcMain.handle("panel-apps:list", async (_e, cwd: string, locale: string) => {
    cwd = await requireRendererProjectPath(cwd);
    if (typeof locale !== "string" || locale.length > 64) {
      throw new Error("panel-apps:list requires locale");
    }
    return listPanelApps(cwd, locale);
  });
  ipcMain.handle("panel-apps:listExtensions", async (_e, cwd: string, locale: string) => {
    cwd = await requireRendererProjectPath(cwd);
    if (typeof locale !== "string" || locale.length > 64) {
      throw new Error("panel-apps:listExtensions requires locale");
    }
    return listPanelAppExtensions(cwd, locale);
  });
  ipcMain.handle("panel-apps:bindings", async (_e, cwd: string) => {
    cwd = await requireRendererProjectPath(cwd);
    return createDesktopPanelManagement(cwd).snapshot();
  });
  ipcMain.handle(
    "panel-apps:packageHistory",
    async (event, rawCwd: string, id: string, revision: string) => {
      const cwd = await requireRendererProjectPath(rawCwd);
      return desktopPanelManager(cwd).management.packageHistory(
        desktopPanelContext(event, cwd),
        id,
        revision,
      );
    },
  );
  ipcMain.handle(
    "panel-apps:previewRestore",
    async (event, rawCwd: string, id: string, digest: string, revision: string) => {
      const cwd = await requireRendererProjectPath(rawCwd);
      return desktopPanelManager(cwd).management.previewRestore(
        desktopPanelContext(event, cwd),
        id,
        digest,
        revision,
      );
    },
  );
  ipcMain.handle("panel-apps:restore", async (event, rawCwd: string, token: string) => {
    const cwd = await requireRendererProjectPath(rawCwd);
    return desktopPanelManager(cwd).management.restore(desktopPanelContext(event, cwd), token);
  });
  ipcMain.handle(
    "panel-apps:setProjectBinding",
    async (event, cwd: string, id: string, bound: boolean, expectedRevision: string) => {
      cwd = await requireRendererProjectPath(cwd);
      return desktopPanelManager(cwd).management.binding(
        desktopPanelContext(event, cwd),
        id,
        bound,
        expectedRevision,
      );
    },
  );
  ipcMain.handle(
    "panel-apps:listForProjects",
    async (_e, projectPaths: string[], locale: string) => {
      if (!Array.isArray(projectPaths) || projectPaths.length > 64) {
        throw new Error("panel-apps:listForProjects requires projectPaths");
      }
      if (typeof locale !== "string" || locale.length > 64) {
        throw new Error("panel-apps:listForProjects requires locale");
      }
      const authorizedPaths = await Promise.all(
        projectPaths.map((path) => requireRendererProjectPath(path)),
      );
      return listPanelAppsForProjects(authorizedPaths, locale);
    },
  );

  ipcMain.handle(
    "panel-apps:previewLocal",
    async (event, input: PanelAppSourceInput, rawCwd: string) =>
      desktopPanelOperation(async () => {
        const cwd = await requireRendererProjectPath(rawCwd);
        const review = await desktopPanelManager(cwd).management.previewSource(
          desktopPanelContext(event, cwd),
          input,
        );
        return {
          preview: { ...review.preview, reviewToken: review.reviewToken },
          installedVersion: review.installedVersion,
        };
      }),
  );
  ipcMain.handle("panel-apps:discoverGit", async (_e, input: GitPanelAppSourceInput) =>
    discoverGitPanelAppsForUi(input),
  );
  ipcMain.handle(
    "panel-apps:previewUpdate",
    async (event, id: string, rawCwd: string, expectedRevision: string) =>
      desktopPanelOperation(async () => {
        const cwd = await requireRendererProjectPath(rawCwd);
        const review = await desktopPanelManager(cwd).management.previewUpdate(
          desktopPanelContext(event, cwd),
          id,
          expectedRevision,
        );
        return {
          preview: { ...review.preview, reviewToken: review.reviewToken },
          installedVersion: review.installedVersion,
        };
      }),
  );
  ipcMain.handle(
    "panel-apps:checkUpdate",
    async (_e, id: string, force: boolean | undefined, rawCwd: string) => {
      const cwd = await requireRendererProjectPath(rawCwd);
      if (typeof id !== "string" || (force !== undefined && typeof force !== "boolean"))
        throw new Error("panel-apps:checkUpdate requires id and an optional boolean force");
      return desktopPanelManager(cwd).updates.check(id, force === true);
    },
  );
  ipcMain.handle(
    "panel-apps:installLocal",
    async (
      event,
      input: {
        cwd: string;
        source: PanelAppSourceInput;
        reviewToken: string;
        overwrite?: boolean;
      },
    ) =>
      desktopPanelOperation(async () => {
        if (
          !input ||
          typeof input.reviewToken !== "string" ||
          (input.overwrite !== undefined && typeof input.overwrite !== "boolean")
        )
          throw new Error("panel-apps:installLocal requires a project and reviewed token");
        const cwd = await requireRendererProjectPath(input.cwd);
        return desktopPanelManager(cwd).management.install(
          desktopPanelContext(event, cwd),
          input.reviewToken,
          { overwrite: input.overwrite === true },
        );
      }),
  );
  ipcMain.handle(
    "panel-apps:installUpdate",
    async (
      event,
      input: {
        cwd: string;
        id: string;
        reviewToken: string;
      },
    ) =>
      desktopPanelOperation(async () => {
        if (
          !input ||
          typeof input.id !== "string" ||
          !input.id ||
          typeof input.reviewToken !== "string"
        )
          throw new Error("panel-apps:installUpdate requires a project and reviewed token");
        const cwd = await requireRendererProjectPath(input.cwd);
        return desktopPanelManager(cwd).management.install(
          desktopPanelContext(event, cwd),
          input.reviewToken,
          { overwrite: true, expectedId: input.id },
        );
      }),
  );
  ipcMain.handle("panel-apps:uninstall", async (_e, id: string, cwd?: string) => {
    if (typeof id !== "string" || !id || id.length > 512 || id.includes("\0")) {
      throw new Error("panel-apps:uninstall requires id");
    }
    if (cwd !== undefined && (typeof cwd !== "string" || !cwd)) {
      throw new Error("panel-apps:uninstall cwd must be a non-empty string");
    }
    const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : undefined;
    return panelExecutionGate.mutate(
      (scope) => scope.appId === id,
      async () => {
        await uninstallPanelAppForUi(id);
        deps.revokeAppId(id);
        try {
          const settings = (await readSettings("user")) ?? {};
          const disabled = (settings as { disabledPanelApps?: unknown }).disabledPanelApps;
          if (Array.isArray(disabled)) {
            await writeSettings("user", {
              disabledPanelApps: disabled.filter((candidate) => candidate !== id),
            });
          }
          if (authorizedCwd) {
            const projectSettings = (await readSettings("project", authorizedCwd)) ?? {};
            const bindings = Array.isArray(projectSettings.panelAppBindings)
              ? projectSettings.panelAppBindings.filter(
                  (candidate): candidate is string =>
                    typeof candidate === "string" && candidate !== id,
                )
              : [];
            // Write the full surviving map, not `{[id]: null}`: deepMerge only honors
            // a null delete when the key already exists, so on a project without
            // panelAppOverrides the null lands in the file and the settings schema
            // then rejects it wholesale.
            const rawOverrides = projectSettings.panelAppOverrides;
            const overrides: Record<string, "inherit" | "on" | "off"> = {};
            if (rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)) {
              for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
                if (key === id) continue;
                if (value === "inherit" || value === "on" || value === "off")
                  overrides[key] = value;
              }
            }
            await writeSettings(
              "project",
              {
                panelAppBindings: bindings,
                panelAppOverrides: overrides,
              },
              authorizedCwd,
            );
          }
        } catch (error) {
          deps.onCleanupError(id, error);
        }
        deps.onChanged();
      },
    );
  });
}
