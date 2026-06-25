# LLM and Model Layer

## Provider Factory

[`createLLMClient()`](../../src/llm/client-factory.ts) resolves `LLMConfig.provider` into a client class:

- `openai` -> [`OpenAIClient`](../../src/llm/providers/openai.ts)
- `anthropic` -> [`AnthropicClient`](../../src/llm/providers/anthropic.ts)

Additional providers can be registered through `registerProvider()`, but most vendors are handled through the OpenAI-compatible client with provider-specific capability rules.

## OpenAI-Compatible Client

[`OpenAIClient`](../../src/llm/providers/openai.ts) serves OpenAI and OpenAI-compatible endpoints, including DeepSeek, OpenRouter, Z.AI, xAI, Mistral, Groq, Gemini OpenAI-compat, Ollama, and custom endpoints.

It normalizes:

- token-limit field: `max_tokens` vs `max_completion_tokens`;
- sampling parameters that some reasoning models reject;
- reasoning/thinking request shape;
- streaming usage chunks;
- tool-call delta assembly;
- DeepSeek-style `reasoning_content` echo behavior;
- context/rate-limit error mapping.

Request-shape decisions come from [`src/llm/capabilities`](../../src/llm/capabilities), not from scattered provider conditionals.

## Anthropic Client

[`AnthropicClient`](../../src/llm/providers/anthropic.ts) uses `@anthropic-ai/sdk` and maps CodeShell messages/tools into Anthropic message blocks.

It supports:

- streaming text and tool-use events;
- usage recording, including cache read/creation tokens when provided;
- tool block conversion;
- context/rate-limit error mapping.

## ModelFacade

[`ModelFacade`](../../src/engine/model-facade.ts) wraps a concrete LLM client for the turn loop.

Responsibilities:

- send model calls with system prompt, messages, tools, stream callback, and abort signal;
- provide non-streaming fallback;
- record usage and latency;
- support lightweight summarization calls for context compaction and memory work;
- expose output-token accounting for token-budget logic.

## ModelPool and ProviderCatalog

[`ModelPool`](../../src/llm/model-pool.ts) is the runtime registry of model entries.

It provides:

- `register(entry)`;
- `switch(key)`;
- `get(key?)`;
- `list()`;
- `toLLMConfig(entry, base)`;
- cached context-window patching.

[`ProviderCatalog`](../../src/llm/provider-catalog.ts) stores provider credentials/endpoints. Model entries can reference providers by `providerKey`, so API keys and base URLs do not have to be repeated on every model.

Resolution priority for `ModelPool.toLLMConfig()`:

```text
model entry override
  -> provider catalog value
  -> base LLMConfig fallback
```

Thinking mode precedence:

```text
model entry thinking
  -> provider thinking
  -> base config thinking
```

## Settings Model

The current config shape has:

- `activeKey`: primary active model pointer;
- `providers[]`: credentials/endpoints by key;
- `models[]`: named model entries;
- `model`: legacy mirror used by older boot paths.

REPL and headless commands bootstrap from settings, then `Engine.populateModelPoolFromSettings()` re-resolves the active model and updates `config.llm`.

## Model Discovery and Cache

Relevant files:

- [`model-fetcher.ts`](../../src/llm/model-fetcher.ts)
- [`model-cache.ts`](../../src/llm/model-cache.ts)
- [`provider-kinds.ts`](../../src/llm/provider-kinds.ts)
- [`data/static-catalogs.ts`](../../src/data/static-catalogs.ts)
- [`scripts/sync-models.ts`](../../scripts/sync-models.ts)

The build script runs `sync-models` before bundling so shipped model metadata is fresh enough for packaged use.

## Streaming Contract

Provider clients emit `LLMStreamChunk` values:

- text deltas;
- tool-use start;
- tool-use args deltas;
- stop events.

`ModelFacade` translates these into Engine `StreamEvent` values consumed by UI/headless renderers.

## Arena Participants

Arena resolves participant strings in this order:

1. model pool key;
2. built-in Arena model preset;
3. raw model path.

Source: [`src/tool-system/builtin/arena.ts`](../../src/tool-system/builtin/arena.ts).

Model-pool entries are preferred because they carry their own provider credentials. This avoids accidentally running an Arena participant through the active session endpoint when that endpoint cannot serve the participant model.

## Cost and Usage

Cost tracking is installed globally in [`src/cli/main.ts`](../../src/cli/main.ts) through [`src/cli/cost-tracker.ts`](../../src/cli/cost-tracker.ts). Engine can persist cost state through the optional `CostStateStore`.

Usage is also used by:

- context bar updates in UI;
- context manager hybrid token estimation;
- final session state.

## Extension Notes

When adding provider support:

1. Prefer `providerKind` + capability rules if the endpoint is OpenAI-compatible.
2. Use a new client only if the wire protocol is fundamentally different.
3. Add schema support in `settings/schema.ts`.
4. Add provider-kind/capability tests.
5. Ensure model-pool resolution carries base URL, API key, max output tokens, context tokens, and thinking defaults.
