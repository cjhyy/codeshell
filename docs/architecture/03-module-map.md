# Module Map

This is the practical map of `src/`. It focuses on ownership boundaries rather than every file.

## Core Runtime

| Path | Owns | Key files |
|---|---|---|
| [`src/engine`](../../src/engine) | Engine facade, turn state machine, model facade, streaming tool queue, token budget, query API | `engine.ts`, `turn-loop.ts`, `model-facade.ts`, `streaming-tool-queue.ts`, `query.ts` |
| [`src/tool-system`](../../src/tool-system) | Tool registry/executor, permissions, validation, MCP, sandbox, built-in tools, guards | `registry.ts`, `executor.ts`, `permission.ts`, `context.ts`, `mcp-manager.ts`, `builtin/` |
| [`src/context`](../../src/context) | Context compaction, token estimation, tool-result persistence | `manager.ts`, `compaction.ts`, `tool-result-storage.ts` |
| [`src/session`](../../src/session) | Session lifecycle, transcript JSONL, file history snapshots, memory store | `session-manager.ts`, `transcript.ts`, `file-history.ts`, `memory.ts` |
| [`src/settings`](../../src/settings) | Multi-source settings merge and Zod schema | `manager.ts`, `schema.ts` |
| [`src/preset`](../../src/preset) | Built-in and registered agent presets | `index.ts` |
| [`src/prompt`](../../src/prompt) | Prompt section loading, prompt caching, instruction scanning | `composer.ts`, `section-loader.ts`, `instruction-scanner.ts`, `sections/` |

## Interaction

| Path | Owns | Key files |
|---|---|---|
| [`src/cli`](../../src/cli) | CLI entry, commands, onboarding, output renderers, model migration, cost tracking | `main.ts`, `commands/run.ts`, `commands/repl.ts`, `commands/registry.ts` |
| [`src/protocol`](../../src/protocol) | JSON-RPC-style client/server boundary and transports | `types.ts`, `server.ts`, `client.ts`, `transport.ts` |
| [`src/ui`](../../src/ui) | Interactive terminal app, model manager, approval UI, chat state, slash commands integration | `App.tsx`, `store.ts`, `components/` |
| [`src/render`](../../src/render) | Custom Ink-like terminal renderer, layout, terminal IO, reconciliation, focus/events | `index.ts`, `root.ts`, `reconciler.ts`, `components/`, `events/`, `layout/`, `termio/` |

## Model and Data

| Path | Owns | Key files |
|---|---|---|
| [`src/llm`](../../src/llm) | Provider factory, OpenAI-compatible and Anthropic clients, model pool, provider catalog, capability rules, token counter | `client-factory.ts`, `providers/`, `model-pool.ts`, `provider-catalog.ts`, `capabilities/` |
| [`src/data`](../../src/data) | Static and synced model catalogs | `static-catalogs.ts`, `openrouter-sync.ts`, JSON catalogs |

## Long-Running Work and Productization

| Path | Owns | Key files |
|---|---|---|
| [`src/run`](../../src/run) | Managed run snapshots, queue, state transitions, checkpoints, approvals, artifacts, heartbeat/lock | `RunManager.ts`, `EngineRunner.ts`, `FileRunStore.ts`, `types.ts` |
| [`src/product`](../../src/product) | External product adapter API | `define.ts`, `types.ts` |
| [`src/arena`](../../src/arena) | Multi-model review/discussion/planning and iterative authoring | `arena.ts`, `planner.ts`, `iterate/`, `phases/`, `providers/`, `strategies/` |

## Integrations and Helpers

| Path | Owns |
|---|---|
| [`src/hooks`](../../src/hooks) | Hook event definitions and registry |
| [`src/skills`](../../src/skills) | Local skill scanning, matching, prompt listing |
| [`src/lsp`](../../src/lsp) | Language-server client/manager helpers |
| [`src/git`](../../src/git) | Git/worktree helpers |
| [`src/cron`](../../src/cron) | Scheduler support used by cron tools |
| [`src/remote`](../../src/remote) | Remote bridge support |
| [`src/services`](../../src/services) | Memory extraction, session memory, auto-dream, analytics, diagnostics, notifier, OAuth |
| [`src/logging`](../../src/logging) | JSONL logging and session recorder |
| [`src/utils`](../../src/utils) | Formatting, environment, shell helpers, ANSI/text utilities |
| [`src/native-ts`](../../src/native-ts) | Native TypeScript shim/vendor code, currently including yoga-layout types |
| [`src/voice`](../../src/voice) | Reserved voice entry point |
| [`src/plugins`](../../src/plugins) | Plugin loader/types, currently a thin extension surface |

## Package Entrypoints

The build exports are declared in [`package.json`](../../package.json) and bundled by [`tsup.config.ts`](../../tsup.config.ts):

- root: `src/index.ts`
- CLI binary: `src/cli/main.ts`
- run subpath: `src/run/index.ts`
- arena subpath: `src/arena/index.ts`
- product subpath: `src/product/index.ts`

## Dependency Direction

The healthy direction is:

```text
cli/ui/protocol
  -> engine
    -> prompt/preset/context/session/settings/llm/tool-system
      -> utilities

run/product/arena
  -> engine and llm/tool abstractions
```

Avoid making lower layers depend on UI or CLI details. The main exception is intentionally isolated adapters such as `RunApprovalBackend` or protocol command handlers.

## Where To Start Reading

- To debug a normal chat run: `src/cli/commands/repl.ts` -> `src/protocol/server.ts` -> `src/engine/engine.ts` -> `src/engine/turn-loop.ts`.
- To debug a tool call: `src/engine/turn-loop.ts` -> `src/tool-system/executor.ts` -> `src/tool-system/registry.ts` -> `src/tool-system/builtin/<tool>.ts`.
- To debug model issues: `src/llm/model-pool.ts` -> `src/llm/client-factory.ts` -> `src/llm/providers/openai.ts` or `anthropic.ts` -> `src/llm/capabilities/`.
- To debug UI rendering: `src/ui/App.tsx` -> `src/ui/store.ts` -> `src/render/root.ts`.
- To debug persistent runs: `src/run/RunManager.ts` -> `src/run/EngineRunner.ts` -> `src/run/FileRunStore.ts`.
