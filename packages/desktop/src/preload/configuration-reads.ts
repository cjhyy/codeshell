import type { UsageQuery } from "@cjhyy/code-shell-core";
import type { MemorySelection } from "../shared/memory-contracts.js";
import type { RendererConfigurationTarget } from "../shared/renderer-configuration.js";
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
      read("models/meta", { models, providers }, () =>
        ipcRenderer.invoke("models:resolve-meta", models, providers),
      ),
    reasoningControl: (kind: string, model: string) =>
      read("models/reasoning", { kind, model }, () =>
        ipcRenderer.invoke("models:reasoning-control", kind, model),
      ),
    listModels: (provider: unknown, refresh?: boolean) =>
      read("models/provider", { provider, refresh }, () =>
        ipcRenderer.invoke("models:list", provider, refresh),
      ),
    listPluginHooks: (disabledPlugins?: string[]) =>
      read("plugins/hooks", { disabledPlugins }, () =>
        ipcRenderer.invoke("hooks:listPlugin", disabledPlugins),
      ),
    checkSkillUpdate: (target: RendererConfigurationTarget | null, filePath: string) =>
      read("skills/checkUpdate", { target, filePath }, () =>
        ipcRenderer.invoke("skills:checkUpdate", target, filePath),
      ),
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
    ) =>
      read("skills/list", { target, includeDisabled: opts?.includeDisabled }, () =>
        ipcRenderer.invoke("skills:list", target, opts),
      ),
    readSkillBody: (target: RendererConfigurationTarget | null, filePath: string) =>
      read("skills/body", { target, filePath }, () =>
        ipcRenderer.invoke("skills:read", target, filePath),
      ),
    listPlugins: (target: RendererConfigurationTarget | null) =>
      read("plugins/list", { target }, () => ipcRenderer.invoke("plugins:list", target)),
    listPluginCommands: (target: RendererConfigurationTarget) =>
      read("plugins/commands", { target }, () =>
        ipcRenderer.invoke("plugin-commands:list", target),
      ),
    listCapabilities: (target: RendererConfigurationTarget | null) =>
      read("capabilities/list", { target }, () => ipcRenderer.invoke("capabilities:list", target)),
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
    getPluginDetail: (installKey: string) =>
      read("plugins/detail", { installKey }, () =>
        ipcRenderer.invoke("plugins:detail", installKey),
      ),
    getPluginMedia: (installKey: string, includeScreenshots?: boolean) =>
      read("plugins/media", { installKey, includeScreenshots }, () =>
        ipcRenderer.invoke("plugins:media", installKey, includeScreenshots),
      ),
    listPluginMcpTrust: () =>
      read("mcp/pluginTrust", {}, () => ipcRenderer.invoke("mcp:listPluginTrust")),
    getModelCatalog: () => read("models/catalog", {}, () => ipcRenderer.invoke("catalog:list")),
    getCatalogOrigins: () =>
      read("models/catalogOrigins", {}, () => ipcRenderer.invoke("catalog:origins")),
  };
}
