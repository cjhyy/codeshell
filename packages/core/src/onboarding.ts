/**
 * Onboarding data layer — provider catalog, env detection, key validation,
 * settings persistence. The interactive flow itself is rendered by Ink
 * (see src/ui/components/OnboardingPrompt.tsx); this module only exposes
 * pure(-ish) helpers it consumes, so there's a single input stack.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "./settings/manager.js";
import { getOpenRouterModels } from "./data/openrouter-models.js";
import {
  KNOWN_MAX_OUTPUT,
  KNOWN_CONTEXT_WINDOWS,
  OPENROUTER_VENDORS,
  PROVIDERS,
  type ProviderDef,
} from "./data/model-metadata.js";
// Re-exported so existing importers (and tests) can keep importing from
// onboarding; the catalog data itself now lives in data/model-metadata.json.
export { PROVIDERS, type ProviderDef };
import { sanitizeApiKey } from "./llm/api-key-sanitize.js";
import { getMergedCatalog } from "./model-catalog/index.js";

export interface OnboardingResult {
  /**
   * Pool alias key (e.g. "deepseek-v4-pro"). The engine uses this to switch
   * the active model — callers should NOT re-derive an alias from `model`
   * (the old modelKey() helper folded multiple model ids to one key, which
   * silently shadowed entries in the pool).
   */
  key: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

// ProviderDef 类型 + PROVIDERS 目录已外移到 data/model-metadata.json
// (loader: data/model-metadata.ts),并在文件顶部 re-export。core 只读目录数据。

// ─── Dynamic model list (OpenRouter snapshot) ────────────────────

/**
 * Build the OpenRouter model picker list from the bundled snapshot.
 * Filters out `:free`/preview variants for the default picker (still
 * reachable via /models add). Returns the hardcoded list as fallback
 * when the snapshot is empty (e.g. fresh checkout before first build).
 */
function buildOpenRouterModelList(fallback: string[]): string[] {
  const all = getOpenRouterModels();
  if (all.length === 0) return fallback;

  const skip = /(?:-guard|-embedding|-rerank|-vision-only|:free)/i;
  const out: string[] = [];
  for (const { prefix, take } of OPENROUTER_VENDORS) {
    const candidates = all
      .filter((m) => m.id.startsWith(prefix))
      .filter((m) => !skip.test(m.id) && !m.id.includes("-preview"))
      .slice(0, take);
    out.push(...candidates.map((m) => m.id));
  }
  return out.length > 0 ? out : fallback;
}

/**
 * Resolve the model list a provider should expose right now. For
 * OpenRouter this comes from the snapshot; for direct providers it
 * stays hardcoded (snapshot doesn't carry their native IDs).
 */
export function resolveProviderModels(provider: ProviderDef): string[] {
  if (provider.id === "openrouter") {
    return buildOpenRouterModelList(provider.models);
  }
  return provider.models;
}

// ─── Env var detection ─────────────────────────────────────────────

export interface DetectedEnvKey {
  provider: ProviderDef;
  envKey: string;
  apiKey: string;
}

/**
 * Scan environment for known provider API keys.
 * Returns one entry per provider that has its envKey set.
 */
export function detectEnvKeys(): DetectedEnvKey[] {
  const found: DetectedEnvKey[] = [];
  for (const p of PROVIDERS) {
    if (!p.envKey) continue;
    const v = process.env[p.envKey];
    if (!v) continue;
    // Env-sourced keys frequently carry CRLF/BOM/quotes from how the user set
    // them (cmd `set FOO=...`, dotenv files with stray spaces, Windows clipboards
    // pasted into a shell). Sanitize once at the boundary so downstream code
    // never sees a dirty value.
    const cleaned = sanitizeApiKey(v).value;
    if (cleaned) {
      found.push({ provider: p, envKey: p.envKey, apiKey: cleaned });
    }
  }
  return found;
}

/** Mask a key for display: "sk-517f...b594" */
export function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 2) + "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/**
 * Find a provider definition that matches a given API key.
 * Checks key prefix first, then env var match, then baseUrl.
 */
export function detectProviderFromApiKey(
  apiKey: string,
  baseUrl?: string,
): ProviderDef | undefined {
  // 1. Try key prefix match
  for (const p of PROVIDERS) {
    if (p.keyPrefix && apiKey.startsWith(p.keyPrefix)) return p;
  }
  // 2. Try baseUrl match
  if (baseUrl) {
    for (const p of PROVIDERS) {
      if (p.baseUrl && baseUrl.startsWith(p.baseUrl)) return p;
    }
  }
  // 3. Try env var match
  for (const p of PROVIDERS) {
    if (!p.envKey) continue;
    const v = process.env[p.envKey];
    if (v && sanitizeApiKey(v).value === apiKey) return p;
  }
  return undefined;
}

// ─── API key validation ────────────────────────────────────────────

