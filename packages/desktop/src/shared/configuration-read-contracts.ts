import type { RendererConfigurationTarget } from "./renderer-configuration.js";
import type { CodeshellApi } from "../preload/types";

type View<K extends keyof CodeshellApi, P extends Record<string, unknown>> = {
  params: P;
  result: CodeshellApi[K] extends (...args: any[]) => Promise<infer R> ? R : never;
};

type Empty = Record<string, never>;

type Target = { target: RendererConfigurationTarget };
type OptionalTarget = { target: RendererConfigurationTarget | null };

export interface ConfigurationReadContracts {
  "models/meta": View<"resolveModelMeta", { models: unknown; providers: unknown }>;
  "models/reasoning": View<"reasoningControl", { kind: string; model: string }>;
  "models/provider": View<"listModels", { provider: unknown; refresh?: boolean }>;
  "plugins/hooks": View<"listPluginHooks", { disabledPlugins?: string[] }>;
  "skills/checkUpdate": View<"checkSkillUpdate", OptionalTarget & { filePath: string }>;

  "mcp/merged": View<
    "listMergedMcpServers",
    OptionalTarget & { base: Record<string, unknown>; disabledPlugins?: string[] }
  >;
  "settings/project": View<"getConfigurationSettings", Target>;
  "skills/list": View<"listSkills", OptionalTarget & { includeDisabled?: boolean }>;
  "skills/body": View<"readSkillBody", OptionalTarget & { filePath: string }>;
  "plugins/list": View<"listPlugins", OptionalTarget>;
  "plugins/commands": View<"listPluginCommands", Target>;
  "capabilities/list": View<"listCapabilities", OptionalTarget>;

  "projects/list": {
    params: Empty;
    result: Awaited<ReturnType<CodeshellApi["projectRegistry"]["list"]>>;
  };
  "projects/recents": View<"recents", Empty>;
  "projects/trust": View<"getTrust", { path: string }>;
  "projects/trustRisks": View<"getTrustRisks", { path: string }>;
  "settings/user": View<"getSettings", { scope: "user" }>;
  "sources/catalog": View<"listSourceCatalog", Empty>;
  "sources/projectAccess": View<"projectSourceAccess", { projectId: string }>;
  "sources/scopes": View<"listSourceScopes", { sourceId: string }>;
  "plugins/detail": View<"getPluginDetail", { installKey: string }>;
  "plugins/media": View<"getPluginMedia", { installKey: string; includeScreenshots?: boolean }>;
  "mcp/pluginTrust": View<"listPluginMcpTrust", Empty>;
}
