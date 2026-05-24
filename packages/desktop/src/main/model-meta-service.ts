/**
 * Resolve a model's true `maxContextTokens` without making the user
 * fill it into settings.json.
 *
 * Strategy (in priority order):
 *   1. settings.json `models[].maxContextTokens` if the user wrote one.
 *   2. OpenRouter `/v1/models` for openrouter-protocol entries — it
 *      ships `context_length` + `top_provider.max_completion_tokens`.
 *   3. A small hard-coded table for OpenAI / DeepSeek / Google / Z.AI
 *      where the official model-list endpoint doesn't include context.
 *   4. 200_000 fallback.
 *
 * Cache:
 *   We hit the network at most every 6 hours per provider. Results are
 *   merged onto the in-memory entry; persistence isn't needed because
 *   the call is cheap and a process restart already drops the cache.
 */

interface ProviderCfg {
  key?: string;
  kind?: string;
  baseUrl?: string;
  apiKey?: string;
}

interface SettingsModel {
  key: string;
  model?: string;
  providerKey?: string;
  maxContextTokens?: number | null;
  maxOutputTokens?: number | null;
}

interface ResolvedModelMeta {
  key: string;
  maxContextTokens: number;
  maxCompletionTokens?: number;
  /** Where the number came from, for the UI's tooltip. */
  source: "settings" | "openrouter-api" | "hardcoded" | "fallback";
}

interface ProviderCache {
  fetchedAt: number;
  byModel: Map<string, { context: number; completion?: number }>;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map<string, ProviderCache>();

const FALLBACK_CONTEXT = 200_000;

/**
 * Hard-coded table for providers that don't expose context_length on
 * their /models endpoint. Keep entries broad (substring match against
 * the model id) so we don't have to enumerate every revision.
 */
const HARDCODED: Array<{ match: RegExp; context: number; completion?: number }> = [
  // OpenAI
  { match: /^gpt-5/i, context: 200_000, completion: 16_384 },
  { match: /^gpt-4o/i, context: 128_000, completion: 16_384 },
  { match: /^gpt-4-turbo/i, context: 128_000, completion: 4_096 },
  { match: /^gpt-4$/i, context: 8_192 },
  { match: /^o[0-9]/i, context: 200_000 },
  // DeepSeek
  { match: /^deepseek-v[34]/i, context: 1_000_000, completion: 384_000 },
  { match: /^deepseek-/i, context: 128_000 },
  // Google
  { match: /^gemini-[23]\.5/i, context: 1_048_576 },
  { match: /^gemini-[23]\./i, context: 1_000_000 },
  // Z.AI
  { match: /^glm-5/i, context: 128_000 },
  // Anthropic direct (when used without OpenRouter)
  { match: /claude-opus-4\.7/i, context: 1_000_000 },
  { match: /claude-(opus|sonnet|haiku)-4/i, context: 200_000 },
  { match: /claude-3\.5/i, context: 200_000 },
];

async function fetchOpenRouterModels(p: ProviderCfg): Promise<void> {
  const key = `or:${p.baseUrl ?? "default"}`;
  const existing = cache.get(key);
  if (existing && Date.now() - existing.fetchedAt < CACHE_TTL_MS) return;
  try {
    const res = await fetch(`${p.baseUrl ?? "https://openrouter.ai/api/v1"}/models`, {
      headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
    });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: Array<{
      id?: string;
      context_length?: number;
      top_provider?: { max_completion_tokens?: number };
    }> };
    const data = json.data ?? [];
    const byModel = new Map<string, { context: number; completion?: number }>();
    for (const m of data) {
      if (!m.id || typeof m.context_length !== "number") continue;
      byModel.set(m.id, {
        context: m.context_length,
        completion: m.top_provider?.max_completion_tokens,
      });
    }
    cache.set(key, { fetchedAt: Date.now(), byModel });
  } catch {
    // Best-effort; an empty/missing cache just means we fall through to hardcoded.
  }
}

function hardcodedLookup(modelId: string): { context: number; completion?: number } | null {
  for (const { match, context, completion } of HARDCODED) {
    if (match.test(modelId)) return { context, completion };
  }
  return null;
}

/**
 * Resolve maxContextTokens for every model in settings.models[].
 * Returns the same list with `maxContextTokens` filled in (and a
 * `metaSource` annotation the renderer can show in the tooltip).
 */
export async function resolveModelMeta(
  models: SettingsModel[],
  providers: ProviderCfg[],
): Promise<ResolvedModelMeta[]> {
  const orProviders = providers.filter((p) => p.kind === "openrouter");
  await Promise.all(orProviders.map(fetchOpenRouterModels));

  const out: ResolvedModelMeta[] = [];

  for (const m of models) {
    // 1. settings.json wins.
    if (typeof m.maxContextTokens === "number" && m.maxContextTokens > 0) {
      out.push({
        key: m.key,
        maxContextTokens: m.maxContextTokens,
        maxCompletionTokens: m.maxOutputTokens ?? undefined,
        source: "settings",
      });
      continue;
    }

    const provider = providers.find((p) => p.key === m.providerKey);
    const modelId = m.model ?? m.key;

    // 2. OpenRouter API.
    if (provider?.kind === "openrouter") {
      const cacheKey = `or:${provider.baseUrl ?? "default"}`;
      const cached = cache.get(cacheKey);
      const hit = cached?.byModel.get(modelId);
      if (hit) {
        out.push({
          key: m.key,
          maxContextTokens: hit.context,
          maxCompletionTokens: hit.completion,
          source: "openrouter-api",
        });
        continue;
      }
    }

    // 3. Hard-coded table.
    const hc = hardcodedLookup(modelId);
    if (hc) {
      out.push({
        key: m.key,
        maxContextTokens: hc.context,
        maxCompletionTokens: hc.completion,
        source: "hardcoded",
      });
      continue;
    }

    // 4. Fallback.
    out.push({
      key: m.key,
      maxContextTokens: FALLBACK_CONTEXT,
      source: "fallback",
    });
  }

  return out;
}
