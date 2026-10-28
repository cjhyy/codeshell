import type { App } from "electron";
import { SettingsManager } from "@cjhyy/code-shell-core/extension";
import { readUserFeatureFlags } from "../capability-modules-env.js";
import { resolveCuaDriverPath, type CuaDriverHostOptions } from "./cua-driver-host.js";
import {
  createComputerUsePermissionsController,
  resolveComputerUsePermissionsHelper,
  type ComputerUsePermissionsOptions,
} from "./permissions.js";
import {
  registerComputerUseSettingsIpc,
  type ComputerUseSettingsDependencies,
} from "./settings-ipc.js";
import { getCuaDriverHost, initCuaComputerUse, resetCuaComputerUse } from "./service.js";
import { createMimiCompanionHost, type MimiCompanionHost } from "./mimi-companion-host.js";

let companion: MimiCompanionHost | undefined;

export async function closeMimiCompanion(): Promise<void> {
  const previous = companion;
  companion = undefined;
  await previous?.close();
}

/** Compose the opt-in daemon and its desktop-only setup authority after app readiness. */
export async function initializeDesktopComputerUse(options: {
  app: Pick<App, "isPackaged" | "getAppPath" | "getPath" | "relaunch" | "quit">;
  ipcMain: ComputerUseSettingsDependencies["ipcMain"];
  isMainWindow: ComputerUseSettingsDependencies["isMainWindow"];
  systemPreferences: ComputerUsePermissionsOptions["systemPreferences"];
  openExternal: ComputerUsePermissionsOptions["openExternal"];
  cwd(): string;
  platform: NodeJS.Platform;
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
  log: NonNullable<CuaDriverHostOptions["log"]>;
  openCompanionChat(): Promise<void>;
}): Promise<void> {
  if (options.platform === "darwin") {
    companion = await createMimiCompanionHost({
      appPath: options.app.getAppPath(),
      resourcesPath: options.resourcesPath,
      userDataPath: options.app.getPath("userData"),
      executablePath: process.execPath,
      packaged: options.app.isPackaged,
      devUrl: options.env.VITE_DEV_URL,
      isMainWindow: options.isMainWindow,
      log: options.log,
      openChat: options.openCompanionChat,
    }).catch((error) => {
      options.log("mimi_companion_setup_failed", { error: String(error) });
      return undefined;
    });
  }
  const decision = initCuaComputerUse({
    flags: readUserFeatureFlags(options.cwd()),
    platform: options.platform,
    isPackaged: options.app.isPackaged,
    resourcesPath: options.resourcesPath,
    env: options.env,
    log: options.log,
    mcpProxy: companion?.mcpProxy,
  });
  options.log("cua_driver_decision", decision.enabled ? { enabled: true } : decision);
  if (decision.enabled) {
    await decision.host.start().catch((error) => {
      options.log("cua_driver_start_failed", { error: String(error) });
    });
  }
  const permissions = createComputerUsePermissionsController({
    platform: options.platform,
    systemPreferences: options.systemPreferences,
    openExternal: options.openExternal,
    parentEnv: options.env,
    helperPath: resolveComputerUsePermissionsHelper({
      isPackaged: options.app.isPackaged,
      resourcesPath: options.resourcesPath,
      appPath: options.app.getAppPath(),
    }),
  });
  registerComputerUseSettingsIpc({
    ipcMain: options.ipcMain,
    isMainWindow: options.isMainWindow,
    getEnabled: () => readUserFeatureFlags(options.cwd()).computer_use_cua === true,
    saveEnabled: (enabled) => {
      const cwd = options.cwd();
      new SettingsManager(cwd, "full").mutateSettingsForScope("user", cwd, (current) => {
        const flags = current.featureFlags;
        current.featureFlags = {
          ...(flags && typeof flags === "object" && !Array.isArray(flags) ? flags : {}),
          computer_use_cua: enabled,
        };
      });
    },
    isActive: () => getCuaDriverHost()?.status().state === "running",
    driverAvailable: () =>
      !!resolveCuaDriverPath({
        env: options.env,
        isPackaged: options.app.isPackaged,
        resourcesPath: options.resourcesPath,
      }),
    packaged: options.app.isPackaged,
    permissions,
    companion,
    stop: resetCuaComputerUse,
    restart: () => {
      options.app.relaunch();
      options.app.quit();
    },
  });
}
