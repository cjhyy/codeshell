import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { LinkSnapshot } from "@cjhyy/code-shell-link";
import { captureSourceCollectionOwner } from "./source-collections-owner.js";
import { requireRendererProjectPrimary } from "./renderer-project-path.js";
import { getProjectStore } from "./project-store.js";
import { requireMountedProjectRoot } from "./mounted-project-root.js";
import { createLinkedFileSourceService } from "./linked-file-sources-service.js";

export function openLinkedFileSourceOperation(
  event: IpcMainInvokeEvent,
  isMainWindow: (window: BrowserWindow) => boolean,
  storedSnapshot: (event: IpcMainInvokeEvent, cwd: string) => Promise<() => LinkSnapshot>,
) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  if (!owner || !isMainWindow(owner) || !frame || frame !== event.sender.mainFrame)
    throw new Error("文件引用操作仅允许从主窗口发起。");
  const authority = captureSourceCollectionOwner({
    owner,
    sender: event.sender,
    frame,
    isMainWindow: () => isMainWindow(owner),
  });
  const snapshots = new Map<string, () => LinkSnapshot>();
  const changed = new Set<string>();
  const reviewed = new Map<string, { rootId: string; path: string }>();
  const unsubscribe = getProjectStore().onChanged((projects) => {
    for (const [id, original] of reviewed) {
      const project = projects.find((item) => item.id === id && item.deletedAt === undefined);
      const root = project?.roots.find((item) => item.id === original.rootId);
      if (!project || project.primaryRootId !== original.rootId || root?.path !== original.path)
        changed.add(id);
    }
  });
  const api = createLinkedFileSourceService({
    assertCurrent: authority.assertCurrent,
    async resolveProject(projectId) {
      const current = await requireRendererProjectPrimary(projectId);
      authority.assertCurrent();
      if (!snapshots.has(current.path)) {
        snapshots.set(current.path, await storedSnapshot(event, current.path));
        authority.assertCurrent();
      }
      reviewed.set(projectId, { rootId: current.rootId, path: current.path });
      return {
        projectId: current.project.id,
        rootId: current.rootId,
        cwd: current.path,
        canonicalIdentity: current.root.canonicalIdentity!,
      };
    },
    assertProjectCurrent(project) {
      authority.assertCurrent();
      if (
        changed.has(project.projectId) ||
        requireMountedProjectRoot({
          path: project.cwd,
          canonicalIdentity: project.canonicalIdentity,
        }) !== project.cwd
      )
        throw new Error("项目主目录已改变，请重新打开项目配置。");
    },
    snapshot(cwd) {
      authority.assertCurrent();
      const snapshot = snapshots.get(cwd);
      if (!snapshot) throw new Error("连接快照尚未读取，请重新打开项目配置。");
      // Read the stored masked snapshot only. Never refresh a remote catalog or fetch content.
      return snapshot();
    },
  });
  return {
    api,
    dispose() {
      unsubscribe();
      authority.dispose();
    },
  };
}
