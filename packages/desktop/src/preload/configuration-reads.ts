import type { UsageQuery } from "@cjhyy/code-shell-core";
import type { MemorySelection } from "../shared/memory-contracts.js";
import type { RendererConfigurationTarget } from "../shared/renderer-configuration.js";
import type { IpcRenderer } from "electron";
import type { DesktopBusinessReads } from "../shared/desktop-business-contracts.js";
import type { DesktopHostClient } from "./desktop-host-client.js";

export function createConfigurationReads(
  ipcRenderer: Pick<IpcRenderer, "invoke">,
  host?: Pick<DesktopHostClient, "readBusiness">,
) {
  function read<K extends keyof DesktopBusinessReads>(
    name: K,
    params: DesktopBusinessReads[K]["params"],
    fallback?: () => Promise<DesktopBusinessReads[K]["result"]>,
  ) {
    if (host) return host.readBusiness(name, params, fallback);
    if (fallback) return fallback();
    return Promise.reject(new Error("Configuration reads require the workbench Host"));
  }
  return {
    listMarketplaces: () => read("marketplace/list", {}),
    loadMarketplace: (name: string) => read("marketplace/load", { name }),
    listRecommendedMarketplaces: () => read("marketplace/recommended", {}),
    listPluginInstallJobs: () => read("marketplace/jobs", {}),
    listProfiles: (target: RendererConfigurationTarget | null) =>
      read("profiles/list", { target }, () => ipcRenderer.invoke("profiles:list", target)),
    listProfileCatalog: () =>
      read("profiles/catalog", {}, () => ipcRenderer.invoke("profiles:catalog")),
    listProfileRepos: () =>
      read("profiles/repos", {}, () => ipcRenderer.invoke("profiles:listRepos")),
    listDigitalHumanTeams: () =>
      read("profiles/teams", {}, () => ipcRenderer.invoke("digital-human-teams:list")),
    previewProfileDeletion: (name: string, target: RendererConfigurationTarget | null) =>
      read("profiles/previewDeletion", { name, target }, () =>
        ipcRenderer.invoke("profiles:previewDeletion", name, target),
      ),
    listSessionTitles: () =>
      read("activity/titles", {}, () => ipcRenderer.invoke("sessions:titles")),
    tailLog: (bucket: "ui-ink" | "engine" | "desktop", lines?: number) =>
      read("activity/logTail", { bucket, lines }, () =>
        ipcRenderer.invoke("logs:tail", bucket, lines),
      ),
    getUsageSummary: (query?: UsageQuery) =>
      read("activity/usage", { query }, () => ipcRenderer.invoke("usage:summary", query)),
    listRuns: (options?: { includeSessions?: boolean }) =>
      read("activity/runs", { includeSessions: options?.includeSessions }, () =>
        ipcRenderer.invoke("runs:list", options),
      ),
    getRun: (runId: string) =>
      read("activity/run", { runId }, () => ipcRenderer.invoke("runs:get", runId)),
    listMemory: (
      level: MemorySelection["level"],
      scope: MemorySelection["scope"],
      cwd?: string,
      profileName?: string,
    ) =>
      read("memory/list", { level, scope, cwd, profileName }, () =>
        ipcRenderer.invoke("memory:list", level, scope, cwd, profileName),
      ),
    readMemory: (
      level: MemorySelection["level"],
      scope: MemorySelection["scope"],
      name: string,
      cwd?: string,
      profileName?: string,
    ) =>
      read("memory/read", { level, scope, name, cwd, profileName }, () =>
        ipcRenderer.invoke("memory:read", level, scope, name, cwd, profileName),
      ),
    listPendingMemory: () =>
      read("memory/pending", {}, () => ipcRenderer.invoke("memory:pending:list")),
    resolveModelMeta: (models: unknown, providers: unknown) =>
      read("models/meta", { models, providers }),
    reasoningControl: (kind: string, model: string) => read("models/reasoning", { kind, model }),
    listModels: (provider: unknown, refresh?: boolean) =>
      read("models/provider", { provider, refresh }),
    listPluginHooks: (disabledPlugins?: string[]) => read("plugins/hooks", { disabledPlugins }),
    checkSkillUpdate: (target: RendererConfigurationTarget | null, filePath: string) =>
      read("skills/checkUpdate", { target, filePath }),
    listMergedMcpServers: (
      base: Record<string, unknown>,
      disabledPlugins?: string[],
      target?: RendererConfigurationTarget | null,
    ) =>
      read("mcp/merged", { base, disabledPlugins, target: target ?? null }, () =>
        ipcRenderer.invoke("mcp:listMerged", base, disabledPlugins, target),
      ),
    getConfigurationSettings: (target: RendererConfigurationTarget) =>
      read("settings/project", { target }, () =>
        ipcRenderer.invoke("settings:getConfiguration", target),
      ),
    listSkills: (
      target: RendererConfigurationTarget | null,
      opts?: { includeDisabled?: boolean },
    ) => read("skills/list", { target, includeDisabled: opts?.includeDisabled }),
    readSkillBody: (target: RendererConfigurationTarget | null, filePath: string) =>
      read("skills/body", { target, filePath }),
    listPlugins: (target: RendererConfigurationTarget | null) => read("plugins/list", { target }),
    listPluginCommands: (target: RendererConfigurationTarget) =>
      read("plugins/commands", { target }),
    expandPluginCommand: (
      target: RendererConfigurationTarget,
      name: string,
      rawArguments: string,
    ) => read("plugins/expandCommand", { target, name, rawArguments }),
    listCapabilities: (target: RendererConfigurationTarget | null) =>
      read("capabilities/list", { target }),
    listProjects: (fallback: () => Promise<DesktopBusinessReads["projects/list"]["result"]>) =>
      read("projects/list", {}, fallback),
    recents: () => read("projects/recents", {}, () => ipcRenderer.invoke("recents:list")),
    getTrust: (path: string) =>
      read("projects/trust", { path }, () => ipcRenderer.invoke("trust:get", path)),
    getTrustRisks: (path: string) =>
      read("projects/trustRisks", { path }, () => ipcRenderer.invoke("trust:risks", path)),
    getSettings: (scope: "user") =>
      read("settings/user", { scope }, () => ipcRenderer.invoke("settings:get", scope)),
    listSourceCatalog: () =>
      read("sources/catalog", {}, () => ipcRenderer.invoke("sources:catalogList")),
    projectSourceAccess: (projectId: string) =>
      read("sources/projectAccess", { projectId }, () =>
        ipcRenderer.invoke("sources:projectAccess", projectId),
      ),
    listSourceScopes: (sourceId: string) =>
      read("sources/scopes", { sourceId }, () =>
        ipcRenderer.invoke("sources:listScopes", sourceId),
      ),
    getPluginDetail: (installKey: string) => read("plugins/detail", { installKey }),
    getPluginMedia: (installKey: string, includeScreenshots?: boolean) =>
      read("plugins/media", { installKey, includeScreenshots }),
    listPluginMcpTrust: () => read("mcp/pluginTrust", {}),
    getModelCatalog: () => read("models/catalog", {}),
    getCatalogOrigins: () => read("models/catalogOrigins", {}),
  };
}
