# llm

**One-line role.** Provider-agnostic LLM access layer: turns a model config into a live client (`createMessage`) and owns the cross-cutting concerns — retry/abort, request deadlines, streaming idle-watchdog, per-(provider,model) capability rules, token counting, and the runtime model registry.

## 职责 / Responsibility

This module is the only place in core that talks to LLM vendor SDKs. It abstracts the differences between providers behind a single `LLMClientBase.createMessage()` contract, so callers (Engine turn-loop, arena phases, session-title, sub-agents) never branch on vendor. It also centralizes the painful operational details — retry policy, half-dead-socket teardown, abort propagation, token-usage funneling, and request-shape rules that prevent vendor 400s. It does **not** decide *which* model to use for a turn (that's the Engine/settings layer) and it does **not** parse or render LLM output (that's the protocol/engine layer); it just produces normalized `LLMResponse`/stream chunks.

## 文件 / Files

| File | Purpose |
|------|---------|
| `client-base.ts` | Abstract `LLMClientBase` (constructor splits `LLMConfig` identity from `ClientDefaults` runtime knobs); `withRetry`/`withRequestDeadline` retry + deadline machinery; `isClientError`/`isAbortError` helpers; process-wide `onUsage` hook. |
| `client-factory.ts` | `createLLMClient(config, defaults)` + registry; lazy-imports & registers built-in `anthropic`/`openai` clients on first use. |
| `providers/anthropic.ts` | `AnthropicClient` — Anthropic Messages API adapter (thinking budget, required max_tokens). |
| `providers/openai.ts` | `OpenAIClient` — OpenAI + all openai-compatible vendors (deepseek/groq/xai/zai/mistral/openrouter/ollama/…). |
| `model-pool.ts` | `ModelPool` runtime model registry: `get`/`switch`/`list`/`register`; `toLLMConfig`/`resolveLLMConfig` build `LLMConfig` from a `ModelEntry`; context-window backfill. |
| `provider-kinds.ts` | `ProviderKindName` enum + `PROVIDER_KINDS` metadata table + `getKindMeta`. |
| `provider-catalog.ts` | `ProviderCatalog` / `ProviderConfig` — per-provider credentials & base URL referenced by `ModelEntry.providerKey`. |
| `provider-auth.ts` | `resolveApiKey`/`resolveHeaders`/`resolveAuthCommand` — header & external-token-command resolution (cached). |
| `capabilities/index.ts` | `capabilitiesFor(kind, model)` → `Capability`; the single entry point to the capability layer. |
| `capabilities/rules.ts` | `RULES` — ordered per-(kind, model-regex) capability table (first match wins). |
| `capabilities/types.ts` | `Capability`, `ReasoningShape`, `ReasoningEffort`, etc.; `DEFAULT_CAPABILITY`. |
| `capabilities/reasoning-control.ts` | `reasoningControlFor` — derives the UI-facing reasoning control from a capability. |
| `capabilities/param-specs.ts` | `paramSpecsFromCapability` — projects a capability into model-catalog param specs. |
| `reasoning-setting.ts` | `ReasoningSetting` zod schema + `normalizeReasoning`; rich shape `{mode:"off"\|"on"\|"effort"\|"budget"}`. |
| `stream-watchdog.ts` | `createStreamWatchdog` idle timer (re-armed per chunk) + `STREAM_WATCHDOG_CONFIG` env defaults. |
| `token-counter.ts` | `countTokens(text)` — best-effort live token count (cl100k_base, lazy encoder). |
| `model-fetcher.ts` | `fetchModelList` — pull a provider's `/v1/models`. |
| `model-cache.ts` | `readCache`/`writeCache`/`isStale`/`defaultCacheDir` — on-disk model-list cache. |
| `clamp-max-tokens.ts` | `clampMaxTokens` — keep requested output under the model's cap. |
| `stop-reason.ts` | `isTruncatedStop` — detect a length-truncated finish. |
| `strip-vision.ts` | `stripVisionFromHistory` — drop image content for non-vision models. |
| `api-key-sanitize.ts` | `sanitizeApiKey` — strip junk/non-ASCII from pasted keys. |
| `retry.ts` | `isRetryable` — standalone retryable-error predicate. |

## 公开接口 / Public API

Re-exported from the core barrel (`packages/core/src/index.ts`); import from there or directly from `./llm/...`.

```ts
// Factory + base
function createLLMClient(config: LLMConfig, defaults?: ClientDefaults): Promise<LLMClientBase>;
function registerProvider(name: string, cls: new (c: LLMConfig, d?: ClientDefaults) => LLMClientBase): void;

abstract class LLMClientBase {
  readonly provider: string; readonly model: string; readonly maxTokens: number | undefined;
  abstract createMessage(options: CreateMessageOptions): Promise<LLMResponse>;
  getUsage(): LLMUsageTracker;
  static onUsage?: (model: string, usage: TokenUsage) => void; // process-wide cost funnel
}
class AnthropicClient extends LLMClientBase {}
class OpenAIClient extends LLMClientBase {}

interface CreateMessageOptions {
  systemPrompt: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number; maxTokens?: number;
  stream?: boolean; onChunk?: (chunk: LLMStreamChunk) => void;
  signal?: AbortSignal;
  recordUsage?: boolean;            // false = exclude from usage tracker + onUsage
  reasoning?: ReasoningSetting;     // overrides LLMConfig.reasoning for this call
}

// Model registry
class ModelPool {
  constructor(entries?: ModelEntry[], defaultKey?: string);
  get(key?: string): ModelEntry | undefined;       // no key = active
  switch(key: string): ModelEntry;                 // throws if missing
  register(entry: ModelEntry): void;
  list(): ModelEntry[];
  toLLMConfig(entry: ModelEntry): LLMConfig;
  resolveLLMConfig(key?: string): LLMConfig | undefined;
  reloadCachedContextWindows(): void;
  setProviderCatalog(cat: ProviderCatalog): void; setCacheDir(dir: string): void;
}

// Capability layer (pure)
function capabilitiesFor(kind: ProviderKindName, model: string): Capability;

// Helpers
function isAbortError(err: unknown): boolean;   // from client-base.ts (used by turn-loop)
function isClientError(err: unknown): boolean;  // 4xx detection (incl. buried .details.status)
function countTokens(text: string): number;     // live token estimate
function isTruncatedStop(stopReason?: string): boolean;
```

