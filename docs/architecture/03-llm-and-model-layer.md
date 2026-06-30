# 03 · LLM & Model Layer

> How a model "tag" becomes a configured provider client, and how per-provider quirks are tamed by data instead of `if` statements. Source-mapped against `packages/core/src/llm/`, `packages/core/src/model-catalog/`, and the resolution glue in `packages/core/src/engine/`.

## 1. Two concerns, kept separate

The layer separates **model identity** (`LLMConfig` — provider/model/apiKey/baseUrl/maxTokens) from **runtime knobs** (`ClientDefaults` — temperature/timeout/retryMaxAttempts/imageDetail). Hot model switching swaps the `LLMConfig` wholesale without disturbing `ClientDefaults`, so e.g. a 1 M-context model's output cap can't bleed into a 128 K one.

| File | Role | ~LOC |
|------|------|------|
| `llm/client-base.ts` | `LLMClientBase` abstract class + retry/deadline logic | ~313 |
| `llm/client-factory.ts` | `createLLMClient` / `registerProvider` — provider registry, lazy-loaded | ~46 |
| `llm/providers/anthropic.ts` | `@anthropic-ai/sdk` wrapper; thinking-budget builder | ~600 |
| `llm/providers/openai.ts` | OpenAI-compatible client (covers DeepSeek, OpenRouter, Z.AI, xAI, Mistral, Groq, Gemini-compat, Ollama, custom) + stream watchdog | ~900 |
| `llm/capabilities/` | `capabilitiesFor`, the per-model `RULES`, reasoning-control projection | ~620 |
| `llm/model-pool.ts` | `ModelPool` / `ModelEntry` — runtime registry, context-window resolution | ~314 |
| `llm/provider-catalog.ts`, `provider-kinds.ts` | Credential store + per-family endpoint/auth metadata | ~244 |
| `model-catalog/` | `BUILTIN_CATALOG` + user catalog, `CatalogEntry`, `ParamSpec`, resolution | ~700 |
| `engine/resolve-llm-config.ts`, `model-connections-pool.ts`, `aux-key.ts` | tag → concrete model + creds; aux model resolution | ~230 |

## 2. The resolution flow

A chat turn needs an `LLMConfig`. It is built like this:

```
settings.modelConnections[] + settings.credentials[] + merged catalog
        │  modelEntriesFromConnections()          model-connections-pool.ts
        ▼
ModelEntry[]  ──register──▶  ModelPool
        │  pool.toLLMConfig(entry)                model-pool.ts
        ▼
LLMConfig  ──createLLMClient()──▶  AnthropicClient | OpenAIClient
        │  client.createMessage({system, messages, tools, reasoning})
        ▼
capabilitiesFor(providerKind, model)  shapes the wire request
```

For non-engine callers there's a single entry point: `resolveLLMConfigForTag(settings, "text", preferredId?)` (`engine/resolve-llm-config.ts`) picks by precedence `preferredInstanceId > defaults[tag] > first available`, validates that a key exists if `needsKey`, and returns `null` (not a throwing error) when no usable connection exists — so the caller surfaces a clear "no model configured" message.

The **catalog is the single source of truth** after the legacy `model.*/models[]/providers[]` storage was removed (see the memory note on legacy-model-storage removal). `getMergedCatalog()` overlays the user catalog (`~/.code-shell/model-catalog.user.json`) onto `BUILTIN_CATALOG`, with the user winning on `id` collision.

## 3. Capabilities: divergence as data, not code

