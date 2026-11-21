import {
  app,
  ipcMain,
  MessageChannelMain,
  utilityProcess,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { listDiskSessions as listJson } from "@cjhyy/code-shell-server/storage";
import type { ListSessionOptions } from "../../shared/disk-session-query.js";
import { createSessionIndexChanges } from "./session-index-changes.js";
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
  let changes: ReturnType<typeof createSessionIndexChanges> | undefined;
  const connect = (event: IpcMainEvent) => workbenches.connect(event);
  return {
    start() {
      ipcMain.removeListener(DesktopHostIpc.connect, connect);
      ipcMain.on(DesktopHostIpc.connect, connect);
      changes ??= createSessionIndexChanges(sessionsRoot(), (ids) => {
        supervisor.post({ type: "session-index-changed", ids });
      });
      supervisor.start();
    },
    async listDiskSessions(options: ListSessionOptions) {
      changes?.flush();
      try {
        return await supervisor.listDiskSessions(options);
      } catch {
        return listJson(options);
      }
    },
    sessionsChanged: (ids: string[]) => changes?.add(ids),
    trackWorkbench: (contents: WebContents) => workbenches.track(contents),
    setOwner: (sessionId: string, owner: number | null) => supervisor.setOwner(sessionId, owner),
    setDeleting: (sessionId: string, deleting: boolean) =>
      supervisor.setDeleting(sessionId, deleting),
    dispose() {
      changes?.close();
      changes = undefined;
      ipcMain.removeListener(DesktopHostIpc.connect, connect);
      return supervisor.dispose();
    },
  };
}
