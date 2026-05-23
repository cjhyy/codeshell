# CodeShell Architecture Docs

> Originally generated on 2026-05-16; entry points refreshed after the 2026-05-22 monorepo split.

This directory is the current architecture documentation set for CodeShell. It is organized as a reading path rather than one giant document, so each file can stay focused and easier to update when a subsystem moves.

## Reading Order

| # | Document | Use it for |
|---|---|---|
| 0 | [Current Repo Map and Decoupling Review](../repo-map-and-decoupling-review-2026-05-23.md) | Current `packages/*` layout, package-boundary review, coupling hotspots, and next-step plan after the monorepo split |
| 1 | [System Overview](01-system-overview.md) | Product positioning, top-level layers, and the main architecture diagram |
| 2 | [Runtime Flow](02-runtime-flow.md) | How CLI/headless/REPL requests become Engine turns and tool calls |
| 3 | [Module Map](03-module-map.md) | Historical module ownership map; use document 0 for the current `packages/*` split |
| 4 | [Tool System](04-tool-system.md) | Tool registration, execution, permission checks, MCP, guards, and concurrency |
| 5 | [State, Config, and Storage](05-state-config-storage.md) | Settings merge order, sessions, transcripts, runs, logs, memories, and context persistence |
| 6 | [UI, Protocol, and Rendering](06-ui-protocol-rendering.md) | Client/server protocol, custom terminal renderer, REPL app state, commands, approvals |
| 7 | [LLM and Model Layer](07-llm-model-layer.md) | Provider clients, model pool, provider catalog, capability rules, streaming, usage |
| 8 | [Extension Points](08-extension-points.md) | Presets, products, hooks, skills, MCP, custom tools, Arena, RunManager |
| 9 | [Build, Test, and Operations](09-build-test-ops.md) | Build pipeline, package exports, test coverage, logging, sandboxing, operational notes |
| 10 | [Architecture Diagrams](10-architecture-diagrams.md) | Overview and module detail SVG diagrams |
| 11 | [TUI Render Capability Plan](11-render-tui-capability-plan.md) | What the custom TUI renderer must support and what is still missing |
| 12 | [mac Visual Client Research](12-mac-visual-client-research.md) | Electron/Tauri/SwiftUI options, Codex desktop evidence, and recommended mac client architecture |
| 13 | [LLM/UI Decoupling](../superpowers/specs/2026-05-17-llm-ui-decoupling-design.md) | Four-layer architecture borrowed from Claude Code: stream-idle watchdog, QueryGuard sync state machine, partial-text preservation on Esc, and background-agent dock. Implementation [plan](../superpowers/plans/2026-05-17-llm-ui-decoupling.md). |
| 14 | [Engine Call Paths (ADR)](14-engine-call-paths.md) | Why every internal `engine.run` goes through `AgentServer + AgentClient`. Allowlist, enforcement, sub-agent exception. Phase 1 of the LLM/UI decoupling roadmap. |

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
- Core public API: [`packages/core/src/index.ts`](../../packages/core/src/index.ts)
- TUI package entry: [`packages/tui/src/index.ts`](../../packages/tui/src/index.ts)
- CLI entry: [`packages/tui/src/cli/main.ts`](../../packages/tui/src/cli/main.ts)
- Engine facade: [`packages/core/src/engine/engine.ts`](../../packages/core/src/engine/engine.ts)
- Turn loop: [`packages/core/src/engine/turn-loop.ts`](../../packages/core/src/engine/turn-loop.ts)
- Tool registry/executor: [`packages/core/src/tool-system/registry.ts`](../../packages/core/src/tool-system/registry.ts), [`packages/core/src/tool-system/executor.ts`](../../packages/core/src/tool-system/executor.ts)
- Protocol layer: [`packages/core/src/protocol/types.ts`](../../packages/core/src/protocol/types.ts)
- REPL app: [`packages/tui/src/ui/App.tsx`](../../packages/tui/src/ui/App.tsx)
- Terminal renderer: [`packages/tui/src/render/README.md`](../../packages/tui/src/render/README.md), [`packages/tui/src/render/index.ts`](../../packages/tui/src/render/index.ts)
- Model pool: [`packages/core/src/llm/model-pool.ts`](../../packages/core/src/llm/model-pool.ts)
- Run lifecycle: [`packages/core/src/run/RunManager.ts`](../../packages/core/src/run/RunManager.ts)
- Arena: [`packages/core/src/arena/arena.ts`](../../packages/core/src/arena/arena.ts)

## Notes

Older docs in [`docs/`](../) are still useful as history and design background. Some architecture pages were written before the 2026-05-22 monorepo split and still use old `src/...` anchors; use the current repo map above as the package-aligned entry point for `packages/core`, `packages/tui`, and `packages/desktop`.
