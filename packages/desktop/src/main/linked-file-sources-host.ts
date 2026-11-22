import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type {
  AddLinkedFileSourcesInput,
  CommitLinkedFiles,
  LinkedFileProject,
  StoredLinkedFiles,
} from "../shared/linked-file-sources.js";
import { captureSourceCollectionOwner } from "./source-collections-owner.js";
import { requireRendererProjectPrimary } from "./renderer-project-path.js";
import { requireMountedProjectRoot } from "./mounted-project-root.js";
import { getProjectStore } from "./project-store.js";
import {
  parseLinkedFileSelection,
  describeLinkedFileSources,
} from "./linked-file-sources-service.js";

export function openLinkedFileSourceOperation(
  event: IpcMainInvokeEvent,
  isMainWindow: (window: BrowserWindow) => boolean,
  storedSnapshot: (event: IpcMainInvokeEvent, cwd: string) => Promise<StoredLinkedFiles>,
  call: CommitLinkedFiles,
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
  const rootChanged = new AbortController();
  const signal = AbortSignal.any([authority.signal, rootChanged.signal]);
  let reviewed: LinkedFileProject | undefined;
  const unsubscribe = getProjectStore().onChanged((projects) => {
    if (!reviewed) return;
    const project = projects.find((p) => p.id === reviewed!.projectId && p.deletedAt === undefined);
    const root = project?.roots.find((r) => r.id === project.primaryRootId);
    if (
      !root ||
      root.id !== reviewed.rootId ||
      root.path !== reviewed.cwd ||
      root.canonicalIdentity !== reviewed.canonicalIdentity
    )
      rootChanged.abort(Error("项目主目录已改变，请重新打开项目配置。"));
  });
  async function authorize(id: string) {
    authority.assertCurrent();
    const { project, root, rootId, path } = await requireRendererProjectPrimary(id);
    reviewed = {
      projectId: project.id,
      rootId,
      cwd: path,
      canonicalIdentity: root.canonicalIdentity!,
    };
    signal.throwIfAborted();
    const review = await storedSnapshot(event, path);
    authority.assertCurrent();
    signal.throwIfAborted();
    if (requireMountedProjectRoot(root) !== path)
      throw Error("项目主目录已改变，请重新打开项目配置。");
    return { project: reviewed, review };
  }
  return {
    api: {
      async snapshot(id: string) {
        const { project, review } = await authorize(id);
        return describeLinkedFileSources(project, review);
      },
      async add(id: string, input: AddLinkedFileSourcesInput) {
        input = parseLinkedFileSelection(input);
        const { project, review } = await authorize(id);
        const connections = review.connections.filter((c) => c.id === input.connectionId);
        return call(
          "sources/addLinkedFiles",
          { project, review: { connections, revisions: review.revisions }, input },
          signal,
        );
      },
    },
    dispose() {
      unsubscribe();
      authority.dispose();
    },
  };
}
