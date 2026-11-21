import type { CodeshellApi } from "../preload/types";

type View<K extends keyof CodeshellApi, P extends Record<string, unknown>> = {
  params: P;
  result: CodeshellApi[K] extends (...args: any[]) => Promise<infer R> ? R : never;
};

type Empty = Record<string, never>;

export interface ConfigurationReadContracts {
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
