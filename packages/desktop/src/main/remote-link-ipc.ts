import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  createLinkService,
  remoteLinkFromEnvironment,
  type LinkConnectionInput,
} from "@cjhyy/code-shell-server/links";
import { createNativeRemoteLinkManager } from "./remote-link-manager.js";
import { openNativeLinkAuthorization } from "./remote-link-window.js";

/** Window-owned authorization managers retire on navigation and destruction. */
export function registerRemoteLinkIpc(deps: {
  ipcMain: Pick<IpcMain, "handle">;
  requireRendererProjectPath: (cwd: string) => Promise<string>;
  isMainWindow: (contents: WebContents) => boolean;
  withMutation: <T>(cwd: string, write: () => Promise<T>) => Promise<T>;
  onChanged: () => void;
}) {
  const { ipcMain, requireRendererProjectPath } = deps;
  const nativeLinkOwners = new WeakMap<
    Electron.WebContents,
    {
      id: string;
      managers: Map<string, ReturnType<typeof createNativeRemoteLinkManager>>;
    }
  >();
  async function nativeLinkContext(event: IpcMainInvokeEvent, rawCwd: string) {
    const allowed = () =>
      !event.sender.isDestroyed() &&
      event.senderFrame === event.sender.mainFrame &&
      deps.isMainWindow(event.sender);
    if (!allowed() || typeof rawCwd !== "string") throw new Error("Link 操作需要来自桌面主窗口。");
    const cwd = rawCwd ? await requireRendererProjectPath(rawCwd) : "";
    if (!allowed()) throw new Error("Link 操作所属窗口已关闭或刷新。");
    let owner = nativeLinkOwners.get(event.sender);
    if (!owner) {
      owner = { id: `desktop-link:${randomUUID()}`, managers: new Map() };
      nativeLinkOwners.set(event.sender, owner);
      const close = () => {
        for (const manager of owner!.managers.values()) manager.close();
        owner!.managers.clear();
        if (nativeLinkOwners.get(event.sender) === owner) nativeLinkOwners.delete(event.sender);
        event.sender.removeListener("did-start-navigation", navigate);
        event.sender.removeListener("destroyed", close);
      };
      const navigate = (
        _event: Electron.Event,
        _url: string,
        _inPlace: boolean,
        mainFrame: boolean,
      ) => {
        if (mainFrame) close();
      };
      event.sender.on("did-start-navigation", navigate);
      event.sender.once("destroyed", close);
    }
    let manager = owner.managers.get(cwd);
    if (!manager) {
      if (owner.managers.size >= 64) throw new Error("打开的 Link 工作区过多，请重新打开窗口。");
      manager = createNativeRemoteLinkManager({
        service: createLinkService({
          cwd: cwd || undefined,
          remoteLink: () =>
            process.env.CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN
              ? remoteLinkFromEnvironment(
                  process.env,
                  process.env.CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN,
                )
              : undefined,
          withMutation: (write) => deps.withMutation(cwd, write),
          onChanged: deps.onChanged,
        }),
        open: openNativeLinkAuthorization,
      });
      owner.managers.set(cwd, manager);
    }
    const context = {
      ownerId: owner.id,
      authorize: async () => {
        if (!allowed() || nativeLinkOwners.get(event.sender) !== owner) return false;
        if (cwd && (await requireRendererProjectPath(cwd)) !== cwd) return false;
        return allowed() && nativeLinkOwners.get(event.sender) === owner;
      },
    };
    return { manager, context };
  }
  ipcMain.handle("links:remoteSnapshot", async (event, cwd: string) => {
    const { manager, context } = await nativeLinkContext(event, cwd);
    await manager.service.assertAuthorized(context);
    return manager.service.snapshot();
  });
  ipcMain.handle(
    "links:remoteStart",
    async (event, cwd: string, requestId: string, input: LinkConnectionInput) => {
      const { manager, context } = await nativeLinkContext(event, cwd);
      return manager.start(context, requestId, input);
    },
  );
  ipcMain.handle("links:remoteCancel", async (event, cwd: string, requestId: string) => {
    const { manager, context } = await nativeLinkContext(event, cwd);
    return manager.cancel(context, requestId);
  });
  ipcMain.handle(
    "links:remoteRename",
    async (event, cwd: string, id: string, label: string, revision: string) => {
      const { manager, context } = await nativeLinkContext(event, cwd);
      return manager.service.rename(context, id, label, revision);
    },
  );
  ipcMain.handle(
    "links:remoteDisconnect",
    async (event, cwd: string, id: string, revision: string) => {
      const { manager, context } = await nativeLinkContext(event, cwd);
      return manager.service.disconnect(context, id, revision);
    },
  );
}
