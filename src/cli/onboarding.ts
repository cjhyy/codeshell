/**
 * Onboarding data layer — provider catalog, env detection, key validation,
 * settings persistence. The interactive flow itself is rendered by Ink
 * (see src/ui/components/OnboardingPrompt.tsx); this module only exposes
 * pure(-ish) helpers it consumes, so there's a single input stack.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getOpenRouterModels } from "../data/openrouter-models.js";

export interface OnboardingResult {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export interface ProviderDef {
  id: string;
  name: string;
  envKey: string;
  provider: string;
  baseUrl: string;
  defaultModel: string;
  keyUrl: string;
  keyPrefix: string;
  models: string[];
  /** When true, skip API key prompt (e.g. local providers like Ollama). */
  noKey?: boolean;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openrouter",
    name: "OpenRouter (推荐 — 支持所有模型)",
    envKey: "OPENROUTER_API_KEY",
    provider: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.6",
    keyUrl: "https://openrouter.ai/keys",
    keyPrefix: "sk-or-",
    models: [
      "anthropic/claude-opus-4.7",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5",
      "openai/gpt-5-mini",
      "openai/gpt-4o",
      "openai/o4-mini",
      "openai/o3",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "qwen/qwen3-coder",
      "meta-llama/llama-4-maverick",
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic (直连 Claude API)",
    envKey: "ANTHROPIC_API_KEY",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-6",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
    models: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
    models: ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4o", "o4-mini", "o3"],
  },
  {
    id: "deepseek",
    name: "DeepSeek (官方直连)",
    envKey: "DEEPSEEK_API_KEY",
    provider: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-pro",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPrefix: "sk-",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
  },
  {
    id: "gemini",
    name: "Google Gemini (官方直连)",
    envKey: "GEMINI_API_KEY",
    provider: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-pro",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPrefix: "",
    models: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
    ],
  },
  {
    id: "ollama",
    name: "Ollama (本地，无需 Key)",
    envKey: "",
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    keyUrl: "https://ollama.com/library",
    keyPrefix: "",
    models: ["llama3.1", "qwen2.5-coder", "deepseek-r1", "mistral", "gemma3"],
    noKey: true,
  },
  {
    id: "custom",
    name: "自定义 (任何 OpenAI 兼容 API)",
    envKey: "",
    provider: "openai",
    baseUrl: "",
    defaultModel: "",
    keyUrl: "",
    keyPrefix: "",
    models: [],
  },
];

// ─── Dynamic model list (OpenRouter snapshot) ────────────────────

/**
 * Curated vendors and how many of their newest models to surface in the
 * onboarding picker. Order matters — first vendors appear first.
 * Tweak this if a new vendor becomes worth exposing in the picker.
 */
const OPENROUTER_VENDORS: Array<{ prefix: string; take: number }> = [
  { prefix: "anthropic/", take: 4 },
  { prefix: "openai/", take: 5 },
  { prefix: "google/", take: 3 },
  { prefix: "deepseek/", take: 3 },
  { prefix: "x-ai/", take: 2 },
  { prefix: "qwen/", take: 2 },
  { prefix: "meta-llama/", take: 2 },
  { prefix: "mistralai/", take: 1 },
];

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
    if (v && v.trim()) {
      found.push({ provider: p, envKey: p.envKey, apiKey: v.trim() });
    }
  }
  return found;
}

/** Mask a key for display: "sk-517f...b594" */
export function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 2) + "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

// ─── API key validation ────────────────────────────────────────────

export async function validateApiKey(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    if (baseUrl.includes("openrouter")) {
      const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json() as any;
      return !data.error;
    }
    const url = baseUrl.replace(/\/$/, "") + "/models";
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
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
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export function hasApiKey(): boolean {
  // Env variables alone are NOT enough to skip onboarding — they're surfaced
  // as a one-click option on the provider page instead. We only skip when the
  // user has explicitly persisted a config (settings.json with model.apiKey).
  const settingsPaths = [
    join(homedir(), ".code-shell", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ];

  for (const p of settingsPaths) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, "utf-8"));
        if (data?.model?.apiKey) return true;
      } catch { /* ignore */ }
    }
  }

  return false;
}


// ─── Model pool helpers ───────────────────────────────────────────

