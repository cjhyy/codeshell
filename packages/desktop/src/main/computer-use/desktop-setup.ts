import { globalShortcut, Notification, powerMonitor, type App } from "electron";
import { join } from "node:path";
import { SettingsManager } from "@cjhyy/code-shell-core/extension";
import { readUserFeatureFlags } from "../capability-modules-env.js";
import { resolveComputerUseBundle, type CuaDriverHostOptions } from "./cua-driver-host.js";
import {
  createComputerUsePermissionsController,
  resolveComputerUsePermissionsHelper,
  type ComputerUsePermissionsOptions,
} from "./permissions.js";
import {
  registerComputerUseSettingsIpc,
  type ComputerUseSettingsDependencies,
} from "./settings-ipc.js";
import {
  getCuaDriverHost,
  initCuaComputerUse,
  resetCuaComputerUse,
  setComputerUseControl,
} from "./service.js";
import { loadAppProfiles } from "./app-profiles.js";
import {
  createMimiCompanionHost,
  type MimiCompanionHost,
  type MimiCompanionPresenceHooks,
} from "./mimi-companion-host.js";
import { createComputerUseControl, type ComputerUseControl } from "./computer-use-control.js";

let companion: MimiCompanionHost | undefined;
let control: ComputerUseControl | undefined;
let movingUnavailableReason: string | undefined = "电脑操作尚未初始化";

/** The moving Mimi surface, when this platform and its execution gate allow one. */
export function getMimiCompanion(): MimiCompanionHost | undefined {
  return companion;
}

/** Why the moving Mimi surface is missing, shown next to the disabled option. */
export function mimiMovingUnavailableReason(): string | undefined {
  return companion ? undefined : movingUnavailableReason;
}

/** Execution gate controls for Mimi surfaces other than the moving character. */
export function getComputerUseInputControl() {
  return inputControl(control);
}

/** Close the character first, then the execution gate and its socket. */
export async function closeComputerUse(): Promise<void> {
  const previousCompanion = companion;
  const previousControl = control;
  companion = undefined;
  control = undefined;
  movingUnavailableReason = "电脑操作已关闭";
  setComputerUseControl(undefined);
  await previousCompanion?.close();
  await previousControl?.close();
}

function inputControl(current: ComputerUseControl | undefined) {
  return current
    ? {
        status: () => current.gate.status(),
        stop: () => current.stopInput("settings"),
        resume: () => current.resumeInput("settings"),
      }
    : undefined;
}

/** Compose the opt-in daemon and its desktop-only setup authority after app readiness. */
export async function initializeDesktopComputerUse(options: {
  app: Pick<App, "isPackaged" | "getAppPath" | "getPath" | "relaunch" | "quit">;
  ipcMain: ComputerUseSettingsDependencies["ipcMain"];
  isMainWindow: ComputerUseSettingsDependencies["isMainWindow"];
  openExternal: ComputerUsePermissionsOptions["openExternal"];
  cwd(): string;
  platform: NodeJS.Platform;
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
  log: NonNullable<CuaDriverHostOptions["log"]>;
  openCompanionChat(request?: { prompt: string }): Promise<void>;
  /** Mimi chat surfaces (main-window Mimi page, docked inline chat). */
  isCompanionChatSurface?: ComputerUseSettingsDependencies["isMainWindow"];
  /** Hooks into the single Mimi presence owner (Desktop main). */
  companionPresence?: MimiCompanionPresenceHooks;
  /** Legacy computerUse:setCompanion/previewCompanion, routed through that owner. */
  companionSettings?: ComputerUseSettingsDependencies["companion"];
}): Promise<void> {
  const appProfilesDir = options.app.isPackaged
    ? join(options.resourcesPath, "packages", "desktop", "resources", "computer-use", "apps")
    : join(options.app.getAppPath(), "resources", "computer-use", "apps");
  if (options.platform === "darwin") {
    control = await createComputerUseControl({
      appPath: options.app.getAppPath(),
      appProfilesDir,
      executablePath: process.execPath,
      log: options.log,
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      shortcut: {
        register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
        unregister: (accelerator) => globalShortcut.unregister(accelerator),
      },
      notifyStopped: () => {
        if (!Notification.isSupported()) return;
        new Notification({
          title: "已停止电脑操作",
          body: "AI 不会再发送键盘或鼠标输入。在 Mimi 菜单或设置里点“继续”才会恢复。",
        }).show();
      },
    }).catch((error) => {
      // Without the gate there is no proxy, and the driver is not offered at all.
      options.log("computer_use_control_failed", { error: String(error) });
      return undefined;
    });
    setComputerUseControl(control);
  }
  movingUnavailableReason =
    options.platform !== "darwin"
      ? "移动模式目前仅支持 macOS"
      : "电脑操作执行闸门未能启动，移动模式不可用";
  if (control) {
    const executionControl = control;
    companion = await createMimiCompanionHost({
      appPath: options.app.getAppPath(),
      resourcesPath: options.resourcesPath,
      packaged: options.app.isPackaged,
      devUrl: options.env.VITE_DEV_URL,
      isMainWindow: options.isMainWindow,
      isChatSurface: options.isCompanionChatSurface,
      presence: options.companionPresence,
      log: options.log,
      openChat: options.openCompanionChat,
      bus: executionControl.bus,
      gate: executionControl.gate,
      appProfiles: loadAppProfiles(appProfilesDir, (file, error) =>
        options.log("computer_use_app_profile_skipped", { file, error }),
      ),
    }).catch((error) => {
      options.log("mimi_companion_setup_failed", { error: String(error) });
      movingUnavailableReason = "移动角色初始化失败，移动模式不可用";
      return undefined;
    });
  }
  const decision = initCuaComputerUse({
    flags: readUserFeatureFlags(options.cwd()),
    platform: options.platform,
    isPackaged: options.app.isPackaged,
    resourcesPath: options.resourcesPath,
    appPath: options.app.getAppPath(),
    env: options.env,
    log: options.log,
    mcpProxy: control?.mcpProxy,
    requireProxy: options.platform === "darwin",
  });
  options.log("cua_driver_decision", decision.enabled ? { enabled: true } : decision);
  if (decision.enabled) {
    await decision.host.start().catch((error) => {
      options.log("cua_driver_start_failed", { error: String(error) });
    });
  }
  const permissions = createComputerUsePermissionsController({
    platform: options.platform,
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
      !!resolveComputerUseBundle({
        appPath: options.app.getAppPath(),
        isPackaged: options.app.isPackaged,
        resourcesPath: options.resourcesPath,
      }),
    packaged: options.app.isPackaged,
    permissions,
    companion: options.companionSettings,
    input: inputControl(control),
    stop: resetCuaComputerUse,
    restart: () => {
      options.app.relaunch();
      options.app.quit();
    },
  });
}
