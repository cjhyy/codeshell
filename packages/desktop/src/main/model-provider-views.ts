import {
  defaultCacheDir,
  fetchModelList,
  PROVIDER_KINDS,
  reasoningControlFor,
  type ProviderKindName,
} from "@cjhyy/code-shell-core/internal";
import { resolveModelMeta } from "./model-meta-service.js";

export function modelMetadata(models: unknown, providers: unknown) {
  if (!Array.isArray(models) || !Array.isArray(providers)) return [];
  return resolveModelMeta(models as never, providers as never);
}
export function modelReasoning(rawKind: unknown, rawModel: unknown) {
  const kind: ProviderKindName =
    typeof rawKind === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_KINDS, rawKind)
      ? (rawKind as ProviderKindName)
      : "custom";
  const model = typeof rawModel === "string" ? rawModel : "";
  return reasoningControlFor(kind, model);
}
export function providerModels(
  rawProvider: unknown,
  refresh?: boolean,
  beforeCacheWrite?: () => void,
) {
  const provider =
    rawProvider && typeof rawProvider === "object" ? (rawProvider as Record<string, unknown>) : {};
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
    { cacheDir: defaultCacheDir(), refresh: refresh === true, beforeCacheWrite },
  );
}