Every provider/model quirk lives in `llm/capabilities/rules.ts` — a list of `(providerKind, modelFamily) → Capability` rules, first match per kind wins. A `Capability` declares:
- `supportsVision`, `tokenLimitField` (`max_tokens` vs `max_completion_tokens`)
- `rejectedParams` (a fresh `Set` — never the `DEFAULT` reference, so client mutation can't poison the default; see the memory note on the capabilities shallow-spread footgun)
- `reasoning` shape (`none` / `deepseek-thinking` / `openai-effort` / `anthropic-budget` / `anthropic-adaptive` / `openrouter-reasoning`)
- `echoReasoning`, `parallelToolCalls`, `streamUsage`, `maxOutputTokens`

A few rules that matter in practice (audited against vendor docs):
- **gpt-5.5+**: `max_completion_tokens`, rejects `temperature`/`top_p`/penalties, effort levels `low/medium/high/xhigh` (no `minimal`), `maxOutputTokens: 128000`, and crucially `noEffortWithTools: true` — the client omits `reasoning_effort` up-front on tool-bearing requests because gpt-5.5 returns 400 otherwise (the per-turn-400 bug; see the memory note on gpt5.5 effort).
- **claude-4.6+**: `anthropic-adaptive` (thinking is automatic, no budget param). **claude-4.0–4.5**: `anthropic-budget` (explicit `budget_tokens`, clamped `< max_tokens`).
- **deepseek-v4 / Z.AI GLM**: `deepseek-thinking` (top-level `thinking.type`). DeepSeek-v4 must echo `reasoning_content` when tools are present; deepseek-reasoner rejects it.

The clients themselves contain **no** per-model `switch` statements — they read the `Capability` and shape the request accordingly. `reasoningControlFor(kind, model)` projects the same `reasoning` shape into a UI control descriptor (toggle / effort-enum / budget-number / adaptive), so the connection UI and the wire request stay in sync from one source.

## 4. The catalog and `ParamSpec`

A `CatalogEntry` (`model-catalog/types.ts`) describes one provider template: `id`, `tag` (`text`/`image`/`video`/`audio`), `adapterKind`, `defaultBaseUrl`, `modelPresets[]`, and `paramsDoc`. Each `ModelPreset` can carry `params: ParamSpec[]`.

A `ParamSpec` is the keystone abstraction — one declaration drives **both** the UI control and the wire mapping:
```ts
{ name: "reasoning", control: "enum", options: ["low","medium","high"],
  doc: "Reasoning effort…", wire: { field: "reasoning_effort" } }
```
`applyParams(values, params)` maps `values` onto a nested request body via `wire.field` (e.g. `"thinking.budget_tokens"` → `{thinking:{budget_tokens:N}}`) and feeds the catalog-declared `temperature`/`top_p`/`max_tokens`/`thinking` into `extraBody` (the memory note on model-params-downfeed confirms these reach the wire). `buildParamsDoc(params)` renders the same specs into the tool description so the model knows the knobs it has. `reasoningFromParamValues` translates a stored param value into a `ReasoningSetting` (`string → effort`, `number → budget`, `boolean → on/off`).

## 5. Streaming, retries, usage

- **Retry + deadline** (`client-base.ts`): `withRetry` composes the caller's `AbortSignal` with a per-request hard deadline (≈2× SDK timeout, min 120 s) to tear down half-dead sockets. Retries 5xx + rate-limits, **not** deterministic 4xx (saves the retry wait on a bad request — the memory note on LLM retry/maxTokens bugs records the fix where a 4xx-retry guard was once punched through by status burial).
- **Stream idle watchdog** (`stream-watchdog.ts`, `STREAM_WATCHDOG_CONFIG`): opt-in; aborts a stream idle for `idleTimeoutMs` (default 90 s) and retries via `withRetry`. `onChunk` is invoked *after* the abort check, so buffered post-Stop chunks never leak to the UI.
- **Usage & cost**: `LLMClientBase.onUsage` is a static hook fired on every response; the TUI/desktop hosts install it to feed `CostTracker`, which prices via the OpenRouter snapshot → static table → conservative fallback. `TokenUsage` carries `cacheReadTokens`/`cacheCreationTokens` (the memory note on prompt-cache gaps tracks where cached-token accounting was reading the wrong field).
- **No `maxTokens` fallback at construction**: left undefined so each provider applies its own default rather than silently truncating at a hardcoded value.

## 6. Model metadata & sync

- `model-fetcher.ts` fetches a provider's `/models`, normalizes the divergent shapes (OpenAI/Anthropic/Ollama/Gemini), filters out non-chat models via `provider-kinds.ts` `chatFilter`, and enriches from the static catalog + the bundled OpenRouter snapshot. Results cache to `~/.code-shell/cache/models/<providerKey>.json` (7-day TTL).
- `data/openrouter-sync.ts` (`syncOpenRouterCatalog`) refreshes the OpenRouter catalog at runtime (`/sync-models` command); to persist it into the bundle, the build runs `scripts/sync-models.ts` first (the build depends on it — see the CODESHELL.md note).
- `api-key-sanitize.ts` defensively strips bracketed-paste wrappers, zero-width chars, smart quotes, and CJK full-width spaces from pasted keys.

`provider-kinds.ts` is the metadata table for known families (`openai`, `anthropic`, `deepseek`, `zai`, `xai`, `mistral`, `groq`, `google`, `openrouter`, `ollama`, `custom`) — default base URL, models path, auth header/query, and chat filter. Gemini support here is the AI-Studio (`AIza…`) flavor over the OpenAI-compat endpoint; Vertex OAuth tokens are not supported (the memory note on legacy-model-storage removal records a user 400 traced to a Vertex `AQ.` token).

## 7. Where to read next
- How the client is wrapped and called per turn: [01 · Engine & turn loop](01-engine-and-turn-loop.md) (`ModelFacade`)
- The aux model used for titles, the goal judge, and Dream: [01](01-engine-and-turn-loop.md), [07](07-plugins-capabilities-credentials-memory.md)
- Image/video providers (separate from text): [08 · Arena & integrations](08-arena-and-integrations.md) and the `GenerateImage`/`GenerateVideo` tools in [02](02-tool-system.md)
