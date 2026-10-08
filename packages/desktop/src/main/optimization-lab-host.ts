import { dialog, ipcMain } from "electron";
import { SettingsManager } from "@cjhyy/code-shell-core/internal";
import type { AgentBridge } from "./agent-bridge.js";
import { registerOptimizationLabIpc } from "./optimization-lab-ipc.js";
import { listSkills } from "./skills-service.js";

type LabIpcDeps = Parameters<typeof registerOptimizationLabIpc>[0];

/** Native adapters stay outside the main entry; authority checks live in the IPC registrar. */
export function registerOptimizationLabHost(deps: {
  windows: LabIpcDeps["windows"];
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
    resolveTarget: deps.resolveTarget,
    trusted: async (cwd) => (await deps.trust(cwd)) === "trusted",
    query: async (type, params) => {
      const bridge = deps.bridge();
      if (!bridge) throw new Error("Optimization Lab worker is unavailable");
      return bridge.requestOptimizationLab(type, params);
    },
    skills: (cwd) => listSkills(cwd),
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
        filters: [{ name: "Grading JSON", extensions: ["json"] }],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
}
