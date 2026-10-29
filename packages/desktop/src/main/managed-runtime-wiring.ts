import type { App, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  createDesktopManagedRuntimeProvider,
  createManagedRuntimeHandlers,
} from "./managed-runtime-service.js";

/** Desktop composition only: discovery does not hash or select a runtime for launch. */
export function createDesktopManagedRuntimeWiring(
  app: Pick<App, "isPackaged" | "getAppPath">,
  resourcesPath: string,
) {
  const provider = () =>
    createDesktopManagedRuntimeProvider({
      isPackaged: app.isPackaged,
      resourcesPath,
      appPath: app.getAppPath(),
    });
  return {
    // Resolve and verify anew at each actual service launch. No PATH fallback.
    async resolveBackgroundServiceNode() {
      return (await provider().resolve("node"))?.executablePath ?? null;
    },
    registerIpc(
      ipcMain: Pick<IpcMain, "handle">,
      isHostSender: (event: IpcMainInvokeEvent) => boolean,
    ) {
      const handlers = createManagedRuntimeHandlers(provider(), isHostSender);
      ipcMain.handle("managed-runtimes:list", handlers.list);
      ipcMain.handle("managed-runtimes:resolve", handlers.resolve);
    },
  };
}
