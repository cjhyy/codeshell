import { documentLifetimes } from "./document-lifetime.js";
import type { OperationCommand } from "./private-operations.js";
import type { CredentialFileCommand } from "@cjhyy/code-shell-core/internal/storage";
import { isDesktopAgentMethod } from "../../shared/desktop-agent-methods.js";
import { isRpcRequest } from "../../shared/desktop-host-protocol.js";
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
import { sessionsRoot, getDefaultCredentialCipher } from "@cjhyy/code-shell-core";
import { listDiskSessions as listJson } from "@cjhyy/code-shell-server/storage";
import type { SettingsChange } from "../../shared/settings-change.js";
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
  settingsCommitted?: (effects: SettingsChange) => Promise<void>,
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
  supervisor.settingsCommitted = settingsCommitted;
  const workbenches = new HostWorkbenchPorts(
    (event) => navigation.assertSender(event),
    () => new MessageChannelMain(),
    (message, ports) => supervisor.post(message, ports),
  );
  const intentCaller = new AsyncLocalStorage<DesktopHostIdentity>();
  const documentSignal = documentLifetimes((event) => navigation.assertSender(event));
  const operationCaller = new AsyncLocalStorage<{
    caller: DesktopHostIdentity;
    signal: AbortSignal;
  }>();
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
    callBusiness: supervisor.callBusiness.bind(supervisor),
    documentSignal,
    catalogListeners: supervisor.catalogListeners,
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
      worker = new DesktopHostWorkerClient(
        options,
        (identity) => workbenches.assertIdentity(identity),
        (event, line) => {
          navigation.assertSender(event);
          if (!workbenches.tracks(event.sender)) return false;
          let req: unknown;
          try {
            req = JSON.parse(line);
          } catch {
            return true;
          }
          if (!isRpcRequest(req)) return true;
          const { id, method, params } = req;
          const frame = event.senderFrame;
          const send = (payload: Record<string, unknown>) => {
            if (
              frame &&
              !frame.detached &&
              !frame.isDestroyed() &&
              !event.sender.isDestroyed() &&
              event.sender.mainFrame === frame
            )
              frame.send("agent:msg", JSON.stringify({ jsonrpc: "2.0", id, ...payload }));
          };
          void Promise.resolve()
            .then(async () => {
              if (!isDesktopAgentMethod(method)) throw new Error("Unrecognized workbench command");
              const caller = workbenches.identity(event);
              const result = await supervisor.workbenchCommand(caller, method, params ?? {});
              if (workbenches.identity(event) === caller) send({ result });
            })
            .catch((error) =>
              send({
                error: {
                  code: typeof error?.code === "number" ? error.code : -32010,
                  ...(error?.data === undefined ? {} : { data: error.data }),
                  message: error instanceof Error ? error.message : "Workbench unavailable",
                },
              }),
            );
          return true;
        },
      );
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
    withOperationCaller<T>(event: Pick<IpcMainEvent, "sender" | "senderFrame">, work: () => T): T {
      return operationCaller.run(
        { caller: workbenches.identity(event), signal: documentSignal(event) },
        work,
      );
    },
    async operationCommand<T>(
      action: OperationCommand,
      payload: Record<string, unknown>,
    ): Promise<T> {
      const origin = operationCaller.getStore();
      if (!origin) throw new Error("Operation requires its native workbench document");
      const { wrapped } = (await supervisor.callBusiness(
        "operations/ledger",
        { action: "host/operationKey", payload: {}, caller: origin.caller },
        origin.signal,
      )) as { wrapped: string | null };
      const cipher = getDefaultCredentialCipher().asynchronous;
      if (!cipher) throw new Error("Operation keyring unavailable");
      const key = wrapped === null ? null : { wrapped, secret: await cipher.decrypt(wrapped) };
      if (key && !/^[a-f0-9]{64}$/.test(key.secret))
        throw new Error("Invalid protected operation key");
      origin.signal.throwIfAborted();
      return supervisor.callBusiness(
        "operations/ledger",
        { action, payload: { ...payload, key }, caller: origin.caller },
        origin.signal,
      ) as Promise<T>;
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
