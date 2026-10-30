import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { AccountDeviceService } from "./account-device-service.js";

export function registerAccountDeviceIpc(options: {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  service: AccountDeviceService;
  windows: () => Iterable<BrowserWindow>;
}): { dispose(): void } {
  const owners = new Map<number, { windowId: number; frame: Electron.WebFrameMain }>();
  let sequence = 0;
  const windowFor = (id: number) =>
    [...options.windows()].find(
      (window) =>
        !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.id === id,
    );
  const release = (windowId: number) => {
    for (const [id, record] of owners)
      if (record.windowId === windowId) {
        options.service.releaseOwner(id);
        owners.delete(id);
      }
  };
  const watched = new Set<number>();
  function owner(event: IpcMainInvokeEvent): number {
    if (!windowFor(event.sender.id) || event.senderFrame !== event.sender.mainFrame)
      throw new Error("执行电脑仅允许桌面主窗口访问。");
    if (!watched.has(event.sender.id)) {
      watched.add(event.sender.id);
      event.sender.once("destroyed", () => {
        release(event.sender.id);
        watched.delete(event.sender.id);
      });
      event.sender.on("render-process-gone", () => release(event.sender.id));
      event.sender.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) release(event.sender.id);
      });
    }
    for (const [id, record] of owners)
      if (record.windowId === event.sender.id && record.frame === event.senderFrame) return id;
    const id = ++sequence;
    owners.set(id, { windowId: event.sender.id, frame: event.senderFrame! });
    return id;
  }
  options.service.setEventSink((id, event) => {
    const record = owners.get(id);
    const window = record && windowFor(record.windowId);
    if (window?.webContents.mainFrame === record?.frame)
      window?.webContents.send("accountDevice:event", event);
  });
  const handlers: Record<string, (owner: number, input: any) => unknown> = {
    list: () => options.service.list(),
    projects: (id, input) => options.service.projects(id, input),
    connect: (id, input) => options.service.connect(id, input),
    resume: (id, input) => options.service.resume(id, input),
    send: (id, input) => options.service.send(id, input),
    stop: (id, input) => options.service.stop(id, input),
    approve: (id, input) => options.service.approve(id, input),
    close: (id, input) => options.service.close(id, input),
  };
  for (const [method, handler] of Object.entries(handlers))
    options.ipcMain.handle(`accountDevice:${method}`, async (event, input) => {
      try {
        return { ok: true, value: await handler(owner(event), input) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "电脑操作失败。",
          ...(method === "send"
            ? {
                delivery:
                  (error as { delivery?: unknown })?.delivery === "unknown"
                    ? "unknown"
                    : "not-sent",
              }
            : {}),
        };
      }
    });
  return {
    dispose() {
      options.service.retireIdentity();
      owners.clear();
      for (const method of Object.keys(handlers))
        options.ipcMain.removeHandler(`accountDevice:${method}`);
    },
  };
}
