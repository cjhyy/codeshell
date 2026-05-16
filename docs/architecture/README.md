# CodeShell Architecture Docs

> Generated on 2026-05-15 from the current repository tree.

This directory is the current architecture documentation set for CodeShell. It is organized as a reading path rather than one giant document, so each file can stay focused and easier to update when a subsystem moves.

## Reading Order

| # | Document | Use it for |
|---|---|---|
| 1 | [System Overview](01-system-overview.md) | Product positioning, top-level layers, and the main architecture diagram |
| 2 | [Runtime Flow](02-runtime-flow.md) | How CLI/headless/REPL requests become Engine turns and tool calls |
| 3 | [Module Map](03-module-map.md) | What every important `src/` directory owns |
| 4 | [Tool System](04-tool-system.md) | Tool registration, execution, permission checks, MCP, guards, and concurrency |
| 5 | [State, Config, and Storage](05-state-config-storage.md) | Settings merge order, sessions, transcripts, runs, logs, memories, and context persistence |
| 6 | [UI, Protocol, and Rendering](06-ui-protocol-rendering.md) | Client/server protocol, custom terminal renderer, REPL app state, commands, approvals |
| 7 | [LLM and Model Layer](07-llm-model-layer.md) | Provider clients, model pool, provider catalog, capability rules, streaming, usage |
| 8 | [Extension Points](08-extension-points.md) | Presets, products, hooks, skills, MCP, custom tools, Arena, RunManager |
| 9 | [Build, Test, and Operations](09-build-test-ops.md) | Build pipeline, package exports, test coverage, logging, sandboxing, operational notes |
| 10 | [Architecture Diagrams](10-architecture-diagrams.md) | Overview and module detail SVG diagrams |

## One-Screen Summary

CodeShell is best understood as:

```text
general-purpose agent orchestration core
  + terminal-coding preset and terminal UI
  + managed run lifecycle APIs
  + multi-model Arena analysis
  + product adapter layer for external agent products
```

The current source tree supports two primary usage modes:

- CLI product: `code-shell`, defaulting to the `terminal-coding` preset.
- Library/framework: exported `Engine`, `RunManager`, `Arena`, `IterativeArena`, and `defineProduct()` APIs.

## Primary Source Anchors

- Package shape: [`package.json`](../../package.json)
- Public API: [`src/index.ts`](../../src/index.ts)
- CLI entry: [`src/cli/main.ts`](../../src/cli/main.ts)
- Engine facade: [`src/engine/engine.ts`](../../src/engine/engine.ts)
- Turn loop: [`src/engine/turn-loop.ts`](../../src/engine/turn-loop.ts)
- Tool registry/executor: [`src/tool-system/registry.ts`](../../src/tool-system/registry.ts), [`src/tool-system/executor.ts`](../../src/tool-system/executor.ts)
- Protocol layer: [`src/protocol/types.ts`](../../src/protocol/types.ts)
- REPL app: [`src/ui/App.tsx`](../../src/ui/App.tsx)
- Model pool: [`src/llm/model-pool.ts`](../../src/llm/model-pool.ts)
- Run lifecycle: [`src/run/RunManager.ts`](../../src/run/RunManager.ts)
- Arena: [`src/arena/arena.ts`](../../src/arena/arena.ts)

## Notes

Older docs in [`docs/`](../) are still useful as history and design background, but this directory is intended to be the fresh, source-aligned architecture map for the current tree.
