import {
  app,
  ipcMain,
  MessageChannelMain,
  utilityProcess,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import { DesktopHostIpc } from "../../shared/desktop-host-protocol.js";
import type { AppRendererNavigation } from "../app-renderer-navigation.js";
import { dlog } from "../desktop-logger.js";
import { DesktopHostSupervisor } from "./main-supervisor.js";
import { HostWorkbenchPorts } from "./main-workbenches.js";

/** One utility process per Desktop instance, shared by independently authenticated workbenches. */
export function createDesktopHost(
  entryPath: string,
  navigation: Pick<AppRendererNavigation, "assertSender">,
) {
  const supervisor: DesktopHostSupervisor = new DesktopHostSupervisor(
    () => utilityProcess.fork(entryPath, [], { serviceName: "CodeShell Desktop Host" }),
    () => app.getVersion(),
    (status) => workbenches.setStatus(status),
    (message, details) => dlog("main", `desktop_host.${message}`, details),
  );
  const workbenches = new HostWorkbenchPorts(
    (event) => navigation.assertSender(event),
    () => new MessageChannelMain(),
    (message, ports) => supervisor.post(message, ports),
  );
  const connect = (event: IpcMainEvent) => workbenches.connect(event);
  return {
    start() {
      ipcMain.removeListener(DesktopHostIpc.connect, connect);
      ipcMain.on(DesktopHostIpc.connect, connect);
      supervisor.start();
    },
    trackWorkbench: (contents: WebContents) => workbenches.track(contents),
    setOwner: (sessionId: string, owner: number | null) => supervisor.setOwner(sessionId, owner),
    setDeleting: (sessionId: string, deleting: boolean) =>
      supervisor.setDeleting(sessionId, deleting),
    dispose() {
      ipcMain.removeListener(DesktopHostIpc.connect, connect);
      return supervisor.dispose();
    },
  };
}
