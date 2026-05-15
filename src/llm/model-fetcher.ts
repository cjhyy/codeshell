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
import {
  listStaticModels,
  hasStaticCatalog,
} from "../data/static-catalogs.js";

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
      // 401/403 means the key is wrong (or revoked) — falling back to the
      // static catalog would show the user a model list they can't actually
      // call, deferring the real error to the first chat turn. Surface the
      // auth failure now with an empty list.
      const isAuth = res.status === 401 || res.status === 403;
      return errorResult(
        provider.key,
        opts.cacheDir,
        `HTTP ${res.status}`,
        isAuth ? undefined : provider.kind,
      );
    }
    const payload = (await res.json()) as unknown;
    const raw = normalize(payload, meta.protocol);
    const filtered = raw.filter((m) => meta.chatFilter(m.id));
    const sorted = sortByRecency(filtered);
    const enriched = enrichFromStaticCatalog(provider.kind, sorted);
    const file = writeCache(opts.cacheDir, provider.key, enriched);
    return file;
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return errorResult(provider.key, opts.cacheDir, msg, provider.kind);
  }
}

/**
 * Left-join static-catalog metadata onto live /models results. The live
 * endpoint is the source of truth for which ids exist; the static table
 * fills in contextLength / maxOutputTokens / pricing that most vendors
 * don't expose on /v1/models. Live values are preserved when present.
 *
 * Models present only in the static table (not returned by the live API
 * — e.g. newly-deprecated ids or vendor-hidden previews) are appended at
 * the end so the picker can still show them.
 */
function enrichFromStaticCatalog(kind: ProviderKindName, live: CachedModel[]): CachedModel[] {
  if (!hasStaticCatalog(kind)) return live;
  const staticModels = listStaticModels(kind);
  const staticById = new Map(staticModels.map((m) => [m.id, m]));
  const liveIds = new Set(live.map((m) => m.id));
  const merged: CachedModel[] = live.map((m) => {
    const stat = staticById.get(m.id);
    if (!stat) return m;
    return {
      id: m.id,
      contextLength: m.contextLength > 0 ? m.contextLength : stat.contextLength,
      maxOutputTokens: m.maxOutputTokens > 0 ? m.maxOutputTokens : stat.maxOutputTokens,
    };
  });
  for (const stat of staticModels) {
    if (!liveIds.has(stat.id)) {
      merged.push({
        id: stat.id,
        contextLength: stat.contextLength,
        maxOutputTokens: stat.maxOutputTokens,
      });
    }
  }
  return merged;
}

/**
 * Newest-first ordering. Vendors reliably encode recency as a version
 * suffix on the model family name: `gpt-5.5` > `gpt-5.4` > `gpt-5`,
 * `claude-4.7` > `claude-4.6`, `gemini-2.5` > `gemini-2.0`. We extract
 * that single "family version" number and sort descending.
 *
 * Versions can appear three ways:
 *   - decimal:        `gpt-5.5`, `claude-4.7`           → 5.5 / 4.7
 *   - dash-decimal:   `claude-sonnet-4-6`,              → 4.6
 *                     `claude-3-5-haiku`                → 3.5
 *   - bare integer:   `gpt-4`, `o3`, `o4-mini`          → 4 / 3 / 4
 *
 * Dash-decimal is Anthropic's house style: `claude-<family>-<major>-<minor>`.
 * We only treat `<small int>-<small int>` as a version when both halves
 * look like version components (1–2 digits each), so we don't accidentally
 * turn snapshot-ish `gpt-4-0613` into 4.613.
 *
 * What we deliberately ignore:
 *   - 4-digit date-ish numbers like `0613`, `1106`, `0914` baked into
 *     legacy ids. These are snapshots, not versions.
 *
 * Tie-breaker: shorter id wins (so `gpt-5.5` sorts above `gpt-5.5-pro`),
 * then alphabetic for stable output.
 */
function sortByRecency(models: CachedModel[]): CachedModel[] {
  const versionOf = (id: string): number => {
    // Match a version *as a token boundary* — preceded by start or
    // a non-digit, and not followed by another digit. Decimals win
    // over bare integers if both match.
    const decimal = id.match(/(?:^|[^\d])(\d+\.\d+)(?!\d)/);
    if (decimal) return Number(decimal[1]);
    // Dash-decimal (Anthropic style): both halves 1–2 digits to avoid
    // catching dated snapshots like `gpt-4-0613` (4-digit second half).
    const dashDecimal = id.match(/(?:^|[^\d])(\d{1,2})-(\d{1,2})(?!\d)/);
    if (dashDecimal) return Number(`${dashDecimal[1]}.${dashDecimal[2]}`);
    // Bare-integer version: 1–2 digits only (skips `0613`-style dates).
    const integer = id.match(/(?:^|[^\d])(\d{1,2})(?!\d)/);
    if (integer) return Number(integer[1]);
    return -1;
  };
  return [...models].sort((a, b) => {
    const va = versionOf(a.id);
    const vb = versionOf(b.id);
    if (va !== vb) return vb - va;
    if (a.id.length !== b.id.length) return a.id.length - b.id.length;
    return a.id.localeCompare(b.id);
  });
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

function errorResult(
  providerKey: string,
  cacheDir: string,
  error: string,
  kind?: ProviderKindName,
): FetchResult {
  const stale = readCache(cacheDir, providerKey);
  if (stale) return { ...stale, error, fromCache: true };
  if (kind && hasStaticCatalog(kind)) {
    const models = listStaticModels(kind).map((m) => ({
      id: m.id,
      contextLength: m.contextLength,
      maxOutputTokens: m.maxOutputTokens,
    }));
    return {
      fetchedAt: new Date().toISOString(),
      providerKey,
      models,
      error,
    };
  }
  return {
    fetchedAt: new Date().toISOString(),
    providerKey,
    models: [],
    error,
  };
}

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  // Allow a per-provider override to specify an absolute URL — needed for
  // providers like Gemini whose chat completions live under /v1beta/openai
  // but model listing stays on /v1beta/models.
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}
