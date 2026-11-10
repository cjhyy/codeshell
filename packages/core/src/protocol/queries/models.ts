import type { BuiltinQueryContext } from "./context.js";
import {
  createResponse,
  createErrorResponse,
  ErrorCodes,
  type RpcRequest,
  type QueryParams,
} from "../types.js";
import { redactSecrets } from "../../logging/sanitize-messages.js";

export async function queryModels(
  context: Pick<BuiltinQueryContext, "engine" | "send">,
  req: RpcRequest,
  _params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!engine) {
    context.send(
      createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for models query"),
    );
    return;
  }
  const pool = engine.getModelPool();
  const models: import("../types.js").ProtocolModelEntry[] = pool.list().map((m) => ({
    key: m.key,
    label: m.label ?? m.key,
    model: m.model,
    protocol: m.provider,
    providerKey: m.providerKey,
    active: m.key === pool.getActiveKey(),
    maxOutputTokens: m.maxOutputTokens,
    maxContextTokens: m.maxContextTokens,
  }));
  context.send(createResponse(req.id, { type: "models", data: models }));
  return;
}

export async function queryProviders(
  context: Pick<BuiltinQueryContext, "engine" | "send">,
  req: RpcRequest,
  _params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!engine) {
    context.send(
      createErrorResponse(
        req.id,
        ErrorCodes.InternalError,
        "No engine available for providers query",
      ),
    );
    return;
  }
  try {
    const providersRaw = engine.readSetting("providers") as unknown;
    const modelsRaw = engine.readSetting("models") as unknown;
    const providerList = Array.isArray(providersRaw)
      ? (providersRaw as Array<Record<string, unknown>>)
      : [];
    const modelsList = Array.isArray(modelsRaw)
      ? (modelsRaw as Array<Record<string, unknown>>)
      : [];
    const counts = new Map<string, number>();
    for (const m of modelsList) {
      const pk = typeof m.providerKey === "string" ? m.providerKey : "";
      if (!pk) continue;
      counts.set(pk, (counts.get(pk) ?? 0) + 1);
    }
    const { readCache } = await import("../../llm/model-cache.js");
    const { defaultCacheDir } = await import("../../llm/model-cache.js");
    const cacheDir = defaultCacheDir();
    const enriched = providerList.map((p) => {
      const key = typeof p.key === "string" ? p.key : "";
      const cache = key ? readCache(cacheDir, key) : undefined;
      return {
        ...p,
        modelCount: counts.get(key) ?? 0,
        cachedModels: cache ? cache.models.length : undefined,
        cachedAt: cache ? cache.fetchedAt : undefined,
      };
    });
    // Strip apiKey / other secret-shaped fields from each provider
    // before sending. `...p` above spreads the whole provider record,
    // which includes apiKey verbatim — without this redact pass, any
    // protocol client could call query("providers") and harvest
    // credentials. The shared redactor preserves
    // presence-without-value (hasApiKey-style consumers still see the
    // field shape, just with [redacted] in place of the secret).
    const safe = redactSecrets(enriched);
    context.send(createResponse(req.id, { type: "providers", data: safe }));
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}

export async function queryProviderAdd(
  context: Pick<BuiltinQueryContext, "engine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!engine) {
    context.send(
      createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for provider_add"),
    );
    return;
  }
  try {
    const cfg = params.provider as Record<string, unknown> | undefined;
    if (
      !cfg ||
      typeof cfg.key !== "string" ||
      typeof cfg.kind !== "string" ||
      typeof cfg.baseUrl !== "string"
    ) {
      throw new Error("provider_add: requires {key, kind, baseUrl, ...}");
    }
    const current = (engine.readSetting("providers") as unknown[] | undefined) ?? [];
    const next = [...current, cfg];
    engine.updateConfig("providers", next);
    context.send(
      createResponse(req.id, { type: "provider_add", data: { ok: true, key: cfg.key } }),
    );
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}

export async function queryProviderRefresh(
  context: Pick<BuiltinQueryContext, "engine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!engine) {
    context.send(
      createErrorResponse(
        req.id,
        ErrorCodes.InternalError,
        "No engine available for provider_refresh",
      ),
    );
    return;
  }
  try {
    const key = params.key;
    if (!key) throw new Error("provider_refresh: key required");
    const providers =
      (engine.readSetting("providers") as Array<Record<string, unknown>> | undefined) ?? [];
    const p = providers.find((x) => x.key === key);
    if (!p) throw new Error(`provider not found: ${key}`);
    const { fetchModelList } = await import("../../llm/model-fetcher.js");
    const { defaultCacheDir } = await import("../../llm/model-cache.js");
    const res = await fetchModelList(
      {
        key: p.key as string,
        kind: p.kind as never,
        baseUrl: p.baseUrl as string,
        apiKey: p.apiKey as string | undefined,
      },
      { cacheDir: defaultCacheDir(), refresh: true },
    );
    context.send(
      createResponse(req.id, {
        type: "provider_refresh",
        data: { count: res.models.length, error: res.error },
      }),
    );
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}

export async function queryProviderDelete(
  context: Pick<BuiltinQueryContext, "engine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!engine) {
    context.send(
      createErrorResponse(
        req.id,
        ErrorCodes.InternalError,
        "No engine available for provider_delete",
      ),
    );
    return;
  }
  try {
    const key = params.key;
    if (!key) throw new Error("provider_delete: key required");
    const models =
      (engine.readSetting("models") as Array<Record<string, unknown>> | undefined) ?? [];
    const refs = models.filter((m) => m.providerKey === key).map((m) => m.key as string);
    if (refs.length > 0) {
      throw new Error(`provider ${key} referenced by models: ${refs.join(", ")}`);
    }
    const providers =
      (engine.readSetting("providers") as Array<Record<string, unknown>> | undefined) ?? [];
    const next = providers.filter((p) => p.key !== key);
    engine.updateConfig("providers", next);
    context.send(createResponse(req.id, { type: "provider_delete", data: { ok: true } }));
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}

export async function queryModelAdd(
  context: Pick<BuiltinQueryContext, "engine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!engine) {
    context.send(
      createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for model_add"),
    );
    return;
  }
  try {
    const entry = params.model as Record<string, unknown> | undefined;
    if (!entry || typeof entry.key !== "string" || typeof entry.model !== "string") {
      throw new Error("model_add: requires {key, model, providerKey}");
    }
    const current = (engine.readSetting("models") as unknown[] | undefined) ?? [];
    const next = [...current, entry];
    engine.updateConfig("models", next);
    context.send(createResponse(req.id, { type: "model_add", data: { ok: true, key: entry.key } }));
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}

export async function queryModelDelete(
  context: Pick<BuiltinQueryContext, "engine" | "send">,
  req: RpcRequest,
  params: QueryParams,
): Promise<void> {
  const { engine } = context;
  if (!engine) {
    context.send(
      createErrorResponse(req.id, ErrorCodes.InternalError, "No engine available for model_delete"),
    );
    return;
  }
  try {
    const key = params.key;
    if (!key) throw new Error("model_delete: key required");
    const current =
      (engine.readSetting("models") as Array<Record<string, unknown>> | undefined) ?? [];
    const next = current.filter((m) => m.key !== key);
    engine.updateConfig("models", next);
    context.send(createResponse(req.id, { type: "model_delete", data: { ok: true } }));
  } catch (err) {
    context.send(createErrorResponse(req.id, ErrorCodes.InternalError, (err as Error).message));
  }
  return;
}
