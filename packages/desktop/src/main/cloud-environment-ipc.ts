import { session, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { resolve } from "node:path";
import type { CloudIpcResult, CloudRequestError } from "../shared/cloud-environment";
import { cloudWorkbenchPartition } from "./cloud-workbench-policy";
import { CloudEnvironmentError, CloudEnvironmentService } from "./cloud-environment-service";
import { ProjectRuntimeStore } from "./project-runtime-store";

export function registerCloudEnvironmentIpc(options: {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  windows: () => Iterable<BrowserWindow>;
  userDataDir: string;
  assertLocalProject: (id: string) => Promise<unknown>;
}): { service: CloudEnvironmentService; dispose: () => void } {
  const findWindow = (id: number) =>
    [...options.windows()].find(
      (window) =>
        !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.id === id,
    );
  let nextOwner = 0;
  const owners = new Map<number, { windowId: number; frame: Electron.WebFrameMain }>();
  const findOwner = (id: number) => {
    const record = owners.get(id);
    const window = record ? findWindow(record.windowId) : undefined;
    return window?.webContents.mainFrame === record?.frame ? window : undefined;
  };
  const service = new CloudEnvironmentService({
    store: new ProjectRuntimeStore(resolve(options.userDataDir, "project-runtimes", "v1.json")),
    assertLocalProject: options.assertLocalProject,
    transport: {
      fetch(origin, path, init) {
        return session
          .fromPartition(cloudWorkbenchPartition(origin))
          .fetch(new URL(path, origin).href, init);
      },
      async cookie(origin) {
        const cookies = await session.fromPartition(cloudWorkbenchPartition(origin)).cookies.get({
          url: `${origin}/`,
          name: "cs_hub_session",
        });
        if (cookies.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(cookies[0]!.value))
          return undefined;
        return `cs_hub_session=${cookies[0]!.value}`;
      },
    },
    ownerAlive: (owner) => !!findOwner(owner),
    onEvent: (owner, event) => findOwner(owner)?.webContents.send("cloudEnvironment:event", event),
    onStatus: (owner, status) =>
      findOwner(owner)?.webContents.send("cloudEnvironment:status", status),
  });
  const watched = new Set<number>();
  function releaseWindow(windowId: number): void {
    for (const [id, record] of owners)
      if (record.windowId === windowId) {
        service.releaseOwner(id);
        owners.delete(id);
      }
  }
  function owner(event: IpcMainInvokeEvent): number {
    if (!findWindow(event.sender.id) || event.senderFrame !== event.sender.mainFrame)
      throw new CloudEnvironmentError("只允许主窗口访问云端运行环境。", "not-sent", 403);
    const id = event.sender.id;
    if (!watched.has(id)) {
      watched.add(id);
      event.sender.once("destroyed", () => {
        watched.delete(id);
        releaseWindow(id);
      });
      event.sender.on("render-process-gone", () => releaseWindow(id));
      event.sender.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) releaseWindow(id);
      });
    }
    for (const [ownerId, record] of owners)
      if (record.windowId === id && record.frame === event.senderFrame) return ownerId;
    const ownerId = ++nextOwner;
    owners.set(ownerId, { windowId: id, frame: event.senderFrame! });
    return ownerId;
  }
  const handlers: Record<string, (owner: number, input: any) => unknown> = {
    discover: (_owner, input) => service.discover(input),
    login: (_owner, input) => service.login(input),
    listBindings: (_owner, input) => service.listBindings(input),
    bind: (_owner, input) => service.bind(input),
    select: (_owner, input) => service.select(input),
    getSelection: (_owner, input) => service.getSelection(input),
    connect: (owner, input) => service.connect(owner, input),
    start: (_owner, input) => service.start(input),
    request: (owner, input) => service.request(owner, input),
    listSessions: (owner, input) => service.listSessions(owner, input),
    readConfiguration: (owner, input) => service.readConfiguration(owner, input),
    upload: (owner, input) => service.upload(owner, input),
    disconnect: (owner, input) => service.disconnect(owner, input),
  };
  for (const [method, handler] of Object.entries(handlers))
    options.ipcMain.handle(
      `cloudEnvironment:${method}`,
      async (event, input): Promise<CloudIpcResult<unknown>> => {
        try {
          return { ok: true, value: await handler(owner(event), input) };
        } catch (error) {
          const detail: CloudRequestError =
            error instanceof CloudEnvironmentError
              ? {
                  message: error.message,
                  kind: error.kind,
                  status: error.status,
                  code: error.code,
                  reason: error.reason,
                }
              : {
                  message: error instanceof Error ? error.message : "云端操作失败。",
                  kind: "not-sent",
                };
          return { ok: false, error: detail };
        }
      },
    );
  return {
    service,
    dispose() {
      service.close();
      owners.clear();
      for (const method of Object.keys(handlers))
        options.ipcMain.removeHandler(`cloudEnvironment:${method}`);
    },
  };
}