/** Known max output tokens for common models. */
const KNOWN_MAX_OUTPUT: Record<string, number> = {
  "anthropic/claude-opus-4.7": 32000,
  "anthropic/claude-opus-4-7": 32000,
  "claude-opus-4-7": 32000,
  "anthropic/claude-sonnet-4.6": 16000,
  "anthropic/claude-sonnet-4-6": 16000,
  "claude-sonnet-4-6": 16000,
  "anthropic/claude-haiku-4.5": 8192,
  "anthropic/claude-haiku-4-5": 8192,
  "claude-haiku-4-5": 8192,
  "openai/gpt-5": 32000,
  "openai/gpt-5-mini": 32000,
  "openai/gpt-5-nano": 16000,
  "gpt-5": 32000,
  "gpt-5-mini": 32000,
  "gpt-5-nano": 16000,
  "openai/gpt-4o": 16384,
  "gpt-4o": 16384,
  "openai/o4-mini": 100000,
  "o4-mini": 100000,
  "openai/o3": 100000,
  "o3": 100000,
  "google/gemini-2.5-pro": 65536,
  "google/gemini-2.5-flash": 65536,
  "gemini-2.5-pro": 65536,
  "gemini-2.5-flash": 65536,
  "gemini-2.0-flash": 8192,
  "deepseek/deepseek-v3.2": 8192,
  "deepseek/deepseek-r1": 8192,
  "deepseek-v4-flash": 8192,
  "deepseek-v4-pro": 65536,
  "qwen/qwen3-coder": 16384,
  "meta-llama/llama-4-maverick": 32000,
};

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
 * Derive a short key from a model path.
 * "anthropic/claude-opus-4.7" → "claude-opus"
 * "openai/gpt-5" → "gpt"
 * "deepseek/deepseek-chat" → "deepseek"
 */
export function modelKey(model: string): string {
  const slash = model.lastIndexOf("/");
  const base = slash >= 0 ? model.slice(slash + 1) : model;
  // claude models: "claude-opus-4.6" → "claude-opus", "claude-sonnet-4.6" → "claude-sonnet"
  if (base.startsWith("claude-")) {
    const parts = base.split("-");
    return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : parts[0]!;
  }
  // gpt: "gpt-5" → "gpt", "gpt-4o" → "gpt4o"
  if (base.startsWith("gpt-")) {
    const rest = base.slice(4);
    if (/^\d/.test(rest)) return "gpt";
    return `gpt${rest.split("-")[0]}`;
  }
  // gemini: "gemini-3.1-pro-preview" → "gemini-pro", "gemini-3-flash-preview" → "gemini-flash"
  if (base.startsWith("gemini-")) {
    if (base.includes("flash")) return "gemini-flash";
    if (base.includes("pro")) return "gemini-pro";
    return "gemini";
  }
  // deepseek: "deepseek-v3.2" → "deepseek", "deepseek-r1" → "deepseek-r1"
  if (base.startsWith("deepseek-")) {
    if (base.includes("r1")) return "deepseek-r1";
    return "deepseek";
  }
  // qwen: "qwen3-coder" → "qwen-coder", "qwen3-235b-a22b" → "qwen"
  if (base.startsWith("qwen")) {
    if (base.includes("coder")) return "qwen-coder";
    return "qwen";
  }
  // o4-mini, o3
  if (/^o\d/.test(base)) return base.split("-")[0]!;
  // llama-4-maverick → "llama"
  if (base.startsWith("llama")) return "llama";
  // devstral-medium → "devstral"
  if (base.startsWith("devstral")) return "devstral";
  // fallback: first segment
  return base.split("-")[0] ?? base;
}

/**
 * Build model pool entries from a provider's model list.
 */
export function buildModelPool(
  provider: ProviderDef,
  apiKey: string,
): Array<{ key: string; label: string; provider: string; model: string; baseUrl: string; apiKey: string; maxOutputTokens?: number }> {
  const models = resolveProviderModels(provider);
  return models.map((m) => ({
    key: modelKey(m),
    label: modelDisplayName(m),
    provider: provider.provider,
    model: m,
    baseUrl: provider.baseUrl,
    apiKey,
    maxOutputTokens: resolveMaxOutput(m),
  }));
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

export function saveSettings(result: OnboardingResult, providerDef?: ProviderDef, poolModels?: string[]): void {
  const dir = join(homedir(), ".code-shell");
  const file = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, "utf-8")); } catch {}
  }

  const updated: Record<string, unknown> = {
    ...existing,
    model: {
      ...(typeof existing.model === "object" ? existing.model : {}),
      provider: result.provider,
      name: result.model,
      apiKey: result.apiKey,
      baseUrl: result.baseUrl,
    },
  };

  // Build model pool from user-selected models
  if (providerDef && poolModels && poolModels.length > 0) {
    const allEntries = buildModelPool(providerDef, result.apiKey);
    const selectedSet = new Set(poolModels);
    updated.models = allEntries.filter((e) => selectedSet.has(e.model));
  }

  writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

// saveArenaSettings removed — replaced by saveArenaSettingsByKeys

export function saveArenaSettingsByKeys(keys: string[]): void {
  const dir = join(homedir(), ".code-shell");
  const file = join(dir, "settings.json");

  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, "utf-8")); } catch {}
  }

  const updated = {
    ...existing,
    arena: { participants: keys },
  };

  writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

