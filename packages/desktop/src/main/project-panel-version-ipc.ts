import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { PanelOperationContext } from "@cjhyy/code-shell-server/panels";
import type { createDesktopPanelManagement } from "./panel-app-management.js";

type VersionManagement = Pick<
  ReturnType<typeof createDesktopPanelManagement>,
  "packageHistory" | "previewRestore" | "restore" | "cancelRestore"
>;

/** Version routes share the parent registrar's project managers and renderer leases. */
export function registerProjectPanelVersionIpc(deps: {
  ipcMain: Pick<IpcMain, "handle">;
  requireRendererProjectPath: (cwd: string) => Promise<string>;
  desktopPanelManager: (cwd: string) => { management: VersionManagement };
  desktopPanelContext: (event: IpcMainInvokeEvent, cwd: string) => PanelOperationContext;
}) {
  const { ipcMain, requireRendererProjectPath, desktopPanelManager, desktopPanelContext } = deps;
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
  ipcMain.handle("panel-apps:cancelRestore", async (event, rawCwd: string, token: string) => {
    const cwd = await requireRendererProjectPath(rawCwd);
    return desktopPanelManager(cwd).management.cancelRestore(
      desktopPanelContext(event, cwd),
      token,
    );
  });
}
