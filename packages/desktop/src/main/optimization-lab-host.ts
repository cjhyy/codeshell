import { dialog, ipcMain } from "electron";
import { SettingsManager } from "@cjhyy/code-shell-core";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import type { AgentBridge } from "./agent-bridge.js";
import { registerOptimizationLabIpc } from "./optimization-lab-ipc.js";

type LabIpcDeps = Parameters<typeof registerOptimizationLabIpc>[0];

/** Native adapters stay outside the main entry; authority checks live in the IPC registrar. */
export function registerOptimizationLabHost(deps: {
  windows: LabIpcDeps["windows"];
  business: CallShellBusiness;
  documentSignal: LabIpcDeps["documentSignal"];
  settingsCwd(): string;
  resolveTarget: LabIpcDeps["resolveTarget"];
  trust(cwd: string): Promise<string>;
  bridge(): AgentBridge | null;
}): () => void {
  return registerOptimizationLabIpc({
    ipc: ipcMain,
    windows: deps.windows,
    enabled: () =>
      new SettingsManager(deps.settingsCwd(), "full").getForScope("user").featureFlags
        ?.optimization_lab === true,
    waitForWorkerHost: async () => {
      await deps.bridge()?.waitForWorkerHost();
    },
    resolveTarget: deps.resolveTarget,
    trusted: async (cwd) => (await deps.trust(cwd)) === "trusted",
    documentSignal: deps.documentSignal,
    files: (scope, signal) => ({
      skills: () => deps.business("lab/skills", scope, signal),
      evidence: (runIds) => deps.business("lab/evidence", { ...scope, runIds }, signal),
      readPicked: (path) => deps.business("lab/readPicked", { ...scope, path }, signal),
      writePicked: async (path, content, revalidate) => {
        await revalidate();
        await deps.business("lab/writePicked", { ...scope, path, content }, signal);
      },
    }),
    query: async (type, params) => {
      const bridge = deps.bridge();
      if (!bridge) throw new Error("Optimization Lab worker is unavailable");
      return bridge.requestOptimizationLab(type, params);
    },
    confirm: (window, options) => dialog.showMessageBox(window, options),
    save: async (window, name) => {
      const result = await dialog.showSaveDialog(window, {
        defaultPath: name,
        filters: [{ name: "Optimization Lab", extensions: [name.endsWith(".md") ? "md" : "json"] }],
      });
      return result.canceled ? undefined : result.filePath;
    },
    choose: async (window) => {
      const result = await dialog.showOpenDialog(window, {
        properties: ["openFile"],
        filters: [{ name: "Optimization Lab JSON", extensions: ["json"] }],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
}