export async function validateApiKey(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    // 10s timeout so a hung/slow provider doesn't block the onboarding wizard
    // until the OS socket timeout — AbortError is caught below → "let it pass".
    if (baseUrl.includes("openrouter")) {
      const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json() as any;
      return !data.error;
    }
    const url = baseUrl.replace(/\/$/, "") + "/models";
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true; // network error — can't validate, let it pass
  }
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Resolve an API key from the canonical fallback chain.
 * Priority: 1) command-line option  2) settings.json  3) all provider env vars
 */
export function resolveApiKey(
  optionsApiKey?: string,
  settingsApiKey?: string,
): string | undefined {
  if (optionsApiKey) return optionsApiKey;
  if (settingsApiKey) return settingsApiKey;
  for (const p of PROVIDERS) {
    if (!p.envKey) continue;
    const v = process.env[p.envKey];
    if (!v) continue;
    // Same sanitization boundary as detectEnvKeys — env-sourced keys carry
    // CRLF/BOM/zero-width/control chars; .trim() alone misses interior ones.
    const cleaned = sanitizeApiKey(v).value;
    if (cleaned) return cleaned;
  }
  return undefined;
}

export function hasApiKey(): boolean {
  // Env variables alone are NOT enough to skip onboarding — they're surfaced
  // as a one-click option on the provider page instead. We only skip when the
  // user has explicitly persisted a config. Unified catalog: a credential with
  // an apiKey, or any configured modelConnection, counts as "set up". The
  // legacy model.apiKey / models[] / providers[] locations were removed.
  // Reads ~/.code-shell/ only — ~/.claude/ compat was dropped because Claude
  // Code's settings schema diverges and merging broke boot.
  const p = join(userHome(), ".code-shell", "settings.json");
  if (existsSync(p)) {
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      if (Array.isArray(data?.credentials) && data.credentials.some((c: any) => c?.apiKey)) return true;
      if (Array.isArray(data?.modelConnections) && data.modelConnections.length > 0) return true;
    } catch { /* ignore */ }
  }
  return false;
}


// ─── Model pool helpers ───────────────────────────────────────────
// KNOWN_MAX_OUTPUT / KNOWN_CONTEXT_WINDOWS now live in data/model-metadata.json
// (imported above) so they can be updated without a code change.

/**
 * Resolve a model's max-output-token budget. Lookup order:
 *   1. KNOWN_MAX_OUTPUT (covers direct providers like Anthropic/DeepSeek
 *      whose IDs aren't in the OpenRouter snapshot)
 *   2. OpenRouter snapshot (covers `vendor/model` style IDs)
 *   3. undefined — caller falls back to its own default
 *
 * Returns undefined (not 0) when nothing is known, so callers can use
 * `?? defaultValue` semantics.
 */
export function resolveMaxOutput(model: string): number | undefined {
  if (KNOWN_MAX_OUTPUT[model]) return KNOWN_MAX_OUTPUT[model];
  if (model.includes("/")) {
    const hit = getOpenRouterModels().find((m) => m.id === model);
    if (hit && hit.maxOutputTokens > 0) return hit.maxOutputTokens;
  }
  return undefined;
}

/**
 * Resolve a model's context window size. Lookup order:
 *   1. KNOWN_CONTEXT_WINDOWS (covers direct providers like DeepSeek)
 *   2. OpenRouter snapshot (covers `vendor/model` style IDs)
 *   3. undefined — unknown
 */
export function resolveContextWindow(model: string): number | undefined {
  if (KNOWN_CONTEXT_WINDOWS[model]) return KNOWN_CONTEXT_WINDOWS[model];
  if (model.includes("/")) {
    const hit = getOpenRouterModels().find((m) => m.id === model);
    if (hit && hit.contextLength > 0) return hit.contextLength;
  }
  return undefined;
}

/**
 * Derive a pool key in `provider-model` form. Single source of truth for
 * model alias generation — replaces the old modelKey() function which
 * folded same-family models to one key (e.g. v4-flash and v4-pro both
 * collapsed to "deepseek"), causing the pool to silently shadow entries.
 *
 *   ("deepseek", "deepseek-v4-pro")  → "deepseek-v4-pro"
 *   ("openai",   "openai/gpt-5")      → "openai-gpt-5"
 *   ("anthropic","claude-opus-4-7")   → "anthropic-claude-opus-4-7"
 *
 * If the model id already starts with `<provider>-` (e.g. "deepseek-v4-pro"
 * under provider "deepseek"), the prefix isn't duplicated.
 *
 * `used` is a set of already-taken keys; collisions are resolved with a
 * `-2`, `-3`, ... suffix.
 */
export function deriveModelPoolKey(
  providerKind: string,
  modelId: string,
  used: string[] = [],
): string {
  const slash = modelId.lastIndexOf("/");
  const base = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  const prefix = providerKind.toLowerCase();
  const candidate = base.toLowerCase().startsWith(`${prefix}-`) ? base : `${prefix}-${base}`;
  const set = new Set(used);
  if (!set.has(candidate)) return candidate;
  for (let i = 2; ; i++) {
    const k = `${candidate}-${i}`;
    if (!set.has(k)) return k;
  }
}

