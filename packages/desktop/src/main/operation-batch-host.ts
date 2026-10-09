import { dialog, ipcMain, type BrowserWindow } from "electron";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  codeShellHome,
  sessionsRoot,
  getCredentialAccess,
  credentialAccessScope,
} from "@cjhyy/code-shell-core";
import { registerOperationBatchIpc } from "./operation-batch-ipc.js";
import { resolveRendererConfigurationTarget } from "./renderer-configuration-authority.js";
import { getTrust, getTrustCachedSync } from "./trust-store.js";
import type { AgentBridge } from "./agent-bridge.js";
export function registerOperationBatchHost(deps: {
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
    authorityRevision: () =>
      JSON.stringify(
        ["projects.json", "trust.json"].map((name) => {
          const info = lstatSync(join(codeShellHome(), "desktop", name), { bigint: true });
          if (!info.isFile() || info.isSymbolicLink())
            throw new Error("Batch project registry unavailable");
          return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
        }),
      ),
    connections: (cwd) => getCredentialAccess().listMasked(cwd, credentialAccessScope("full")),
    confirm: (window, options) => dialog.showMessageBox(window, options),
  });
}
