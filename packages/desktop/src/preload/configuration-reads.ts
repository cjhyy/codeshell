import type { IpcRenderer } from "electron";
import type { DesktopBusinessReads } from "../shared/desktop-business-contracts.js";
import type { DesktopHostClient } from "./desktop-host-client.js";

export function createConfigurationReads(
  ipc: Pick<IpcRenderer, "invoke">,
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
    recents: () => read("projects/recents", {}, () => ipc.invoke("recents:list")),
    getTrust: (path: string) =>
      read("projects/trust", { path }, () => ipc.invoke("trust:get", path)),
    getTrustRisks: (path: string) =>
      read("projects/trustRisks", { path }, () => ipc.invoke("trust:risks", path)),
    getSettings: (scope: "user") =>
      read("settings/user", { scope }, () => ipc.invoke("settings:get", scope)),
    listSourceCatalog: () => read("sources/catalog", {}, () => ipc.invoke("sources:catalogList")),
    projectSourceAccess: (projectId: string) =>
      read("sources/projectAccess", { projectId }, () =>
        ipc.invoke("sources:projectAccess", projectId),
      ),
    listSourceScopes: (sourceId: string) =>
      read("sources/scopes", { sourceId }, () => ipc.invoke("sources:listScopes", sourceId)),
    getPluginDetail: (installKey: string) =>
      read("plugins/detail", { installKey }, () => ipc.invoke("plugins:detail", installKey)),
    getPluginMedia: (installKey: string, includeScreenshots?: boolean) =>
      read("plugins/media", { installKey, includeScreenshots }, () =>
        ipc.invoke("plugins:media", installKey, includeScreenshots),
      ),
    listPluginMcpTrust: () => read("mcp/pluginTrust", {}, () => ipc.invoke("mcp:listPluginTrust")),
    getModelCatalog: () => read("models/catalog", {}, () => ipc.invoke("catalog:list")),
    getCatalogOrigins: () => read("models/catalogOrigins", {}, () => ipc.invoke("catalog:origins")),
  };
}
