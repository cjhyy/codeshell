import { app, dialog, ipcMain, type BrowserWindow } from "electron";
import { operationRegistryRevision } from "./operation-authority.js";
import { operationReviewClient, type OperationClient } from "./desktop-host/private-operations.js";
import type { IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { codeShellHome, sessionsRoot } from "@cjhyy/code-shell-core";
import {
  createLinkOperationReviewStore,
  createOperationHookHost,
} from "@cjhyy/code-shell-core/internal";
import { registerOperationResolutionIpc } from "./operation-resolution-ipc.js";
import { resolveRendererConfigurationTarget } from "./renderer-configuration-authority.js";
import { getTrust, getTrustCachedSync } from "./trust-store.js";

// Capture before later login-shell environment completion. Neither a workspace
// dotenv nor any renderer/cloud request can replace this startup authority.
const nativeHookConfiguration = process.env.CODESHELL_OPERATION_HOOK_HOST;
const nativeHookStateRoot = codeShellHome();

export function registerOperationResolutionHost(deps: {
  host: OperationClient & { withOperationCaller<T>(event: IpcMainInvokeEvent, work: () => T): T };
  windows(): BrowserWindow[];
  enabled(): boolean;
  isSessionRunning(sessionId: string): boolean;
}): () => Promise<void> {
  let hookHost: ReturnType<typeof createOperationHookHost>;
  let disposed = false;
  try {
    const nativeUserData = app.getPath("userData");
    // Only the native Host's startup environment may choose this reviewed
    // runtime. Project Settings/env, renderer and model arguments cannot.
    hookHost = createOperationHookHost(nativeHookConfiguration, {
      stateRoot: nativeHookStateRoot,
      assertStateRootCurrent: () => {
        if (codeShellHome() !== nativeHookStateRoot || app.getPath("userData") !== nativeUserData)
          throw new Error("Native operation Hook state root changed");
      },
      sensitiveRoots: ["cloud-account", "mobile-remote", "Partitions"].map((name) =>
        join(nativeUserData, name),
      ),
    });
  } catch {
    console.warn("Configured operation Hook runtime unavailable; executable Hooks remain blocked");
  }
  const unregister = registerOperationResolutionIpc({
    ...deps,
    enabled: () => !disposed && deps.enabled(),
    ipc: ipcMain,
    withCaller: deps.host.withOperationCaller,
    store: {
      ...operationReviewClient(deps.host),
      reconcile: createLinkOperationReviewStore(sessionsRoot(), hookHost).reconcile,
    },
    resolveTarget: resolveRendererConfigurationTarget,
    trusted: async (cwd) => (await getTrust(cwd)) === "trusted",
    trustedSync: (cwd) => getTrustCachedSync(cwd) === "trusted",
    authorityRevision: operationRegistryRevision,
    confirm: (window, options) => dialog.showMessageBox(window, options),
  });
  return async () => {
    disposed = true;
    unregister();
    await hookHost?.dispose();
  };
}
