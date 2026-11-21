import type { CredentialFileCommand } from "@cjhyy/code-shell-core/internal/storage";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DesktopHostIdentity } from "../../shared/desktop-host-protocol.js";
import { join } from "node:path";
import {
  app,
  ipcMain,
  MessageChannelMain,
  utilityProcess,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import type { WorkerBridgeCoreOptions } from "@cjhyy/code-shell-server/worker";
import { DesktopHostWorkerClient } from "./main-worker.js";
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
  hostReady?: () => void,
) {
  let worker: DesktopHostWorkerClient | undefined;
  const supervisor: DesktopHostSupervisor = new DesktopHostSupervisor(
    () =>
      utilityProcess.fork(entryPath, [join(app.getPath("userData"), "task-inbox")], {
        serviceName: "CodeShell Desktop Host",
      }),
    () => app.getVersion(),
    (status) => {
      if (status === "ready") bindWorker();
      else worker?.disconnect();
      workbenches.setStatus(status);
      if (status === "ready") hostReady?.();
    },
    (message, details) => dlog("main", `desktop_host.${message}`, details),
  );
  const workbenches = new HostWorkbenchPorts(
    (event) => navigation.assertSender(event),
    () => new MessageChannelMain(),
    (message, ports) => supervisor.post(message, ports),
  );
  const intentCaller = new AsyncLocalStorage<DesktopHostIdentity>();
  function bindWorker() {
    if (!worker) return;
    const { port1, port2 } = new MessageChannelMain();
    if (
      supervisor.post(
        { type: "worker-port", execPath: process.execPath, entryPath: worker.options.entryPath },
        [port2],
      )
    )
      worker.bind(port1);
    else {
      port1.close();
      port2.close();
    }
  }
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
    createWorkerBridge(options: WorkerBridgeCoreOptions) {
      if (worker) throw new Error("Desktop Host already has a worker bridge");
      worker = new DesktopHostWorkerClient(options);
      bindWorker();
      return worker;
    },
    async listDiskSessions(options: ListSessionOptions) {
      changes?.flush();
      try {
        return await supervisor.listDiskSessions(options);
      } catch {
        return listJson(options);
      }
    },
    async readWorkbenchOutput(
      event: Pick<IpcMainEvent, "sender" | "senderFrame">,
      sessionId: string,
      sinceSeq: number,
    ) {
      const caller = workbenches.identity(event);
      const result = await supervisor.readWorkbenchOutput(caller, sessionId, sinceSeq);
      if (workbenches.identity(event) !== caller) throw new Error("Workbench document changed");
      return result;
    },
    withDocumentCaller<T>(event: Pick<IpcMainEvent, "sender" | "senderFrame">, work: () => T): T {
      return intentCaller.run(workbenches.identity(event), work);
    },
    credentialCommand<T>(command: CredentialFileCommand, payload: unknown): Promise<T> {
      return supervisor.credentialCommand(command, payload, intentCaller.getStore());
    },
    taskCommand<T>(command: string, payload?: unknown) {
      return supervisor.taskCommand<T>(
        command,
        payload,
        command === "tasks/intent" ? intentCaller.getStore() : undefined,
      );
    },
    sessionsChanged: (ids: string[]) => changes?.add(ids),
    trackWorkbench: (contents: WebContents) => workbenches.track(contents),
    setStreamView: (sessionId: string, enabled: boolean) =>
      supervisor.setStreamView(sessionId, enabled),
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
