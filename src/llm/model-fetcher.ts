/**
 * Fetch a provider's model list from its official /v1/models endpoint
 * (or the local OpenRouter snapshot). Normalizes wildly different
 * response shapes into a uniform `CachedModel[]`, applies the kind's
 * chat-only filter, and writes to disk cache.
 *
 * Network failures don't throw — they return `{ models: [], error }`
 * so the UI can prompt the user to refresh later or fall back to
 * manual entry.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getKindMeta,
  type ProviderKindName,
  type ProviderProtocol,
} from "./provider-kinds.js";
import {
  readCache,
  writeCache,
  isStale,
  type CachedModel,
  type ModelCacheFile,
} from "./model-cache.js";

export interface FetcherProvider {
  key: string;
  kind: ProviderKindName;
  baseUrl: string;
  apiKey: string | undefined;
  modelsPath?: string;
}

export interface FetchOptions {
  cacheDir: string;
  refresh?: boolean;
  timeoutMs?: number;
}

export interface FetchResult extends ModelCacheFile {
  error?: string;
  fromCache?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OPENROUTER_SNAPSHOT = join(HERE, "..", "data", "openrouter-models.json");

interface RawOpenAIShape {
  data?: Array<{
    id: string;
    context_window?: number;
    max_completion_tokens?: number;
    context_length?: number;
  }>;
}
interface RawOllamaShape {
  models?: Array<{ name: string }>;
}
interface RawAnthropicShape {
  data?: Array<{ id: string; context_window?: number; max_output_tokens?: number }>;
}
interface RawGeminiShape {
  models?: Array<{ name: string; inputTokenLimit?: number; outputTokenLimit?: number }>;
}
interface OpenRouterSnapshotShape {
  models?: Array<{ id: string; contextLength?: number; maxOutputTokens?: number }>;
}

export async function fetchModelList(
  provider: FetcherProvider,
  opts: FetchOptions,
): Promise<FetchResult> {
  const meta = getKindMeta(provider.kind);

  if (!opts.refresh) {
    const cached = readCache(opts.cacheDir, provider.key);
    if (cached && !isStale(cached)) return { ...cached, fromCache: true };
  }

  if (provider.kind === "openrouter") {
    return loadOpenRouterSnapshot(provider.key, opts.cacheDir);
  }

  try {
    const path = provider.modelsPath ?? meta.modelsPath;
    const url = new URL(joinUrl(provider.baseUrl, path));
    const headers = meta.authHeader(provider.apiKey ?? "");
    if (meta.authQuery) {
      const q = meta.authQuery(provider.apiKey ?? "");
      for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) {
      return errorResult(provider.key, opts.cacheDir, `HTTP ${res.status}`);
    }
    const payload = (await res.json()) as unknown;
    const raw = normalize(payload, meta.protocol);
    const filtered = raw.filter((m) => meta.chatFilter(m.id));
    const file = writeCache(opts.cacheDir, provider.key, filtered);
    return file;
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return errorResult(provider.key, opts.cacheDir, msg);
  }
}

function normalize(payload: unknown, protocol: ProviderProtocol): CachedModel[] {
  switch (protocol) {
    case "ollama": {
      const p = payload as RawOllamaShape;
      return (p.models ?? []).map((m) => ({ id: m.name, contextLength: 0, maxOutputTokens: 0 }));
    }
    case "anthropic-style": {
      const p = payload as RawAnthropicShape;
      return (p.data ?? []).map((m) => ({
        id: m.id,
        contextLength: m.context_window ?? 200_000,
        maxOutputTokens: m.max_output_tokens ?? 0,
      }));
    }
    case "gemini": {
      const p = payload as RawGeminiShape;
      return (p.models ?? []).map((m) => ({
        id: m.name.replace(/^models\//, ""),
        contextLength: m.inputTokenLimit ?? 0,
        maxOutputTokens: m.outputTokenLimit ?? 0,
      }));
    }
    case "openai-compat": {
      const p = payload as RawOpenAIShape;
      return (p.data ?? []).map((m) => ({
        id: m.id,
        contextLength: m.context_window ?? m.context_length ?? 0,
        maxOutputTokens: m.max_completion_tokens ?? 0,
      }));
    }
  }
  // exhaustiveness: TS error if a new ProviderProtocol is added.
  const _exhaustive: never = protocol;
  return _exhaustive;
}

function loadOpenRouterSnapshot(providerKey: string, cacheDir: string): FetchResult {
  if (!existsSync(OPENROUTER_SNAPSHOT)) {
    return errorResult(providerKey, cacheDir, "openrouter snapshot missing");
  }
  try {
    const snapshot = JSON.parse(
      readFileSync(OPENROUTER_SNAPSHOT, "utf-8"),
    ) as OpenRouterSnapshotShape;
    const models: CachedModel[] = (snapshot.models ?? []).map((m) => ({
      id: m.id,
      contextLength: m.contextLength ?? 0,
      maxOutputTokens: m.maxOutputTokens ?? 0,
    }));
    return writeCache(cacheDir, providerKey, models);
  } catch (err) {
    return errorResult(providerKey, cacheDir, (err as Error).message);
  }
}

function errorResult(providerKey: string, cacheDir: string, error: string): FetchResult {
  const stale = readCache(cacheDir, providerKey);
  if (stale) return { ...stale, error, fromCache: true };
  return {
    fetchedAt: new Date().toISOString(),
    providerKey,
    models: [],
    error,
  };
}

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}