## 怎么用 / How to use

Resolve a config from the pool, build a client, send a message. Based on the arena cross-review phase (`arena/phases/cross-review.ts`) and `engine.ts`:

```ts
import { createLLMClient } from "../llm/client-factory.js";

const client = await createLLMClient(p.llm, p.clientDefaults);
let response = await client.createMessage({
  systemPrompt,
  messages: [{ role: "user", content: userContent }],
  signal,
});
if (response.stopReason === "length") {
  // truncated — re-ask with a shorter-output instruction
}
```

Driving it through the `ModelPool` (how the Engine picks the active or aux model — see `engine.ts`):

```ts
const pool = new ModelPool(entries, defaultKey);
pool.setProviderCatalog(catalog);
pool.setCacheDir(defaultCacheDir());
pool.reloadCachedContextWindows();          // backfill context windows

const entry = pool.get();                   // active model
const client = await createLLMClient(pool.toLLMConfig(entry), clientDefaults);

// request-shape rules for this exact (kind, model) — spread by the client internally,
// also read by the engine to decide e.g. vision support:
const cap = capabilitiesFor(entry.providerKind ?? "openai", entry.model);
```

## 注意 / Gotchas

- **`LLMConfig` (identity) vs `ClientDefaults` (runtime knobs) are deliberately split.** Identity = provider/model/apiKey/baseUrl/maxTokens/reasoning/providerKind. Runtime = temperature/timeout/retryMaxAttempts/imageDetail, owned by the Engine and stable across hot model switches. Don't fold one into the other — hot-swapping a model replaces the `LLMConfig` wholesale and must not leak the old model's runtime prefs (e.g. a 384k-output cap bleeding onto a 128k model).
- **No `?? 8192` max_tokens fallback.** When the output ceiling is unknown, `maxTokens` stays `undefined` so each provider decides (OpenAI omits the field; Anthropic supplies its own constant). Forcing 8192 silently truncated streamed tool-arg JSON → "Missing file_path".
- **Abort is signal-authoritative, not status-authoritative.** SDK `APIUserAbortError` carries no HTTP status, so `isClientError` can't see it — `withRetry` checks `isAbortError(err) || signal?.aborted` to bail immediately instead of retrying a cancelled request 3×. The turn-loop also re-checks the signal at the loop top.
- **`withRequestDeadline` exists because the SDK `timeout` does not reliably fire on a half-dead socket** (TCP up, no bytes) — observed hangs of 15–33 min. The deadline (≈ 2× timeout, min 120s) is composed with the caller's signal via `AbortSignal.any`. A deadline-fired tear-down is treated as *retryable* (upstream may have recovered); a user abort is not.
- **Stream watchdog is ON by default** (`stream-watchdog.ts`), opt out with `CODESHELL_ENABLE_STREAM_WATCHDOG=0`; idle window via `CODESHELL_STREAM_IDLE_TIMEOUT_MS` (default 90s). Call `reset()` after every chunk and `dispose()` in `finally`.
- **`isClientError` reads both `err.status` and `err.details.status`.** Providers wrap SDK errors as `new LLMError(msg, provider, { status })`, burying the code; missing the buried path silently retries a 400/401/404.
- **`capabilitiesFor` is a pure first-match-wins lookup over `RULES`** — order matters (specific before catch-all), and it returns a *fresh* `Capability` with a copied `rejectedParams` Set so callers can't mutate `DEFAULT_CAPABILITY`.
- **`countTokens` is best-effort and synchronous.** The encoder loads lazily; the very first chunk in a cold process falls back to `chars/4`. The authoritative count is always the provider's end-of-stream `usage`.
- **Only `anthropic` and `openai` clients exist.** Every other provider kind is openai- or anthropic-compatible; `ModelPool.toLLMConfig` collapses unknown kinds to `"openai"`. The original kind is carried through as `providerKind` so the capability layer still picks the right request-shape rules.
- **`LLMClientBase.onUsage` is a single process-wide static hook** installed once by the host (CLI `main.ts`) to feed the cost tracker; every code path reports through it. Pass `recordUsage: false` for auxiliary calls (tool-summary, etc.) that shouldn't skew session cost.
- **ESM:** core is ESM; intra-module imports use `.js` extensions even for `.ts` sources, and `client-factory` uses dynamic `import()` for providers. Changes here require a core rebuild before TUI/desktop dist consumers see them.
