import { ipcRenderer, type IpcRendererEvent } from "electron";
import type { AccountFeaturesApi, AccountFeatureSnapshot } from "../shared/account-features.js";
export const accountFeaturesApi: AccountFeaturesApi = {
  snapshot: () => ipcRenderer.invoke("accountFeatures:snapshot"),
  refresh: (origin) => ipcRenderer.invoke("accountFeatures:refresh", origin),
  onChanged(callback) {
    const listener = (_event: IpcRendererEvent, snapshot: AccountFeatureSnapshot) =>
      callback(snapshot);
    ipcRenderer.on("accountFeatures:changed", listener);
    return () => ipcRenderer.removeListener("accountFeatures:changed", listener);
  },
};
