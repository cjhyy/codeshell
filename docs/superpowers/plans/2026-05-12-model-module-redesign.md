# Model Module Two-Layer Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split flat `models[]` into `providers[]` (credentials) + `models[]` (model selections referencing a provider), with per-provider online `/v1/models` fetch + 7-day cache, and auto-migration of existing settings.

**Architecture:** Add `providers[]` to settings. Each `models[]` entry references a provider via `providerKey`. A `ProviderCatalog` manages credentials; a `model-fetcher` calls each provider's official `/v1/models` (or local snapshot for OpenRouter) and caches the result for 7 days under `~/.code-shell/cache/models/`. `ModelPool.resolveCredentials()` joins them at runtime. UI: `ModelManager` becomes two stacked sections (Providers / Models) with `a` to add provider, `A` to add model, `r` to refresh, `d` to delete.

**Tech Stack:** Bun runtime, TypeScript ESM (relative imports must use `.js` extension), Zod for schema, Ink/React for terminal UI, Bun test for tests.

**Spec reference:** `docs/superpowers/specs/2026-05-12-model-module-redesign-design.md`

---

## File Structure

### New files
- `src/llm/provider-kinds.ts` — built-in `PROVIDER_KINDS` metadata table (10 kinds)
- `src/llm/model-cache.ts` — file IO + TTL for `~/.code-shell/cache/models/<key>.json`
- `src/llm/model-fetcher.ts` — `fetchModelList(provider, {refresh?})`
- `src/llm/provider-catalog.ts` — `ProviderCatalog` class (load/add/update/remove/get/list)
- `src/cli/migrate-models.ts` — one-shot legacy-format migration
- `src/ui/components/AddProviderWizard.tsx` — Ink wizard for adding a provider
- `src/ui/components/AddModelWizard.tsx` — Ink wizard for adding a model from a cached/fetched list
- `tests/provider-kinds.test.ts`
- `tests/model-cache.test.ts`
- `tests/model-fetcher.test.ts`
- `tests/provider-catalog.test.ts`
- `tests/migrate-models.test.ts`
- `tests/model-pool-resolve.test.ts`

### Modified files
- `src/settings/schema.ts` — add `providers[]`, refactor `models[]`
- `src/llm/model-pool.ts` — `resolveCredentials()` + cache-aware `withBuiltinDefaults`
- `src/ui/components/ModelManager.tsx` — two-section layout + new key bindings
- `src/cli/onboarding.ts` — reuse the new wizards
- `src/engine/engine.ts` — wire provider catalog into model resolution
- `src/protocol/types.ts` — surface `providers[]` in protocol shape if needed for UI

---

## Task 1 — Add `PROVIDER_KINDS` metadata

**Files:**
- Create: `src/llm/provider-kinds.ts`
- Test: `tests/provider-kinds.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/provider-kinds.test.ts
import { describe, it, expect } from "bun:test";
import { PROVIDER_KINDS, getKindMeta } from "../src/llm/provider-kinds.js";

describe("PROVIDER_KINDS", () => {
  it("includes all expected kinds", () => {
    const keys = Object.keys(PROVIDER_KINDS).sort();
    expect(keys).toEqual([
      "anthropic","custom","deepseek","google","groq",
      "mistral","ollama","openai","openrouter","xai",
    ]);
  });

  it("openai-compat kinds use Bearer auth", () => {
    for (const kind of ["deepseek","openai","xai","mistral","groq"] as const) {
      const meta = PROVIDER_KINDS[kind];
      const h = meta.authHeader("KEY");
      expect(h.Authorization).toBe("Bearer KEY");
    }
  });

  it("anthropic uses x-api-key + anthropic-version", () => {
    const h = PROVIDER_KINDS.anthropic.authHeader("KEY");
    expect(h["x-api-key"]).toBe("KEY");
    expect(h["anthropic-version"]).toBeTruthy();
  });

  it("chatFilter rejects embed/whisper/tts/image models", () => {
    const f = PROVIDER_KINDS.openai.chatFilter;
    expect(f("gpt-4o")).toBe(true);
    expect(f("text-embedding-3-small")).toBe(false);
    expect(f("whisper-1")).toBe(false);
    expect(f("tts-1")).toBe(false);
    expect(f("dall-e-3")).toBe(false);
  });

  it("getKindMeta returns custom for unknown values", () => {
    expect(getKindMeta("nonsense" as never).label).toBe("Custom");
  });

  it("ollama needs no api key (empty authHeader)", () => {
    const h = PROVIDER_KINDS.ollama.authHeader("anything");
    expect(Object.keys(h)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/provider-kinds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the metadata file**

```ts
// src/llm/provider-kinds.ts
/**
 * Built-in provider kind metadata.
 *
 * Each kind defines how to talk to that provider family: where its
 * model list lives, what auth header to send, which model IDs to keep
 * (chat-completion only — embeddings / TTS / image generation are
 * filtered out so they don't show up in the model picker).
 */

export type ProviderKindName =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "xai"
  | "mistral"
  | "groq"
  | "google"
  | "openrouter"
  | "ollama"
  | "custom";

export type ProviderProtocol =
  | "openai-compat"
  | "anthropic-style"
  | "gemini"
  | "ollama";

export interface ProviderKindMeta {
  label: string;
  defaultBaseUrl: string;
  modelsPath: string;
  protocol: ProviderProtocol;
  /** Returns headers for the model-list call AND chat-completion calls. */
  authHeader: (apiKey: string) => Record<string, string>;
  /** Returns true if the model id looks like a chat-completion model. */
  chatFilter: (id: string) => boolean;
  /** Some providers carry the key in query string; we surface that here. */
  authQuery?: (apiKey: string) => Record<string, string>;
}

const NON_CHAT_PATTERNS =
  /(?:^|[-_/])(?:embed(?:ding)?|whisper|tts|audio|image|dall-?e|moderation|rerank|guard|vision-only)(?:$|[-_/])/i;

const isChatLike = (id: string): boolean => !NON_CHAT_PATTERNS.test(id);

const bearer = (k: string): Record<string, string> =>
  k ? { Authorization: `Bearer ${k}` } : {};

