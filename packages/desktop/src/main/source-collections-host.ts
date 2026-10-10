import { BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron";
import { SettingsManager } from "@cjhyy/code-shell-core";
import { listBindings } from "@cjhyy/code-shell-core/internal";
import { createSourceCollectionService } from "./source-collections-service.js";
import { getProjectStore } from "./project-store.js";
import { validateMountedProjectRoot } from "./mounted-project-root.js";
import { captureSourceCollectionOwner } from "./source-collections-owner.js";

export function openSourceCollectionOperation(
  event: IpcMainInvokeEvent,
  isMainWindow: (window: BrowserWindow) => boolean,
) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  if (!owner || !isMainWindow(owner) || !frame || frame !== event.sender.mainFrame)
    throw new Error("资料集操作仅允许从主窗口发起。");
  const authority = captureSourceCollectionOwner({
    owner,
    sender: event.sender,
    frame,
    isMainWindow: () => isMainWindow(owner),
  });
  const { assertCurrent } = authority;
  const api = createSourceCollectionService({
    signal: authority.signal,
    assertCurrent,
    async pick(mode) {
      assertCurrent();
      const result = await dialog.showOpenDialog(owner, {
        title:
          mode === "folder"
            ? "添加文件夹当前清单（不含隐藏文件及符号链接）"
            : "添加资料集文件（引用原文件）",
        properties: mode === "folder" ? ["openDirectory"] : ["openFile", "multiSelections"],
      });
      assertCurrent();
      return result.canceled ? null : result.filePaths;
    },
    async references(id) {
      const projects = await getProjectStore().list();
      assertCurrent();
      const references: Array<{ projectId: string; name: string }> = [];
      let checkedRoots = 0;
      for (const project of projects) {
        assertCurrent();
        for (const root of project.roots) {
          // Permit navigation/cancellation between bounded metadata batches.
          if (++checkedRoots % 32 === 0) await new Promise<void>((done) => setImmediate(done));
          assertCurrent();
          if (validateMountedProjectRoot(root).status !== "ok") continue;
          if (
            listBindings(new SettingsManager(root.path, "full"), root.path).some(
              (binding) => binding.sourceId === id,
            )
          ) {
            references.push({ projectId: project.id, name: project.displayName ?? project.name });
            break;
          }
        }
      }
      return references;
    },
  });
  return { api, dispose: authority.dispose };
}
