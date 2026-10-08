import { basename } from "node:path";
import type { BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { ProfilePluginExportReviews } from "./profile-plugin-export-service.js";
import type { resolveRendererConfigurationTarget } from "./renderer-configuration-authority.js";

export function registerProfilePluginExportIpc(
  ipcMain: Pick<IpcMain, "handle">,
  dialog: Pick<Dialog, "showSaveDialog">,
  windows: Pick<typeof BrowserWindow, "fromWebContents">,
  isMainWindow: (sender: WebContents) => boolean,
  resolveTarget: typeof resolveRendererConfigurationTarget,
): void {
  const reviews = new ProfilePluginExportReviews();
  const generations = new Map<number, number>();
  const observed = new WeakSet<WebContents>();
  const owner = (event: IpcMainInvokeEvent): number => {
    if (event.senderFrame !== event.sender.mainFrame || !isMainWindow(event.sender))
      throw new Error("plugin export requires the Desktop main window");
    if (!observed.has(event.sender)) {
      observed.add(event.sender);
      const id = event.sender.id;
      event.sender.once("destroyed", () => {
        reviews.clearOwner(id);
        generations.delete(id);
      });
    }
    return event.sender.id;
  };
  const token = (value: unknown): string => {
    if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
      throw new Error("invalid plugin export review token");
    return value;
  };
  const requireContext = (target: unknown) => {
    // The existing no-repo resolver creates its working directory. This export
    // preview must be read-only, so it requires an existing project/session.
    if (target && typeof target === "object" && "noRepo" in target)
      throw new Error("static plugin export requires an existing project or session context");
  };
  ipcMain.handle(
    "profiles:previewPluginExport",
    async (event, name: unknown, target: unknown, selection: unknown) => {
      const id = owner(event);
      requireContext(target);
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      if (typeof name !== "string") throw new Error("Profile name is required");
      const authority = await resolveTarget(target);
      owner(event);
      if (generations.get(id) !== generation)
        throw new Error("plugin export preview was superseded");
      return reviews.preview(id, JSON.stringify(authority), name, authority.cwd, selection);
    },
  );
  ipcMain.handle("profiles:cancelPluginExport", (event, reviewToken: unknown) =>
    reviews.cancel(owner(event), token(reviewToken)),
  );
  ipcMain.handle(
    "profiles:commitPluginExport",
    async (event, reviewToken: unknown, target: unknown, acceptLosses: unknown) => {
      const id = owner(event);
      requireContext(target);
      const reviewedToken = token(reviewToken);
      if (acceptLosses !== true) throw new Error("explicit loss acceptance is required");
      const authority = await resolveTarget(target);
      const context = JSON.stringify(authority);
      const snapshot = reviews.get(id, context, reviewedToken);
      if (!snapshot.canExport)
        throw new Error("select a loadable component and resolve blockers before export");
      const options = {
        title: "Save reviewed static plugin as a NEW directory",
        defaultPath: `${snapshot.pluginName}.plugin`,
        buttonLabel: "Create plugin directory",
      };
      const win = windows.fromWebContents(event.sender);
      const picked = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) {
        reviews.cancel(id, reviewedToken);
        return { canceled: true };
      }
      owner(event);
      const current = await resolveTarget(target);
      if (JSON.stringify(current) !== context) {
        reviews.cancel(id, reviewedToken);
        throw new Error("configuration context changed during destination selection");
      }
      reviews.commit(id, context, reviewedToken, acceptLosses, picked.filePath);
      return { canceled: false, directoryName: basename(picked.filePath) };
    },
  );
}