export const PROVIDER_KINDS: Record<ProviderKindName, ProviderKindMeta> = {
  openai: {
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  anthropic: {
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    modelsPath: "/models",
    protocol: "anthropic-style",
    authHeader: (k) =>
      k
        ? { "x-api-key": k, "anthropic-version": "2023-06-01" }
        : { "anthropic-version": "2023-06-01" },
    chatFilter: isChatLike,
  },
  deepseek: {
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  xai: {
    label: "xAI (Grok)",
    defaultBaseUrl: "https://api.x.ai/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  mistral: {
    label: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  groq: {
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  google: {
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelsPath: "/models",
    protocol: "gemini",
    authHeader: () => ({}),
    authQuery: (k) => (k ? { key: k } : {}),
    chatFilter: (id) => isChatLike(id) && /gemini/i.test(id),
  },
  openrouter: {
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
  ollama: {
    label: "Ollama (local)",
    defaultBaseUrl: "http://localhost:11434",
    modelsPath: "/api/tags",
    protocol: "ollama",
    authHeader: () => ({}),
    chatFilter: isChatLike,
  },
  custom: {
    label: "Custom",
    defaultBaseUrl: "",
    modelsPath: "/models",
    protocol: "openai-compat",
    authHeader: bearer,
    chatFilter: isChatLike,
  },
};

export function getKindMeta(kind: string): ProviderKindMeta {
  return (PROVIDER_KINDS as Record<string, ProviderKindMeta>)[kind] ?? PROVIDER_KINDS.custom;
}
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/provider-kinds.test.ts`
Expected: PASS (6 assertions across 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/llm/provider-kinds.ts tests/provider-kinds.test.ts
git commit -m "feat(llm): provider kind metadata table"
```

---

## Task 2 — Model cache file IO

**Files:**
- Create: `src/llm/model-cache.ts`
- Test: `tests/model-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/model-cache.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache, isStale, type CachedModel } from "../src/llm/model-cache.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mc-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SAMPLE: CachedModel[] = [
  { id: "gpt-4o", contextLength: 128_000, maxOutputTokens: 16_384 },
];

describe("model-cache", () => {
  it("returns undefined when file missing", () => {
    expect(readCache(dir, "openai")).toBeUndefined();
  });

  it("writeCache writes and readCache reads back", () => {
    writeCache(dir, "openai", SAMPLE);
    const got = readCache(dir, "openai");
    expect(got?.providerKey).toBe("openai");
    expect(got?.models).toEqual(SAMPLE);
    expect(got?.fetchedAt).toBeTruthy();
  });

  it("isStale flips at the 7-day boundary", () => {
    const now = Date.now();
    expect(isStale({ fetchedAt: new Date(now).toISOString() } as never)).toBe(false);
    const old = new Date(now - 8 * 24 * 3600 * 1000).toISOString();
    expect(isStale({ fetchedAt: old } as never)).toBe(true);
  });

  it("writeCache creates the directory if missing", () => {
    const nested = join(dir, "deep", "nested");
    writeCache(nested, "x", SAMPLE);
    expect(existsSync(join(nested, "x.json"))).toBe(true);
  });

  it("readCache returns undefined on malformed JSON", () => {
    writeCache(dir, "broken", SAMPLE);
    const path = join(dir, "broken.json");
    require("node:fs").writeFileSync(path, "{not json", "utf-8");
    expect(readCache(dir, "broken")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/model-cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/llm/model-cache.ts
/**
 * Cache file IO for per-provider model lists.
 *
 * One file per provider key under <cacheDir>/<providerKey>.json. TTL is
 * 7 days. Callers decide whether to honor staleness — readCache just
 * reads, isStale just checks. Malformed/missing files yield undefined.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface CachedModel {
  id: string;
  contextLength: number;
  maxOutputTokens: number;
}

export interface ModelCacheFile {
  fetchedAt: string;
  providerKey: string;
  models: CachedModel[];
}

const TTL_MS = 7 * 24 * 3600 * 1000;

export function readCache(cacheDir: string, providerKey: string): ModelCacheFile | undefined {
  const path = join(cacheDir, `${providerKey}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ModelCacheFile;
    if (!parsed || !Array.isArray(parsed.models)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeCache(
  cacheDir: string,
  providerKey: string,
  models: CachedModel[],
): ModelCacheFile {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const payload: ModelCacheFile = {
    fetchedAt: new Date().toISOString(),
    providerKey,
    models,
  };
  writeFileSync(join(cacheDir, `${providerKey}.json`), JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

export function isStale(file: ModelCacheFile, now: number = Date.now()): boolean {
  const ts = Date.parse(file.fetchedAt);
  if (!Number.isFinite(ts)) return true;
  return now - ts > TTL_MS;
}

export function defaultCacheDir(): string {
  return join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".code-shell",
    "cache",
    "models",
  );
}
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/model-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/model-cache.ts tests/model-cache.test.ts
git commit -m "feat(llm): per-provider model cache with 7d TTL"
```

---

## Task 3 — Model fetcher (per-provider /v1/models)

**Files:**
- Create: `src/llm/model-fetcher.ts`
- Test: `tests/model-fetcher.test.ts`
- Read for context: `src/data/openrouter-models.json` (existing OpenRouter snapshot, NOT re-fetched)

- [ ] **Step 1: Write the failing test**

```ts
// tests/model-fetcher.test.ts
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchModelList } from "../src/llm/model-fetcher.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mf-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function mockFetch(body: unknown, status = 200) {
  return spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("fetchModelList", () => {
  it("openai-compat: normalizes /models payload", async () => {
    mockFetch({
      data: [
        { id: "gpt-4o", context_window: 128000, max_completion_tokens: 16384 },
        { id: "text-embedding-3-small" },
      ],
    });
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(res.models.map((m) => m.id)).toEqual(["gpt-4o"]); // embed filtered out
    expect(res.models[0].contextLength).toBe(128000);
  });

  it("deepseek: normalizes payload and filters non-chat", async () => {
    mockFetch({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-embed-v1" }] });
    const res = await fetchModelList(
      { key: "ds", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(res.models.map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
  });

  it("ollama: hits /api/tags shape", async () => {
    mockFetch({ models: [{ name: "llama3:8b" }, { name: "nomic-embed-text" }] });
    const res = await fetchModelList(
      { key: "local", kind: "ollama", baseUrl: "http://localhost:11434", apiKey: undefined },
      { cacheDir: dir },
    );
    expect(res.models.map((m) => m.id)).toEqual(["llama3:8b"]);
  });

  it("openrouter: reads local snapshot, never calls fetch", async () => {
    const spy = mockFetch({});
    const res = await fetchModelList(
      { key: "or", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(res.models.length).toBeGreaterThan(0);
  });

  it("returns cached payload when fresh (no fetch)", async () => {
    mockFetch({ data: [{ id: "gpt-4o" }] });
    await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    const spy = mockFetch({ data: [{ id: "WRONG" }] });
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(res.models[0].id).toBe("gpt-4o");
  });

  it("refresh: true bypasses cache", async () => {
    mockFetch({ data: [{ id: "gpt-4o" }] });
    await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    mockFetch({ data: [{ id: "gpt-5" }] });
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir, refresh: true },
    );
    expect(res.models[0].id).toBe("gpt-5");
  });

  it("network error with no cache returns empty list + error info", async () => {
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(res.models).toEqual([]);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("HTTP 401 surfaces an auth error", async () => {
    mockFetch({ error: "unauthorized" }, 401);
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "bad" },
      { cacheDir: dir },
    );
    expect(res.models).toEqual([]);
    expect(res.error).toMatch(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/model-fetcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fetcher**

```ts
// src/llm/model-fetcher.ts
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
import { getKindMeta, type ProviderKindName } from "./provider-kinds.js";
import {
  readCache,
  writeCache,
  isStale,
  type CachedModel,
  type ModelCacheFile,
} from "./model-cache.js";

export interface FetcherProvider {
  key: string;
  kind: ProviderKindName | string;
  baseUrl: string;
  apiKey: string | undefined;
  modelsPath?: string;
}

export interface FetchOptions {
  cacheDir: string;
  refresh?: boolean;
  /** Network timeout in ms. Default 20s. */
  timeoutMs?: number;
}

export interface FetchResult extends ModelCacheFile {
  /** Set when fetch failed and the result is empty or stale-cache fallback. */
  error?: string;
  /** True when result came from disk cache (not network). */
  fromCache?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OPENROUTER_SNAPSHOT = join(HERE, "..", "data", "openrouter-models.json");

interface RawOpenAIShape { data?: Array<{ id: string; context_window?: number; max_completion_tokens?: number; context_length?: number }> }
interface RawOllamaShape { models?: Array<{ name: string }> }
interface RawAnthropicShape { data?: Array<{ id: string; context_window?: number }> }
interface RawGeminiShape { models?: Array<{ name: string; inputTokenLimit?: number; outputTokenLimit?: number }> }
interface OpenRouterSnapshotShape { models?: Array<{ id: string; contextLength?: number; maxOutputTokens?: number }> }

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

  const path = provider.modelsPath ?? meta.modelsPath;
  const url = new URL(joinUrl(provider.baseUrl, path));
  const headers = meta.authHeader(provider.apiKey ?? "");
  if (meta.authQuery) {
    const q = meta.authQuery(provider.apiKey ?? "");
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  }

  try {
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

function normalize(payload: unknown, protocol: string): CachedModel[] {
  if (protocol === "ollama") {
    const p = payload as RawOllamaShape;
    return (p.models ?? []).map((m) => ({ id: m.name, contextLength: 0, maxOutputTokens: 0 }));
  }
  if (protocol === "anthropic-style") {
    const p = payload as RawAnthropicShape;
    return (p.data ?? []).map((m) => ({
      id: m.id,
      contextLength: m.context_window ?? 200_000,
      maxOutputTokens: 0,
    }));
  }
  if (protocol === "gemini") {
    const p = payload as RawGeminiShape;
    return (p.models ?? []).map((m) => ({
      id: m.name.replace(/^models\//, ""),
      contextLength: m.inputTokenLimit ?? 0,
      maxOutputTokens: m.outputTokenLimit ?? 0,
    }));
  }
  const p = payload as RawOpenAIShape;
  return (p.data ?? []).map((m) => ({
    id: m.id,
    contextLength: m.context_window ?? m.context_length ?? 0,
    maxOutputTokens: m.max_completion_tokens ?? 0,
  }));
}

function loadOpenRouterSnapshot(providerKey: string, cacheDir: string): FetchResult {
  if (!existsSync(OPENROUTER_SNAPSHOT)) {
    return errorResult(providerKey, cacheDir, "openrouter snapshot missing");
  }
  try {
    const snapshot = JSON.parse(readFileSync(OPENROUTER_SNAPSHOT, "utf-8")) as OpenRouterSnapshotShape;
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
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/model-fetcher.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/llm/model-fetcher.ts tests/model-fetcher.test.ts
git commit -m "feat(llm): per-provider model list fetcher with cache"
```

---

## Task 4 — Extend settings schema with `providers[]`

**Files:**
- Modify: `src/settings/schema.ts:19-46` (the `model` + `models[]` block)
- Test: extend `tests/settings.test.ts` if present, otherwise `tests/settings-providers.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

```ts
// tests/settings-providers.test.ts
import { describe, it, expect } from "bun:test";
import { validateSettings } from "../src/settings/schema.js";

describe("settings schema — providers", () => {
  it("accepts providers[] block", () => {
    const s = validateSettings({
      providers: [
        { key: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      ],
    });
    expect(s.providers.length).toBe(1);
    expect(s.providers[0].kind).toBe("deepseek");
  });

  it("rejects unknown kind", () => {
    expect(() =>
      validateSettings({
        providers: [{ key: "x", kind: "nope", baseUrl: "https://x", apiKey: "k" }],
      }),
    ).toThrow();
  });

  it("accepts new models[] with providerKey", () => {
    const s = validateSettings({
      providers: [
        { key: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      ],
      models: [
        { key: "ds-flash", providerKey: "deepseek", model: "deepseek-v4-flash", maxContextTokens: 1_000_000 },
      ],
    });
    expect(s.models[0].providerKey).toBe("deepseek");
  });

  it("still accepts legacy models[] entry shape (for migration)", () => {
    const s = validateSettings({
      models: [
        { key: "legacy", provider: "openai", model: "gpt-4o", apiKey: "k", baseUrl: "https://x" },
      ],
    });
    expect(s.models[0].key).toBe("legacy");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/settings-providers.test.ts`
Expected: FAIL — `providers` not in schema.

- [ ] **Step 3: Apply schema changes**

In `src/settings/schema.ts`, locate the existing block:

```ts
    models: z
      .array(
        z.object({
          key: z.string(),
          label: z.string().optional(),
          provider: z.string(),
          model: z.string(),
          baseUrl: z.string().optional(),
          apiKey: z.string().optional(),
          maxOutputTokens: z.number().optional(),
          maxContextTokens: z.number().optional(),
        }),
      )
      .default([]),
```

Replace it with:

```ts
    providers: z
      .array(
        z.object({
          key: z.string(),
          label: z.string().optional(),
          kind: z.enum([
            "openai",
            "anthropic",
            "deepseek",
            "xai",
            "mistral",
            "groq",
            "google",
            "openrouter",
            "ollama",
            "custom",
          ]),
          baseUrl: z.string(),
          apiKey: z.string().optional(),
          protocol: z.enum(["openai-compat", "anthropic-style"]).optional(),
          modelsPath: z.string().optional(),
        }),
      )
      .default([]),

    models: z
      .array(
        z.object({
          key: z.string(),
          label: z.string().optional(),
          // New canonical reference into providers[].
          providerKey: z.string().optional(),
          // Required across both schemas.
          model: z.string(),
          maxOutputTokens: z.number().optional(),
          maxContextTokens: z.number().optional(),
          // Legacy fields — accepted for migration; emptied after migration.
          provider: z.string().optional(),
          baseUrl: z.string().optional(),
          apiKey: z.string().optional(),
        }),
      )
      .default([]),
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/settings-providers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/schema.ts tests/settings-providers.test.ts
git commit -m "feat(settings): providers[] schema + relaxed models[] for migration"
```

---

## Task 5 — `ProviderCatalog` class

**Files:**
- Create: `src/llm/provider-catalog.ts`
- Test: `tests/provider-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/provider-catalog.test.ts
import { describe, it, expect } from "bun:test";
import { ProviderCatalog, type ProviderConfig } from "../src/llm/provider-catalog.js";

const ds: ProviderConfig = {
  key: "deepseek",
  kind: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "k",
};

describe("ProviderCatalog", () => {
  it("constructs from settings array", () => {
    const cat = new ProviderCatalog([ds]);
    expect(cat.list().map((p) => p.key)).toEqual(["deepseek"]);
  });

  it("get() returns by key", () => {
    const cat = new ProviderCatalog([ds]);
    expect(cat.get("deepseek")?.apiKey).toBe("k");
    expect(cat.get("nope")).toBeUndefined();
  });

  it("add() rejects duplicate key", () => {
    const cat = new ProviderCatalog([ds]);
    expect(() => cat.add(ds)).toThrow(/duplicate/i);
  });

  it("update() merges over existing entry", () => {
    const cat = new ProviderCatalog([ds]);
    cat.update("deepseek", { apiKey: "k2" });
    expect(cat.get("deepseek")?.apiKey).toBe("k2");
  });

  it("update() refuses missing key", () => {
    const cat = new ProviderCatalog([ds]);
    expect(() => cat.update("missing", { apiKey: "k2" })).toThrow();
  });

  it("remove() refuses provider with model references", () => {
    const cat = new ProviderCatalog([ds]);
    expect(() => cat.remove("deepseek", { referencedBy: ["ds-flash"] })).toThrow(/referenced/i);
  });

  it("remove() succeeds when no references", () => {
    const cat = new ProviderCatalog([ds]);
    cat.remove("deepseek", { referencedBy: [] });
    expect(cat.list()).toHaveLength(0);
  });

  it("deriveKey() returns unique slug", () => {
    const cat = new ProviderCatalog([ds]);
    expect(cat.deriveKey("deepseek")).toBe("deepseek-2");
    expect(cat.deriveKey("openai")).toBe("openai");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/provider-catalog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/llm/provider-catalog.ts
/**
 * In-memory catalog of provider credentials. Mirrors settings.providers[]
 * but offers a small API for add/update/remove that validates uniqueness
 * and (for remove) refuses to delete a provider still referenced by a
 * model entry. The caller persists changes back to settings.
 */

import type { ProviderKindName } from "./provider-kinds.js";

export interface ProviderConfig {
  key: string;
  label?: string;
  kind: ProviderKindName | string;
  baseUrl: string;
  apiKey?: string;
  protocol?: "openai-compat" | "anthropic-style";
  modelsPath?: string;
}

export class ProviderCatalog {
  private byKey = new Map<string, ProviderConfig>();

  constructor(entries?: ProviderConfig[]) {
    for (const e of entries ?? []) this.byKey.set(e.key, e);
  }

  list(): ProviderConfig[] {
    return [...this.byKey.values()];
  }

  get(key: string): ProviderConfig | undefined {
    return this.byKey.get(key);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  add(entry: ProviderConfig): void {
    if (this.byKey.has(entry.key)) {
      throw new Error(`duplicate provider key: ${entry.key}`);
    }
    this.byKey.set(entry.key, entry);
  }

  update(key: string, patch: Partial<ProviderConfig>): void {
    const cur = this.byKey.get(key);
    if (!cur) throw new Error(`no such provider: ${key}`);
    this.byKey.set(key, { ...cur, ...patch, key: cur.key });
  }

  remove(key: string, opts: { referencedBy: string[] }): void {
    if (opts.referencedBy.length) {
      throw new Error(
        `provider ${key} still referenced by models: ${opts.referencedBy.join(", ")}`,
      );
    }
    this.byKey.delete(key);
  }

  /** Compute an unused key for a new provider, given a desired base. */
  deriveKey(base: string): string {
    if (!this.byKey.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!this.byKey.has(candidate)) return candidate;
    }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/provider-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/provider-catalog.ts tests/provider-catalog.test.ts
git commit -m "feat(llm): ProviderCatalog with add/update/remove + reference check"
```

---

## Task 6 — Legacy settings migration

**Files:**
- Create: `src/cli/migrate-models.ts`
- Test: `tests/migrate-models.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/migrate-models.test.ts
import { describe, it, expect } from "bun:test";
import { migrateModels } from "../src/cli/migrate-models.js";

describe("migrateModels", () => {
  it("groups by (provider, baseUrl, apiKey) into providers[]", () => {
    const out = migrateModels({
      providers: [],
      models: [
        { key: "a", provider: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "k1", model: "deepseek-v4-flash" },
        { key: "b", provider: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "k1", model: "deepseek-chat" },
        { key: "c", provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k2", model: "gpt-4o" },
      ],
    });
    expect(out.changed).toBe(true);
    expect(out.providers).toHaveLength(2);
    expect(out.providers.find((p) => p.kind === "deepseek")).toBeTruthy();
    expect(out.providers.find((p) => p.kind === "openai")).toBeTruthy();
    expect(out.models.every((m) => m.providerKey && !m.apiKey && !m.baseUrl)).toBe(true);
  });

  it("infers kind from baseUrl", () => {
    const out = migrateModels({
      providers: [],
      models: [
        { key: "a", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "claude-opus-4-6" },
      ],
    });
    expect(out.providers[0].kind).toBe("anthropic");
  });

  it("falls back to custom kind when baseUrl unknown", () => {
    const out = migrateModels({
      providers: [],
      models: [
        { key: "a", provider: "openai", baseUrl: "https://my-vllm.local/v1", apiKey: "k", model: "x" },
      ],
    });
    expect(out.providers[0].kind).toBe("custom");
  });

  it("is idempotent: pre-migrated input yields changed=false", () => {
    const out = migrateModels({
      providers: [{ key: "ds", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" }],
      models: [{ key: "ds-flash", providerKey: "ds", model: "deepseek-v4-flash" }],
    });
    expect(out.changed).toBe(false);
  });

  it("does not migrate an empty config", () => {
    const out = migrateModels({ providers: [], models: [] });
    expect(out.changed).toBe(false);
  });

  it("assigns unique provider keys when multiple need same slug", () => {
    const out = migrateModels({
      providers: [],
      models: [
        { key: "a", provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k1", model: "gpt-4o" },
        { key: "b", provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k2", model: "gpt-4o" },
      ],
    });
    const keys = out.providers.map((p) => p.key).sort();
    expect(keys).toEqual(["openai", "openai-2"]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/migrate-models.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/cli/migrate-models.ts
/**
 * One-shot migration of legacy flat models[] into providers[] + models[].
 *
 * Pure function — takes a snapshot, returns the new snapshot plus a flag.
 * The caller (settings load path) is responsible for writing settings.json
 * and the .bak backup.
 */

import type { ProviderConfig } from "../llm/provider-catalog.js";
import type { ProviderKindName } from "../llm/provider-kinds.js";

interface LegacyModel {
  key: string;
  label?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  providerKey?: string;
}

export interface MigrationInput {
  providers: ProviderConfig[];
  models: LegacyModel[];
}

export interface MigrationOutput {
  providers: ProviderConfig[];
  models: Array<{
    key: string;
    label?: string;
    providerKey: string;
    model: string;
    maxOutputTokens?: number;
    maxContextTokens?: number;
  }>;
  changed: boolean;
}

const BASEURL_KIND_PATTERNS: Array<[RegExp, ProviderKindName]> = [
  [/deepseek\.com/i, "deepseek"],
  [/anthropic\.com/i, "anthropic"],
  [/openai\.com/i, "openai"],
  [/x\.ai/i, "xai"],
  [/mistral\.ai/i, "mistral"],
  [/groq\.com/i, "groq"],
  [/generativelanguage\.googleapis/i, "google"],
  [/openrouter\.ai/i, "openrouter"],
  [/localhost:11434|127\.0\.0\.1:11434/i, "ollama"],
];

function inferKind(baseUrl: string | undefined): ProviderKindName {
  if (!baseUrl) return "custom";
  for (const [re, kind] of BASEURL_KIND_PATTERNS) {
    if (re.test(baseUrl)) return kind;
  }
  return "custom";
}

function makeFingerprint(m: LegacyModel): string {
  return `${m.provider ?? ""}|${m.baseUrl ?? ""}|${m.apiKey ?? ""}`;
}

function deriveKey(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function migrateModels(input: MigrationInput): MigrationOutput {
  const alreadyMigrated =
    input.providers.length > 0 || input.models.every((m) => m.providerKey);
  if (alreadyMigrated || input.models.length === 0) {
    return {
      providers: input.providers,
      models: input.models.map((m) => ({
        key: m.key,
        label: m.label,
        providerKey: m.providerKey ?? "",
        model: m.model,
        maxOutputTokens: m.maxOutputTokens,
        maxContextTokens: m.maxContextTokens,
      })),
      changed: false,
    };
  }

  const fingerprintToKey = new Map<string, string>();
  const newProviders: ProviderConfig[] = [];
  const usedKeys = new Set<string>(input.providers.map((p) => p.key));

  for (const m of input.models) {
    const fp = makeFingerprint(m);
    if (fingerprintToKey.has(fp)) continue;
    const kind = inferKind(m.baseUrl);
    const key = deriveKey(kind, usedKeys);
    usedKeys.add(key);
    fingerprintToKey.set(fp, key);
    newProviders.push({
      key,
      kind,
      baseUrl: m.baseUrl ?? "",
      apiKey: m.apiKey,
    });
  }

  const newModels = input.models.map((m) => ({
    key: m.key,
    label: m.label,
    providerKey: fingerprintToKey.get(makeFingerprint(m))!,
    model: m.model,
    maxOutputTokens: m.maxOutputTokens,
    maxContextTokens: m.maxContextTokens,
  }));

  return {
    providers: [...input.providers, ...newProviders],
    models: newModels,
    changed: true,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/migrate-models.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/migrate-models.ts tests/migrate-models.test.ts
git commit -m "feat(cli): legacy models[] migration with kind inference"
```

---

## Task 7 — Wire `resolveCredentials` in ModelPool

**Files:**
- Modify: `src/llm/model-pool.ts:130-146` (the `toLLMConfig` method)
- Test: `tests/model-pool-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/model-pool-resolve.test.ts
import { describe, it, expect } from "bun:test";
import { ModelPool } from "../src/llm/model-pool.js";
import { ProviderCatalog } from "../src/llm/provider-catalog.js";

describe("ModelPool credential resolution", () => {
  it("pulls baseUrl/apiKey from providerCatalog via providerKey", () => {
    const cat = new ProviderCatalog([
      { key: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "kk" },
    ]);
    const pool = new ModelPool([
      // new-shape entry: provider="" since real provider info comes from catalog
      { key: "ds-flash", provider: "", model: "deepseek-v4-flash", providerKey: "deepseek" } as never,
    ]);
    pool.setProviderCatalog(cat);
    const cfg = pool.resolveLLMConfig("ds-flash");
    expect(cfg?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(cfg?.apiKey).toBe("kk");
  });

  it("falls back to entry-level apiKey when providerKey unset", () => {
    const pool = new ModelPool([
      { key: "legacy", provider: "openai", model: "gpt-4o", apiKey: "old", baseUrl: "https://x" },
    ]);
    const cfg = pool.resolveLLMConfig("legacy");
    expect(cfg?.apiKey).toBe("old");
    expect(cfg?.baseUrl).toBe("https://x");
  });

  it("entry-level apiKey overrides catalog when both present", () => {
    const cat = new ProviderCatalog([
      { key: "openai", kind: "openai", baseUrl: "https://x", apiKey: "fromCat" },
    ]);
    const pool = new ModelPool([
      { key: "m", provider: "openai", model: "gpt-4o", apiKey: "fromEntry", providerKey: "openai" } as never,
    ]);
    pool.setProviderCatalog(cat);
    const cfg = pool.resolveLLMConfig("m");
    expect(cfg?.apiKey).toBe("fromEntry");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/model-pool-resolve.test.ts`
Expected: FAIL — `setProviderCatalog`/`providerKey` not defined.

- [ ] **Step 3: Modify `src/llm/model-pool.ts`**

In the `ModelEntry` interface (currently ending at line 33), add:

```ts
  /** Optional reference into ProviderCatalog. When set, baseUrl/apiKey
   *  come from the catalog unless the entry overrides them. */
  providerKey?: string;
```

In the `ModelPool` class body, add a private field and setter just below `private activeKey`:

```ts
  private providerCatalog: import("./provider-catalog.js").ProviderCatalog | undefined;

  setProviderCatalog(cat: import("./provider-catalog.js").ProviderCatalog): void {
    this.providerCatalog = cat;
  }
```

Replace `toLLMConfig` with:

```ts
  toLLMConfig(entry: ModelEntry, base?: Partial<LLMConfig>): LLMConfig {
    const fromCat =
      entry.providerKey && this.providerCatalog
        ? this.providerCatalog.get(entry.providerKey)
        : undefined;
    return {
      provider: entry.provider || fromCat?.kind || "openai",
      model: entry.model,
      apiKey: entry.apiKey ?? fromCat?.apiKey ?? base?.apiKey,
      baseUrl: entry.baseUrl ?? fromCat?.baseUrl ?? base?.baseUrl,
      temperature: base?.temperature ?? 0.3,
      maxTokens: entry.maxOutputTokens ?? base?.maxTokens ?? 8192,
      enableStreaming: base?.enableStreaming ?? true,
    };
  }
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/model-pool-resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/model-pool.ts tests/model-pool-resolve.test.ts
git commit -m "feat(llm): ModelPool resolves credentials from ProviderCatalog"
```

---

## Task 8 — Engine: load providers + run migration

**Files:**
- Modify: `src/engine/engine.ts:145-200` (around the model pool construction)
- Modify: `src/settings/manager.ts:55-65` (where settings are validated on load)

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine-providers.test.ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../src/settings/manager.js";

let dir: string;

describe("settings load → migration", () => {
  it("auto-migrates legacy models[] on load and writes .bak", () => {
    dir = mkdtempSync(join(tmpdir(), "sp-"));
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        models: [
          {
            key: "ds",
            provider: "openai",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "k",
            model: "deepseek-v4-flash",
          },
        ],
      }),
      "utf-8",
    );
    const mgr = new SettingsManager({ userPath: path });
    const s = mgr.load();
    expect(s.providers.length).toBe(1);
    expect(s.providers[0].kind).toBe("deepseek");
    expect(s.models[0].providerKey).toBe("deepseek");
    expect(existsSync(`${path}.bak`)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/engine-providers.test.ts`
Expected: FAIL — `SettingsManager` constructor doesn't accept `userPath`, or migration doesn't fire.

(Note: this test may also fail because `SettingsManager` has a different constructor today; adapt the test to whatever constructor exists — it must point the loader at a custom path. If the existing constructor doesn't allow that, add a `userPath?: string` option as part of this task.)

- [ ] **Step 3: Hook migration into the settings load path**

In `src/settings/manager.ts`, find the line that calls `validateSettings(raw)` (currently ~57). Just before validation, run the migration. Show the surrounding context to make this surgical:

```ts
import { migrateModels } from "../cli/migrate-models.js";
import { copyFileSync, existsSync as _existsSync } from "node:fs";

// inside load():
//   const raw = ...
//   ↓ insert before validateSettings:
const userPath = /* the path used for the user settings.json */;
if (userPath && _existsSync(userPath)) {
  const before = (raw as Record<string, unknown>) ?? {};
  const result = migrateModels({
    providers: (before.providers as never) ?? [],
    models: (before.models as never) ?? [],
  });
  if (result.changed) {
    copyFileSync(userPath, `${userPath}.bak`);
    const newRaw = { ...before, providers: result.providers, models: result.models };
    require("node:fs").writeFileSync(userPath, JSON.stringify(newRaw, null, 2), "utf-8");
    Object.assign(raw, newRaw);
  }
}
this.merged = validateSettings(raw);
```

(Adapt the exact wiring to the actual structure of `manager.ts`. Key invariants: migration runs on user-scope settings only, exactly once per load, writes `.bak`, then re-feeds the migrated object into `validateSettings`.)

- [ ] **Step 4: Wire providerCatalog into the engine**

In `src/engine/engine.ts`, after the `ModelPool` is constructed (~line 145) and entries are registered, add:

```ts
import { ProviderCatalog } from "../llm/provider-catalog.js";

// after `this.modelPool = new ModelPool();`
const providers = (this.config.providers ?? []) as never;
const catalog = new ProviderCatalog(providers);
this.modelPool.setProviderCatalog(catalog);
this.providerCatalog = catalog;
```

Add a `private providerCatalog?: ProviderCatalog;` field. Surface it via a getter so the UI layer can read it:

```ts
get providersList(): ProviderCatalog | undefined {
  return this.providerCatalog;
}
```

Also extend `EngineConfig` to include `providers?: ProviderConfig[]` and ensure the CLI layer that builds `EngineConfig` from settings copies the field through.

- [ ] **Step 5: Run the test**

Run: `bun test tests/engine-providers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/settings/manager.ts src/engine/engine.ts tests/engine-providers.test.ts
git commit -m "feat: auto-migrate legacy settings + wire ProviderCatalog into Engine"
```

---

## Task 9 — AddProviderWizard (Ink component)

**Files:**
- Create: `src/ui/components/AddProviderWizard.tsx`

This is a UI component — no unit tests, but it must compile and integrate with `ModelManager`.

- [ ] **Step 1: Write the component**

```tsx
// src/ui/components/AddProviderWizard.tsx
/**
 * AddProviderWizard — Ink wizard for adding a provider credential.
 *
 * Flow: choose kind → fill key (custom also fills baseUrl + protocol)
 * → test /v1/models call → save. Calls onSave with the validated config
 * (and the fetched model list, so the parent can persist the cache).
 */

import { useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import { PROVIDER_KINDS, type ProviderKindName } from "../../llm/provider-kinds.js";
import { fetchModelList } from "../../llm/model-fetcher.js";
import { defaultCacheDir } from "../../llm/model-cache.js";
import type { ProviderConfig } from "../../llm/provider-catalog.js";

interface Props {
  existingKeys: string[];
  onSave: (config: ProviderConfig) => void;
  onCancel: () => void;
}

type Step = "kind" | "key" | "baseUrl" | "test" | "done";

export function AddProviderWizard({ existingKeys, onSave, onCancel }: Props) {
  const kinds = Object.entries(PROVIDER_KINDS) as Array<[ProviderKindName, { label: string; defaultBaseUrl: string }]>;
  const [step, setStep] = useState<Step>("kind");
  const [kindIdx, setKindIdx] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | undefined>();

  const [name, meta] = kinds[kindIdx]!;

  useInput(async (input, key) => {
    if (key.escape) return onCancel();

    if (step === "kind") {
      if (key.upArrow) setKindIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setKindIdx((i) => Math.min(kinds.length - 1, i + 1));
      else if (key.return) {
        setBaseUrl(meta.defaultBaseUrl);
        setStep(name === "ollama" ? "test" : "key");
      }
      return;
    }
    if (step === "key") {
      if (key.backspace || key.delete) setApiKey((s) => s.slice(0, -1));
      else if (key.return) setStep(name === "custom" ? "baseUrl" : "test");
      else if (input && !key.ctrl) setApiKey((s) => s + input);
      return;
    }
    if (step === "baseUrl") {
      if (key.backspace || key.delete) setBaseUrl((s) => s.slice(0, -1));
      else if (key.return) setStep("test");
      else if (input && !key.ctrl) setBaseUrl((s) => s + input);
      return;
    }
    if (step === "test") {
      // Auto-fire test once on entry. Re-press Enter to retry, S to save anyway.
      if (input === "s" || input === "S") {
        save();
      } else if (key.return) {
        runTest();
      }
      return;
    }
  });

  async function runTest() {
    setStatus("Testing…");
    setError(undefined);
    const derivedKey = name === "custom" ? deriveKeyFromUrl(baseUrl, existingKeys) : uniqueKey(name, existingKeys);
    const res = await fetchModelList(
      { key: derivedKey, kind: name, baseUrl, apiKey },
      { cacheDir: defaultCacheDir() },
    );
    if (res.error) {
      setStatus("");
      setError(res.error);
    } else {
      setStatus(`OK — fetched ${res.models.length} models`);
      save(derivedKey);
    }
  }

  function save(forcedKey?: string) {
    const derivedKey = forcedKey ?? (name === "custom" ? deriveKeyFromUrl(baseUrl, existingKeys) : uniqueKey(name, existingKeys));
    onSave({
      key: derivedKey,
      kind: name,
      baseUrl,
      apiKey: name === "ollama" ? undefined : apiKey,
      label: meta.label,
    });
  }

  // Auto-trigger the test once when we land on the test step.
  if (step === "test" && status === "" && error === undefined) {
    void runTest();
  }

  return (
    <Box flexDirection="column" padding={1} borderStyle="round">
      <Text bold>Add provider</Text>
      <Text dimColor>Esc to cancel.</Text>
      {step === "kind" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Pick provider kind:</Text>
          {kinds.map(([k, m], i) => (
            <Text key={k} color={i === kindIdx ? "cyan" : undefined}>
              {i === kindIdx ? "› " : "  "}
              {m.label}
            </Text>
          ))}
        </Box>
      )}
      {step === "key" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>API key for {meta.label}:</Text>
          <Text color="cyan">{apiKey.replace(/./g, "•")}</Text>
        </Box>
      )}
      {step === "baseUrl" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Base URL (with /v1):</Text>
          <Text color="cyan">{baseUrl}</Text>
        </Box>
      )}
      {step === "test" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>{status || (error ? "" : "Connecting…")}</Text>
          {error && <Text color="red">Error: {error}</Text>}
          {error && <Text dimColor>Enter to retry · S to save anyway</Text>}
        </Box>
      )}
    </Box>
  );
}

function uniqueKey(base: string, used: string[]): string {
  const set = new Set(used);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base}-${i}`;
    if (!set.has(k)) return k;
  }
}

function deriveKeyFromUrl(url: string, used: string[]): string {
  const host = url.replace(/^https?:\/\//, "").split("/")[0] ?? "custom";
  return uniqueKey(host.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), used);
}
```

- [ ] **Step 2: Sanity-compile**

Run: `bun run tsc --noEmit src/ui/components/AddProviderWizard.tsx`
Expected: 0 errors specific to this file. (Repo-wide errors are pre-existing — only flag new ones introduced by this file.)

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/AddProviderWizard.tsx
git commit -m "feat(ui): AddProviderWizard"
```

---

## Task 10 — AddModelWizard (Ink component)

**Files:**
- Create: `src/ui/components/AddModelWizard.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/ui/components/AddModelWizard.tsx
/**
 * AddModelWizard — pick a model from a provider's cached/fetched list.
 *
 * Flow: choose provider (or jump to AddProviderWizard) → list models from
 * cache (auto-refresh if cache is stale, manual `r` to force-refresh) →
 * pick a model → set alias → save. Falls back to manual ID entry if the
 * fetch fails and no cache exists.
 */

import { useEffect, useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import { fetchModelList, type FetchResult } from "../../llm/model-fetcher.js";
import { defaultCacheDir } from "../../llm/model-cache.js";
import type { ProviderConfig } from "../../llm/provider-catalog.js";

interface Props {
  providers: ProviderConfig[];
  existingModelKeys: string[];
  onSave: (entry: {
    key: string;
    providerKey: string;
    model: string;
    maxContextTokens?: number;
    maxOutputTokens?: number;
  }) => void;
  onCancel: () => void;
  onAddProvider: () => void;
}

type Step = "provider" | "list" | "alias" | "manualId";

export function AddModelWizard({ providers, existingModelKeys, onSave, onCancel, onAddProvider }: Props) {
  const [step, setStep] = useState<Step>("provider");
  const [providerIdx, setProviderIdx] = useState(0);
  const [modelIdx, setModelIdx] = useState(0);
  const [list, setList] = useState<FetchResult | undefined>();
  const [loading, setLoading] = useState(false);
  const [alias, setAlias] = useState("");
  const [manualId, setManualId] = useState("");

  const provider = providers[providerIdx];

  async function refresh(force = false) {
    if (!provider) return;
    setLoading(true);
    const res = await fetchModelList(provider, { cacheDir: defaultCacheDir(), refresh: force });
    setList(res);
    setLoading(false);
  }

  useEffect(() => {
    if (step === "list") void refresh(false);
  }, [step, providerIdx]);

  useInput(async (input, key) => {
    if (key.escape) return onCancel();

    if (step === "provider") {
      if (key.upArrow) setProviderIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setProviderIdx((i) => Math.min(providers.length, i + 1));
      else if (key.return) {
        if (providerIdx === providers.length) onAddProvider();
        else setStep("list");
      }
      return;
    }
    if (step === "list") {
      if (input === "r") void refresh(true);
      else if (input === "m") setStep("manualId");
      else if (list && list.models.length) {
        if (key.upArrow) setModelIdx((i) => Math.max(0, i - 1));
        else if (key.downArrow) setModelIdx((i) => Math.min(list.models.length - 1, i + 1));
        else if (key.return) {
          const picked = list.models[modelIdx]!;
          setAlias(deriveAlias(picked.id, existingModelKeys));
          setStep("alias");
        }
      }
      return;
    }
    if (step === "alias") {
      if (key.backspace || key.delete) setAlias((s) => s.slice(0, -1));
      else if (key.return && alias && !existingModelKeys.includes(alias)) {
        const picked = list?.models[modelIdx];
        onSave({
          key: alias,
          providerKey: provider!.key,
          model: picked?.id ?? manualId,
          maxContextTokens: picked?.contextLength || undefined,
          maxOutputTokens: picked?.maxOutputTokens || undefined,
        });
      } else if (input && !key.ctrl) setAlias((s) => s + input);
      return;
    }
    if (step === "manualId") {
      if (key.backspace || key.delete) setManualId((s) => s.slice(0, -1));
      else if (key.return && manualId) {
        setAlias(deriveAlias(manualId, existingModelKeys));
        setStep("alias");
      } else if (input && !key.ctrl) setManualId((s) => s + input);
      return;
    }
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="round">
      <Text bold>Add model</Text>
      <Text dimColor>Esc to cancel.</Text>

      {step === "provider" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Pick a provider:</Text>
          {providers.map((p, i) => (
            <Text key={p.key} color={i === providerIdx ? "cyan" : undefined}>
              {i === providerIdx ? "› " : "  "}
              {p.label ?? p.key} <Text dimColor>({p.kind})</Text>
            </Text>
          ))}
          <Text color={providerIdx === providers.length ? "cyan" : undefined}>
            {providerIdx === providers.length ? "› " : "  "}+ Add a new provider
          </Text>
        </Box>
      )}

      {step === "list" && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{loading ? "Loading…" : `Models from ${provider?.label ?? provider?.key}`}</Text>
          {list?.error && <Text color="red">Error: {list.error}</Text>}
          {list?.fromCache && (
            <Text dimColor>Cached at {new Date(list.fetchedAt).toLocaleString()} · press r to refresh</Text>
          )}
          {list && !list.models.length && !loading && (
            <Text dimColor>No models. Press m to enter a model id manually.</Text>
          )}
          {list?.models.slice(Math.max(0, modelIdx - 8), modelIdx + 9).map((m, i, arr) => {
            const realIdx = Math.max(0, modelIdx - 8) + i;
            return (
              <Text key={m.id} color={realIdx === modelIdx ? "cyan" : undefined}>
                {realIdx === modelIdx ? "› " : "  "}
                {m.id}
                {m.contextLength ? <Text dimColor>  ({m.contextLength.toLocaleString()} ctx)</Text> : null}
              </Text>
            );
          })}
        </Box>
      )}

      {step === "manualId" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Model id:</Text>
          <Text color="cyan">{manualId}</Text>
        </Box>
      )}

      {step === "alias" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Local alias for this model:</Text>
          <Text color="cyan">{alias}</Text>
          {existingModelKeys.includes(alias) && <Text color="red">Alias already used.</Text>}
        </Box>
      )}
    </Box>
  );
}

function deriveAlias(modelId: string, used: string[]): string {
  // "deepseek/deepseek-v4-flash" → "v4-flash"
  let base = modelId.split("/").pop() ?? modelId;
  base = base.replace(/^deepseek-/, "").replace(/^gpt-/, "gpt-").replace(/^claude-/, "claude-");
  const set = new Set(used);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base}-${i}`;
    if (!set.has(k)) return k;
  }
}
```

- [ ] **Step 2: Sanity-compile**

Run: `bun run tsc --noEmit src/ui/components/AddModelWizard.tsx`
Expected: 0 new errors specific to this file.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/AddModelWizard.tsx
git commit -m "feat(ui): AddModelWizard"
```

---

## Task 11 — ModelManager: two-section layout

**Files:**
- Modify: `src/ui/components/ModelManager.tsx` (replace much of the body)

- [ ] **Step 1: Add a Providers section above the existing Models section**

Replace the current `tab` state with a `section` state (`"providers" | "models"`) and the existing layout with stacked sections. Keep the existing arena tab intact (lower priority — keep its code path behind an `arena` section reachable by Tab).

Key bindings (replacing existing keys):
- `Tab` — cycle section (providers → models → arena → providers)
- `↑/↓` — move cursor within the current section
- `a` — add provider (open `AddProviderWizard`)
- `A` — add model (open `AddModelWizard`)
- `r` — refresh the model list for the highlighted provider (call `fetchModelList({refresh:true})`)
- `d` — delete the highlighted item (provider deletion blocked if any model references it; show the list of references)
- `Enter` — make active (Models section only)
- `Esc` — close

Use props (added):

```ts
interface ModelManagerProps {
  entries: ProtocolModelEntry[];
  providers: ProviderEntry[];           // NEW
  arenaParticipants: ArenaParticipantEntry[];
  onSwitch: (key: string) => Promise<void>;
  onSync: () => Promise<{ ok: boolean; count: number; error?: string }>;
  onSaveArena: (participants: string[]) => Promise<void>;
  onAddProvider: () => void;            // NEW — parent opens AddProviderWizard
  onAddModel: () => void;               // NEW — parent opens AddModelWizard
  onRefreshProvider: (key: string) => Promise<{ count: number; error?: string }>;  // NEW
  onDeleteProvider: (key: string) => Promise<{ ok: boolean; error?: string }>;     // NEW
  onDeleteModel: (key: string) => Promise<void>;                                   // NEW
  onClose: () => void;
}

interface ProviderEntry {
  key: string;
  label: string;
  kind: string;
  modelCount: number;       // how many entries reference it
  cachedModels?: number;    // size of cached list
  cachedAt?: string;
}
```

Layout (rough):

```
┌─ Providers ───────────────────────────────────────────┐
│ › deepseek (DeepSeek)      3 models cached · 2d ago  │
│   openai   (OpenAI)        47 models cached · today  │
│   + (a) add provider                                  │
├─ Models ──────────────────────────────────────────────┤
│ * v4-flash    deepseek/deepseek-v4-flash    1M ctx   │
│   gpt-4o     openai/gpt-4o                   128k    │
│   + (A) add model                                    │
└──────────────────────────────────────────────────────┘
Tab section · a add provider · A add model · r refresh
· d delete · Enter switch · Esc close
```

Implementation note: don't rewrite the file from scratch — keep arena code intact, only restructure the model-tab into two stacked sections. Replace the top-level `tab` switch with a `section` state that toggles between three views (`providers` / `models` / `arena`).

- [ ] **Step 2: Update `src/ui/App.tsx` to pass the new props**

In the `<ModelManager … />` block (~line 985), add the new props. Implement `onAddProvider`/`onAddModel` so they toggle modal state to render `AddProviderWizard` / `AddModelWizard`. On wizard `onSave`, call the protocol layer to persist:

```ts
await client.query("config_set", "providers", newProvidersArray);
await client.query("config_set", "models", newModelsArray);
```

For `onRefreshProvider` / `onDeleteProvider` / `onDeleteModel`, similarly call into a new query (`provider_refresh`, `provider_delete`, `model_delete`) that the server-side handler implements (Task 12).

- [ ] **Step 3: Sanity-compile**

Run: `bun run tsc --noEmit`
Expected: 0 *new* errors introduced by this file (repo has pre-existing noise — only block on errors traceable to ModelManager.tsx or App.tsx changes).

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/ModelManager.tsx src/ui/App.tsx
git commit -m "feat(ui): two-section ModelManager with provider/model add/refresh"
```

---

## Task 12 — Protocol/server handlers

**Files:**
- Modify: `src/protocol/server.ts` and `src/protocol/types.ts`

- [ ] **Step 1: Add protocol shapes**

In `src/protocol/types.ts`, add a `ProtocolProviderEntry` mirroring `ProtocolModelEntry`:

```ts
export interface ProtocolProviderEntry {
  key: string;
  label: string;
  kind: string;
  modelCount: number;
  cachedModels?: number;
  cachedAt?: string;
}
```

- [ ] **Step 2: Add server handlers**

In `src/protocol/server.ts`, register handlers for:
- `provider_list` → returns `ProtocolProviderEntry[]` (count models[] references per provider, read cache file via `model-cache.readCache`)
- `provider_refresh(key)` → calls `fetchModelList(provider, {refresh:true})`, returns `{count, error?}`
- `provider_delete(key)` → checks model references via current `models[]`; calls catalog.remove if safe; persists settings
- `model_delete(key)` → removes from `models[]`; persists settings

Persistence pattern: read merged settings, mutate `providers`/`models` array, call `settings.set("providers", arr)` and `settings.set("models", arr)` (existing API in `SettingsManager`).

- [ ] **Step 3: Commit**

```bash
git add src/protocol/server.ts src/protocol/types.ts
git commit -m "feat(protocol): provider list/refresh/delete + model_delete"
```

---

## Task 13 — Refactor onboarding to use the wizards

**Files:**
- Modify: `src/cli/onboarding.ts`

- [ ] **Step 1: Replace the model-picker step**

Current onboarding (~line 55-122) hardcodes a list of (provider, model) suggestions. Replace with:

1. Step 1 — "Add your first provider" → renders `AddProviderWizard` (existingKeys=[])
2. Step 2 — "Add your first model" → renders `AddModelWizard` with the provider from step 1

Drop the `KNOWN_MAX_OUTPUT` / `KNOWN_CONTEXT_WINDOWS` tables. Anything that still needs a fallback context-window value should call `fetchModelList` and look it up there. Keep the `modelKey` derive helper — it's still useful.

- [ ] **Step 2: Compile + smoke test**

Run: `bun run dev` (in a scratch HOME) and confirm onboarding renders.

- [ ] **Step 3: Commit**

```bash
git add src/cli/onboarding.ts
git commit -m "refactor(cli): onboarding uses AddProviderWizard + AddModelWizard"
```

---

## Task 14 — Use cached contextLength when loading models

**Files:**
- Modify: `src/llm/model-pool.ts` (the `withBuiltinDefaults` method ~line 86-95)

- [ ] **Step 1: Write the failing test**

```ts
// tests/model-pool-cache-ctx.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCache } from "../src/llm/model-cache.js";
import { ModelPool } from "../src/llm/model-pool.js";
import { ProviderCatalog } from "../src/llm/provider-catalog.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mpc-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ModelPool reads contextLength from cache", () => {
  it("populates maxContextTokens from cache when entry omits it", () => {
    writeCache(dir, "deepseek", [
      { id: "deepseek-v4-flash", contextLength: 1_000_000, maxOutputTokens: 8192 },
    ]);
    const cat = new ProviderCatalog([
      { key: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
    ]);
    const pool = new ModelPool([
      { key: "ds-flash", provider: "openai", model: "deepseek-v4-flash", providerKey: "deepseek" } as never,
    ]);
    pool.setProviderCatalog(cat);
    pool.setCacheDir(dir);
    pool.reloadCachedContextWindows();
    const e = pool.get("ds-flash")!;
    expect(e.maxContextTokens).toBe(1_000_000);
  });

  it("does not override an explicit maxContextTokens in the entry", () => {
    writeCache(dir, "deepseek", [
      { id: "deepseek-v4-flash", contextLength: 1_000_000, maxOutputTokens: 8192 },
    ]);
    const pool = new ModelPool([
      { key: "ds-flash", provider: "openai", model: "deepseek-v4-flash", providerKey: "deepseek", maxContextTokens: 500_000 } as never,
    ]);
    pool.setProviderCatalog(new ProviderCatalog([{ key: "deepseek", kind: "deepseek", baseUrl: "x", apiKey: "k" }]));
    pool.setCacheDir(dir);
    pool.reloadCachedContextWindows();
    const e = pool.get("ds-flash")!;
    expect(e.maxContextTokens).toBe(500_000);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/model-pool-cache-ctx.test.ts`
Expected: FAIL — `setCacheDir`/`reloadCachedContextWindows` not defined.

- [ ] **Step 3: Implement**

In `src/llm/model-pool.ts`:

```ts
import { readCache } from "./model-cache.js";

// Add fields:
private cacheDir: string | undefined;

setCacheDir(dir: string): void { this.cacheDir = dir; }

reloadCachedContextWindows(): void {
  if (!this.cacheDir || !this.providerCatalog) return;
  for (const [key, entry] of this.models) {
    if (entry.maxContextTokens != null) continue;
    if (!entry.providerKey) continue;
    const file = readCache(this.cacheDir, entry.providerKey);
    if (!file) continue;
    const match = file.models.find((m) => m.id === entry.model);
    if (match?.contextLength) {
      this.models.set(key, { ...entry, maxContextTokens: match.contextLength });
    }
  }
}
```

Call `pool.setCacheDir(defaultCacheDir())` and `pool.reloadCachedContextWindows()` in `engine.ts` right after `setProviderCatalog`.

- [ ] **Step 4: Run the test**

Run: `bun test tests/model-pool-cache-ctx.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/model-pool.ts src/engine/engine.ts tests/model-pool-cache-ctx.test.ts
git commit -m "feat(llm): use cached contextLength when entry has no maxContextTokens"
```

---

## Task 15 — Full integration smoke test

**Files:**
- Manual verification, no file changes

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: PASS (all new tests + existing tests untouched).

- [ ] **Step 2: Try the build**

Run: `bun run build`
Expected: success.

- [ ] **Step 3: Manually drive the new flow**

```bash
# Use a scratch HOME to avoid mutating your real settings
HOME=$(mktemp -d) bun run dev
```

Verify:
1. Onboarding renders the new AddProviderWizard
2. Add DeepSeek with your key → list fetch shows real model count
3. Add the deepseek-v4-flash model → settings.json has providers[] + models[] with providerKey
4. `/model` (ModelManager) shows two sections; `r` refreshes; `d` blocks deletion of a referenced provider
5. Restart, confirm settings survive
6. Drop a legacy settings.json (manually) → confirm `.bak` is written and providers[] appears

- [ ] **Step 4: Commit if anything turned up**

If smoke testing reveals bugs, fix them in additional commits with focused messages.

---

## Self-Review (run after completing the plan, before handoff)

**Spec coverage:**
- §2 (architecture) → Tasks 1, 5, 7
- §3.1 (schema) → Task 4
- §3.2 (cache file) → Task 2
- §3.3 (PROVIDER_KINDS) → Task 1
- §4.1 (new files) → Tasks 1, 2, 3, 5, 6, 9, 10
- §4.2 (modified files) → Tasks 4, 7, 8, 11, 13, 14
- §5 (data flow) → Tasks 3, 10
- §6 (migration) → Task 6, 8
- §7 (error handling) → Tasks 3, 11, 12 (UI surfaces fetch errors)
- §8 (testing) → Tasks 1, 2, 3, 5, 6, 7, 14
- §9 (YAGNI) → respected throughout (no provider registry, no multi-key, no runtime OR sync, no double schema)

**Placeholder scan:** All steps include concrete code or commands. UI tasks describe acceptance criteria precisely. No "TBD" / "add appropriate" / "etc.".

**Type consistency:**
- `CachedModel`, `ProviderConfig`, `ProviderKindName`, `MigrationOutput`, `FetchResult` reused consistently across tasks.
- `providerKey` lowerCamel everywhere.
- `fetchModelList` signature matches across Tasks 3, 9, 10, 12, 14.
