import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type {
  ComputerUsePermissionKind,
  ComputerUsePermissionStatus,
  ComputerUseSettingsStatus,
} from "../../shared/computer-use.js";

export interface ComputerUseSettingsDependencies {
  ipcMain: Pick<IpcMain, "handle">;
  isMainWindow(sender: WebContents): boolean;
  getEnabled(): boolean;
  saveEnabled(enabled: boolean): void;
  isActive(): boolean;
  driverAvailable(): boolean;
  packaged: boolean;
  permissions: {
    status(): Promise<ComputerUsePermissionStatus>;
    request(kind: ComputerUsePermissionKind): Promise<ComputerUsePermissionStatus>;
    openSettings(kind: ComputerUsePermissionKind): Promise<void>;
  };
  stop(): Promise<void>;
  restart(): void;
}

/** Desktop-only setup authority. Never exposed to agent tools or Panel guests. */
export function registerComputerUseSettingsIpc(deps: ComputerUseSettingsDependencies): void {
  let changed = false;
  let mutationPending = false;
  const owner = (event: IpcMainInvokeEvent) => {
    if (
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      !deps.isMainWindow(event.sender)
    ) {
      throw new Error("电脑操作授权只能由桌面主窗口管理。");
    }
  };
  const kind = (value: unknown): ComputerUsePermissionKind => {
    if (value !== "accessibility" && value !== "screenRecording") {
      throw new Error("未知的电脑操作权限。");
    }
    return value;
  };
  const status = async (
    current?: ComputerUsePermissionStatus,
  ): Promise<ComputerUseSettingsStatus> => {
    const permissions = current ?? (await deps.permissions.status());
    return {
      enabled: deps.getEnabled(),
      active: deps.isActive(),
      driverAvailable: deps.driverAvailable(),
      packaged: deps.packaged,
      restartRequired: changed || permissions.restartRequired,
      permissions,
    };
  };
  const mutate = async <T>(work: () => Promise<T>): Promise<T> => {
    if (mutationPending) throw new Error("正在处理电脑操作设置，请稍候。");
    mutationPending = true;
    try {
      return await work();
    } finally {
      mutationPending = false;
    }
  };

  deps.ipcMain.handle("computerUse:status", (event) => {
    owner(event);
    return status();
  });
  deps.ipcMain.handle("computerUse:setEnabled", (event, enabled: unknown) => {
    owner(event);
    if (typeof enabled !== "boolean") throw new Error("电脑操作开关必须为布尔值。");
    return mutate(async () => {
      const permissions = await deps.permissions.status();
      if (enabled && !permissions.supported) throw new Error("电脑操作目前仅支持 macOS。");
      if (enabled && !deps.driverAvailable()) throw new Error("未找到电脑操作驱动。");
      // Re-check the owner after the asynchronous read, before persisting.
      owner(event);
      if (enabled !== deps.getEnabled()) {
        deps.saveEnabled(enabled);
        changed = true;
      }
      if (!enabled) await deps.stop();
      return status(permissions);
    });
  });
  deps.ipcMain.handle("computerUse:requestPermission", (event, value: unknown) => {
    owner(event);
    const permission = kind(value);
    return mutate(async () => {
      if (!deps.getEnabled()) throw new Error("请先启用电脑操作。");
      return status(await deps.permissions.request(permission));
    });
  });
  deps.ipcMain.handle("computerUse:openSettings", (event, value: unknown) => {
    owner(event);
    return deps.permissions.openSettings(kind(value));
  });
  deps.ipcMain.handle("computerUse:restart", (event) => {
    owner(event);
    if (mutationPending) throw new Error("请等待当前授权请求完成后再重启。");
    deps.restart();
  });
}
