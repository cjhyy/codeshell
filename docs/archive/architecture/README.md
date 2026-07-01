# CodeShell Architecture Docs

> Originally generated on 2026-05-16; entry points refreshed after the 2026-05-22 monorepo split. Current review refreshed on 2026-05-25.

This directory is the current architecture documentation set for CodeShell. It is organized as a reading path rather than one giant document, so each file can stay focused and easier to update when a subsystem moves.

## Reading Order

| # | Document | Use it for |
|---|---|---|
| 0 | [Current Repo Map and Decoupling Review](../archive/repo-map-and-decoupling-review-2026-05-23.md) | Current `packages/*` layout, package-boundary review, coupling hotspots, and next-step plan after the monorepo split |
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
| 15 | [Current Review and Bug Inventory](15-current-review-and-bug-inventory.md) | 2026-05-25 repo-wide architecture review, confirmed drift from docs, and prioritized bug/risk list. |
| 16 | [Core Overall Design Standard](16-core-overall-design-standard.md) | Target standard for stabilizing `@cjhyy/code-shell-core`: host boundary, protocol, runtime/session ownership, safety gates, public API, and business adoption definition of done. |
| 17 | [Plugin/Shell Hook Trust Model](17-plugin-shell-hook-trust-model.md) | Why user-installed plugin/settings shell hooks are trusted code that bypasses the Bash permission/sandbox path, and the timeout + fail-silent guardrails. |
| 18 | [Core vs CC vs Codex](18-core-vs-cc-vs-codex.md) | **Latest tri-party comparison baseline (2026-05-27).** Per-module compare of `packages/core` against Claude Code and Codex (codex-rs), with verified file:line anchors, drift notes, and prioritized improvements. Use as the package-aligned source-of-truth when other pages disagree. |

## One-Screen Summary

CodeShell is best understood as:

```text
general-purpose agent orchestration core
  + terminal-coding preset and terminal UI
  + managed run lifecycle APIs
  + multi-model Arena analysis
  + product adapter layer for external agent products
```

The current source tree supports three primary usage modes:

- CLI product: `code-shell`, defaulting to the `terminal-coding` preset.
- Library/framework: exported `Engine`, `RunManager`, `Arena`, `IterativeArena`, and `defineProduct()` APIs.
- Electron desktop client: `packages/desktop` thin renderer + Electron main broker + stdio `AgentServer` worker.

Current caveat: the public `@cjhyy/code-shell-core` export surface still includes migration/internal TUI support APIs, not only stable SDK APIs. Treat `packages/core/src/index.ts` as a broad compatibility surface until it is split into stable/experimental/internal subpaths.

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

> **Desktop app coverage (2026-06-25):** this reading-order set predates the desktop app becoming the headline product, so it has no dedicated `packages/desktop` chapter yet — #12 is a pre-decision *research* doc, not the as-built architecture. For the current desktop main/renderer/IPC surface (per-session agent worker, `window.codeshell.*` bridge, panels, browser-automation host, mobile remote), the authoritative inventory is [`../../architecture/feature-inventory.md`](../../architecture/feature-inventory.md) (149 capabilities across desktop main / renderer / TUI). A dedicated desktop architecture chapter is a known doc gap.
