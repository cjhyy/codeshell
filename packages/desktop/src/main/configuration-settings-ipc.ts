import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import { rendererConfigurationCwd } from "./renderer-configuration-helpers.js";
import type { RendererConfigurationTarget } from "../shared/renderer-configuration.js";
import { readSettings, type SettingsScope } from "./settings-service.js";
import { validateRendererSettingsPatch } from "./renderer-settings-edits.js";

export function registerConfigurationSettingsIpc(
  ipcMain: Pick<IpcMain, "handle">,
  host: {
    callBusiness: CallShellBusiness;
    documentSignal(event: IpcMainInvokeEvent): AbortSignal;
  },
) {
  ipcMain.handle("settings:get", async (_e, scope: SettingsScope) => {
    if (scope !== "user") throw new Error("settings:get is user-scoped");
    return readSettings("user");
  });
  ipcMain.handle("settings:getConfiguration", async (_e, target: RendererConfigurationTarget) =>
    readSettings("project", await rendererConfigurationCwd(target)),
  );
  ipcMain.handle("settings:set", (event, scope: SettingsScope, patch: unknown) => {
    const signal = host.documentSignal(event);
    if (scope !== "user") throw new Error("settings:set is user-scoped");
    validateRendererSettingsPatch(patch);
    return host.callBusiness("settings/patch", { scope, patch }, signal);
  });
  ipcMain.handle(
    "settings:setConfiguration",
    (event, target: RendererConfigurationTarget, patch: unknown) => {
      const signal = host.documentSignal(event);
      validateRendererSettingsPatch(patch);
      return host.callBusiness("settings/patch", { scope: "project", target, patch }, signal);
    },
  );
}
