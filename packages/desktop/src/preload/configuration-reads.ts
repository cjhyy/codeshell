import type { IpcRenderer } from "electron";
import type { DesktopBusinessReads } from "../shared/desktop-business-contracts.js";
import type { DesktopHostClient } from "./desktop-host-client.js";

export function createConfigurationReads(
  ipcRenderer: Pick<IpcRenderer, "invoke">,
  host?: DesktopHostClient,
) {
  function read<K extends keyof DesktopBusinessReads>(
    name: K,
    params: DesktopBusinessReads[K]["params"],
    fallback: () => Promise<DesktopBusinessReads[K]["result"]>,
  ) {
    return host ? host.readBusiness(name, params, fallback) : fallback();
  }
  return {
    listProjects: (fallback: () => Promise<DesktopBusinessReads["projects/list"]["result"]>) =>
      read("projects/list", {}, fallback),
    recents: () => read("projects/recents", {}, () => ipcRenderer.invoke("recents:list")),
    getTrust: (path: string) =>
      read("projects/trust", { path }, () => ipcRenderer.invoke("trust:get", path)),
    getTrustRisks: (path: string) =>
      read("projects/trustRisks", { path }, () => ipcRenderer.invoke("trust:risks", path)),
    getSettings: (scope: "user") =>
      read("settings/user", { scope }, () => ipcRenderer.invoke("settings:get", scope)),
    listSourceCatalog: () => read("sources/catalog", {}, () => ipcRenderer.invoke("sources:catalogList")),
    projectSourceAccess: (projectId: string) =>
      read("sources/projectAccess", { projectId }, () =>
        ipcRenderer.invoke("sources:projectAccess", projectId),
      ),
    listSourceScopes: (sourceId: string) =>
      read("sources/scopes", { sourceId }, () => ipcRenderer.invoke("sources:listScopes", sourceId)),
    getPluginDetail: (installKey: string) =>
      read("plugins/detail", { installKey }, () => ipcRenderer.invoke("plugins:detail", installKey)),
    getPluginMedia: (installKey: string, includeScreenshots?: boolean) =>
      read("plugins/media", { installKey, includeScreenshots }, () =>
        ipcRenderer.invoke("plugins:media", installKey, includeScreenshots),
      ),
    listPluginMcpTrust: () => read("mcp/pluginTrust", {}, () => ipcRenderer.invoke("mcp:listPluginTrust")),
    getModelCatalog: () => read("models/catalog", {}, () => ipcRenderer.invoke("catalog:list")),
    getCatalogOrigins: () => read("models/catalogOrigins", {}, () => ipcRenderer.invoke("catalog:origins")),
  };
}
