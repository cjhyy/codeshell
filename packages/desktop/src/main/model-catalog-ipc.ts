import { ipcMain } from "electron";
import {
  defaultCacheDir,
  fetchModelList,
  PROVIDER_KINDS,
  reasoningControlFor,
  type ProviderKindName,
  getMergedCatalog,
  saveCatalogEntry,
  deleteUserCatalogEntry,
  userCatalogPath,
  catalogEntryOrigins,
} from "@cjhyy/code-shell-core/internal";
import { resolveModelMeta } from "./model-meta-service.js";
import { invalidateMcpProbeCache } from "./mcp-probe-service.js";
import { probeSearch, type SearchProbeInput } from "./search-probe-service.js";
import { probeImage, type ImageProbeInput } from "./image-probe-service.js";

/** MCP probe cache, search/image probes, model catalog and provider model-list routes. */
export function registerModelCatalogIpc() {
  ipcMain.handle("mcp:invalidate", async (_e, name?: string) => {
    invalidateMcpProbeCache(typeof name === "string" ? name : undefined);
  });

  ipcMain.handle("search:probe", async (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") {
      throw new Error("search:probe requires { provider, apiKey?, baseUrl? }");
    }
    const r = raw as SearchProbeInput;
    if (r.provider !== "serper" && r.provider !== "tavily" && r.provider !== "searxng") {
      throw new Error(`invalid provider: ${r.provider}`);
    }
    return probeSearch(r);
  });

  ipcMain.handle("image:probe", async (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") {
      throw new Error("image:probe requires { kind, apiKey?, baseUrl?, model? }");
    }
    const r = raw as ImageProbeInput;
    if (typeof r.kind !== "string" || !r.kind) {
      throw new Error("image:probe requires a provider kind");
    }
    return probeImage(r);
  });

  ipcMain.handle("catalog:list", async () => getMergedCatalog());

  ipcMain.handle("catalog:save", async (_e, entry: unknown) =>
    saveCatalogEntry(entry, { path: userCatalogPath(), stamp: String(Date.now()) }),
  );
  ipcMain.handle("catalog:delete", async (_e, id: string) =>
    deleteUserCatalogEntry(id, { path: userCatalogPath(), stamp: String(Date.now()) }),
  );
  ipcMain.handle("catalog:origins", async () => catalogEntryOrigins());

  ipcMain.handle("models:resolve-meta", async (_e, models: unknown, providers: unknown) => {
    if (!Array.isArray(models) || !Array.isArray(providers)) return [];
    return resolveModelMeta(models as never, providers as never);
  });

  ipcMain.handle("models:reasoning-control", async (_e, rawKind: unknown, rawModel: unknown) => {
    const kind: ProviderKindName =
      typeof rawKind === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_KINDS, rawKind)
        ? (rawKind as ProviderKindName)
        : "custom";
    const model = typeof rawModel === "string" ? rawModel : "";
    return reasoningControlFor(kind, model);
  });

  ipcMain.handle("models:list", async (_e, rawProvider: unknown, refresh?: boolean) => {
    const provider =
      rawProvider && typeof rawProvider === "object"
        ? (rawProvider as Record<string, unknown>)
        : {};
    const rawKind = typeof provider.kind === "string" ? provider.kind : "custom";
    const kind = Object.prototype.hasOwnProperty.call(PROVIDER_KINDS, rawKind)
      ? (rawKind as ProviderKindName)
      : "custom";
    const meta = PROVIDER_KINDS[kind];
    const rawBaseUrl =
      typeof provider.baseUrl === "string" && provider.baseUrl.trim()
        ? provider.baseUrl.trim()
        : meta.defaultBaseUrl;
    const baseUrl = kind === "ollama" ? rawBaseUrl.replace(/\/v1\/?$/, "") : rawBaseUrl;
    return fetchModelList(
      {
        key: typeof provider.key === "string" && provider.key ? provider.key : kind,
        kind,
        baseUrl,
        apiKey: typeof provider.apiKey === "string" ? provider.apiKey : undefined,
        modelsPath: typeof provider.modelsPath === "string" ? provider.modelsPath : undefined,
      },
      { cacheDir: defaultCacheDir(), refresh: refresh === true },
    );
  });
}
