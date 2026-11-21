import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { getMergedCatalog, catalogEntryOrigins } from "@cjhyy/code-shell-core/internal";
import { modelMetadata, modelReasoning, providerModels } from "./model-provider-views.js";
import { invalidateMcpProbeCache } from "./mcp-probe-service.js";
import { probeSearch, type SearchProbeInput } from "./search-probe-service.js";
import { probeImage, type ImageProbeInput } from "./image-probe-service.js";

/** MCP probe cache, search/image probes, model catalog and provider model-list routes. */
export function registerModelCatalogIpc(host: {
  callBusiness: CallShellBusiness;
  documentSignal(event: IpcMainInvokeEvent): AbortSignal;
}) {
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

  ipcMain.handle("catalog:save", (event, entry: unknown) =>
    host.callBusiness("models/saveEntry", { entry }, host.documentSignal(event)),
  );
  ipcMain.handle("catalog:delete", (event, id: string) =>
    host.callBusiness("models/deleteEntry", { id }, host.documentSignal(event)),
  );
  ipcMain.handle("catalog:origins", async () => catalogEntryOrigins());

  ipcMain.handle("models:resolve-meta", (_event, models: unknown, providers: unknown) =>
    modelMetadata(models, providers),
  );
  ipcMain.handle("models:reasoning-control", (_event, kind: unknown, model: unknown) =>
    modelReasoning(kind, model),
  );
  ipcMain.handle("models:list", (_event, provider: unknown, refresh?: boolean) =>
    providerModels(provider, refresh),
  );
}
