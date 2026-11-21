import { dialog, ipcMain, type BrowserWindow } from "electron";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { operationRegistryRevision } from "./operation-authority.js";
import { buildCredentialSnapshot } from "./credential-access-service.js";
import type { OperationClient } from "./desktop-host/private-operations.js";
import type { IpcMainInvokeEvent } from "electron";
import { registerOperationBatchIpc } from "./operation-batch-ipc.js";
import { resolveRendererConfigurationTarget } from "./renderer-configuration-authority.js";
import { getTrust, getTrustCachedSync } from "./trust-store.js";
import type { AgentBridge } from "./agent-bridge.js";
export function registerOperationBatchHost(deps: {
  host: {
    captureOperationClient(): OperationClient;
    withOperationCaller<T>(event: IpcMainInvokeEvent, work: () => T): T;
  };
  windows(): BrowserWindow[];
  enabled(): boolean;
  isSessionRunning(sessionId: string): boolean;
  bridge(): AgentBridge | undefined;
}) {
  return registerOperationBatchIpc({
    ...deps,
    ipc: ipcMain,
    root: sessionsRoot(),
    resolveTarget: resolveRendererConfigurationTarget,
    trusted: async (cwd) => (await getTrust(cwd)) === "trusted",
    trustedSync: (cwd) => getTrustCachedSync(cwd) === "trusted",
    authorityRevision: operationRegistryRevision,
    withCaller: deps.host.withOperationCaller,
    captureClient: deps.host.captureOperationClient,
    connections: async (cwd) =>
      (await buildCredentialSnapshot([cwd], 0, true)).entries.find((entry) => entry.cwd === cwd)
        ?.full ?? [],
    confirm: (window, options) => dialog.showMessageBox(window, options),
  });
}
