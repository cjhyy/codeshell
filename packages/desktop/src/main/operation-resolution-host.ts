import { dialog, ipcMain, type BrowserWindow } from "electron";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { codeShellHome, sessionsRoot } from "@cjhyy/code-shell-core";
import {
  createLinkOperationReviewStore,
  createOperationHookHost,
} from "@cjhyy/code-shell-core/internal";
import { registerOperationResolutionIpc } from "./operation-resolution-ipc.js";
import { resolveRendererConfigurationTarget } from "./renderer-configuration-authority.js";
import { getTrust, getTrustCachedSync } from "./trust-store.js";

/** Pin registry revisions without exposing or copying their contents into activity records. */
function authorityRevision(): string {
  return JSON.stringify(
    ["projects.json", "trust.json"].map((name) => {
      const info = lstatSync(join(codeShellHome(), "desktop", name), { bigint: true });
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Operation authority registry unavailable");
      return [name, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
    }),
  );
}

export function registerOperationResolutionHost(deps: {
  windows(): BrowserWindow[];
  enabled(): boolean;
  isSessionRunning(sessionId: string): boolean;
}): () => Promise<void> {
  let hookHost: ReturnType<typeof createOperationHookHost>;
  let disposed = false;
  try {
    // Only the native Host's startup environment may choose this reviewed
    // runtime. Project Settings/env, renderer and model arguments cannot.
    hookHost = createOperationHookHost(process.env.CODESHELL_OPERATION_HOOK_HOST);
  } catch {
    console.warn("Configured operation Hook runtime unavailable; executable Hooks remain blocked");
  }
  const unregister = registerOperationResolutionIpc({
    ...deps,
    enabled: () => !disposed && deps.enabled(),
    ipc: ipcMain,
    store: createLinkOperationReviewStore(sessionsRoot(), hookHost),
    resolveTarget: resolveRendererConfigurationTarget,
    trusted: async (cwd) => (await getTrust(cwd)) === "trusted",
    trustedSync: (cwd) => getTrustCachedSync(cwd) === "trusted",
    authorityRevision,
    confirm: (window, options) => dialog.showMessageBox(window, options),
  });
  return async () => {
    disposed = true;
    unregister();
    await hookHost?.dispose();
  };
}
