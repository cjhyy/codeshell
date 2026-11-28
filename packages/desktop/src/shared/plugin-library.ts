import type {
  previewLocalPluginForUi,
  installLocalPluginForUi,
} from "../main/marketplace-service.js";
import type { checkPluginUpdateEntry } from "../main/plugins-service.js";
type Operation<F extends (...args: any[]) => unknown> = {
  input: Parameters<F>[0];
  result: Awaited<ReturnType<F>>;
};
export interface PluginPackageOperations {
  "plugins/previewLocal": Operation<typeof previewLocalPluginForUi>;
  "plugins/installLocal": Operation<typeof installLocalPluginForUi>;
  "plugins/uninstallLocal": { input: { name: string }; result: void };
  "plugins/checkUpdate": {
    input: { name: string };
    result: Awaited<ReturnType<typeof checkPluginUpdateEntry>>;
  };
}

type Market = typeof import("../main/marketplace-service.js");
type Plugins = typeof import("../main/plugins-service.js");
type Result<F extends (...args: any[]) => unknown> = Awaited<ReturnType<F>>;
type Empty = Record<string, never>;
export interface MarketplaceReads {
  "marketplace/recommended": {
    params: Empty;
    result: Result<Market["listRecommendedMarketplacesForUi"]>;
  };
  "marketplace/list": { params: Empty; result: Result<Market["listMarketplacesForUi"]> };
  "marketplace/load": { params: { name: string }; result: Result<Market["loadMarketplaceForUi"]> };
  "marketplace/jobs": { params: Empty; result: Result<Market["listPluginInstallJobsForUi"]> };
}
type Approval<
  K extends
    | "approvePlugin"
    | "revokePlugin"
    | "approvePluginHooks"
    | "revokePluginHooks"
    | "approvePluginMcp"
    | "revokePluginMcp",
> = {
  input: { installKey: string };
  result: Result<(typeof import("@cjhyy/code-shell-core"))[K]>;
};
export interface MarketplaceChanges {
  "plugins/approve": Approval<"approvePlugin">;
  "plugins/revoke": Approval<"revokePlugin">;
  "plugins/approveHooks": Approval<"approvePluginHooks">;
  "plugins/revokeHooks": Approval<"revokePluginHooks">;
  "plugins/approveMcp": Approval<"approvePluginMcp">;
  "plugins/revokeMcp": Approval<"revokePluginMcp">;
  "plugins/hooks": {
    input: { disabledPlugins?: string[] };
    result: Result<(typeof import("@cjhyy/code-shell-core"))["listPluginHooks"]>;
  };
  "mcp/pluginTrust": {
    input: Empty;
    result: Result<(typeof import("@cjhyy/code-shell-core"))["listPluginMcpTrust"]>;
  };
  "marketplace/bootstrap": { input: { resourcesDir: string }; result: void };
  "marketplace/add": {
    input: { source: string };
    result: Result<Market["addMarketplaceFromInput"]>;
  };
  "marketplace/addRecommended": {
    input: { id: string };
    result: Result<Market["addRecommendedMarketplaceForUi"]>;
  };
  "marketplace/remove": { input: { name: string }; result: boolean };
  "marketplace/refresh": {
    input: { name: string };
    result: Result<Market["refreshMarketplaceForUi"]>;
  };
  "marketplace/install": {
    input: { pluginName: string; marketplaceName: string };
    result: Result<Market["installPluginForUi"]>;
  };
  "marketplace/retry": {
    input: { id: string };
    result: Result<Market["retryPluginInstallJobForUi"]>;
  };
  "marketplace/uninstall": {
    input: { pluginName: string; marketplaceName: string };
    result: Result<Plugins["uninstallPluginEntry"]>;
  };
  "marketplace/updatePlugin": {
    input: { installKey: string };
    result: Result<Plugins["updatePluginEntry"]>;
  };
}
export type MarketplaceOperations = MarketplaceChanges & {
  [K in keyof MarketplaceReads]: {
    input: MarketplaceReads[K]["params"];
    result: MarketplaceReads[K]["result"];
  };
};