/**
 * Build model pool entries from a provider's model list.
 */
export function buildModelPool(
  provider: ProviderDef,
  apiKey: string,
): Array<{ key: string; label: string; provider: string; model: string; baseUrl: string; apiKey: string; maxOutputTokens?: number; maxContextTokens?: number }> {
  const models = resolveProviderModels(provider);
  const used: string[] = [];
  return models.map((m) => {
    const key = deriveModelPoolKey(provider.id, m, used);
    used.push(key);
    return {
      key,
      label: modelDisplayName(m),
      provider: provider.provider,
      model: m,
      baseUrl: provider.baseUrl,
      apiKey,
      maxOutputTokens: resolveMaxOutput(m),
      maxContextTokens: resolveContextWindow(m),
    };
  });
}

// ─── Helpers ───────────────────────────────────────────────────────

export function modelDisplayName(model: string): string {
  const slash = model.lastIndexOf("/");
  const base = slash >= 0 ? model.slice(slash + 1) : model;
  const parts = base.split("-");
  if (parts[0] === "claude") {
    const variant = parts[1] ?? "";
    return `Claude ${variant.charAt(0).toUpperCase() + variant.slice(1)}`;
  }
  if (base.startsWith("gpt-")) return `GPT-${parts.slice(1).join("-")}`;
  if (base.startsWith("gemini-")) return `Gemini ${parts.slice(1).join("-")}`;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Map a provider kind → catalogId. If a builtin (or user) TEXT catalog entry
 * with id===kind exists, use it; otherwise fall back to the generic "custom"
 * OpenAI-compatible entry. resolveInstance() returns null for an unknown
 * catalogId, so every connection's catalogId MUST exist in the merged catalog.
 */
function catalogIdForKind(kind: string): string {
  return getMergedCatalog().some((e) => e.id === kind && e.tag === "text") ? kind : "custom";
}

/**
 * 持久化 onboarding 结果到统一 catalog(credentials + modelConnections +
 * defaults.text)。Append-only:相同 instanceId 跳过。defaults.text 设为 activeId。
 * 原子写(tmp+rename)。(旧版写 legacy model.* / models / providers / activeKey,已删)
 */
export function appendOnboardingResult(opts: {
  /** 本次新增的模型实例(每个成为一个 modelConnection + credential)。 */
  models: Array<{
    instanceId: string;
    kind: string;          // provider kind → 映射 catalogId
    model: string;
    apiKey?: string;
    baseUrl?: string;
  }>;
  /** 选中的活跃实例 id(写入 defaults.text)。 */
  activeId: string;
  tag?: "text" | "image" | "video"; // 默认 "text"
}): void {
  const tag = opts.tag ?? "text";
  const dir = join(userHome(), ".code-shell");
  const file = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, "utf-8")); } catch { /* corrupt → replace */ }
  }

  const creds = Array.isArray((existing as any).credentials)
    ? [...((existing as any).credentials as Array<Record<string, unknown>>)] : [];
  const conns = Array.isArray((existing as any).modelConnections)
    ? [...((existing as any).modelConnections as Array<Record<string, unknown>>)] : [];

  for (const m of opts.models) {
    const catalogId = catalogIdForKind(m.kind);
    const credId = `${m.instanceId}-key`;
    if (!creds.some((c) => c?.id === credId)) {
      creds.push({ id: credId, catalogId, apiKey: m.apiKey, baseUrl: m.baseUrl });
    }
    if (!conns.some((c) => c?.id === m.instanceId)) {
      conns.push({
        id: m.instanceId, catalogId, tag, model: m.model, credentialId: credId,
        ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
      });
    }
  }

  const existingDefaults = (typeof (existing as any).defaults === "object" && (existing as any).defaults)
    ? (existing as any).defaults as Record<string, unknown> : {};

  const updated: Record<string, unknown> = {
    ...existing,
    credentials: creds,
    modelConnections: conns,
    defaults: { ...existingDefaults, [tag]: opts.activeId },
  };

  // Atomic write: tmp file in the same dir, then rename (atomic on POSIX).
  // mode 0o600 — settings.json holds plaintext API keys, must be owner-only.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(updated, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch {
    // Fallback: best-effort direct write if rename fails (e.g. cross-device),
    // then remove the orphaned temp file the failed rename left behind.
    writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    rmSync(tmp, { force: true });
  }
}

// saveArenaSettings removed — replaced by saveArenaSettingsByKeys

export function saveArenaSettingsByKeys(keys: string[]): void {
  const dir = join(userHome(), ".code-shell");
  const file = join(dir, "settings.json");

  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, "utf-8")); } catch {}
  }

  const updated = {
    ...existing,
    arena: { participants: keys },
  };

  writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort */ }
}

