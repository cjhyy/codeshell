# CODESHELL.md

Guidance for AI assistants (Code Shell, Claude Code, Codex) working in this repository.
`CODESHELL.md` is the primary instruction file; `CLAUDE.md` and `AGENTS.md` are also read as compat aliases (see `packages/core/src/settings/schema.ts`).

## What this repo is

**CodeShell** — a general-purpose AI Agent orchestration framework. The engine is domain-agnostic; "coding" is expressed as a preset, not hardcoded. Design principles: (1) Core First (engine decoupled from domain), (2) Presets over Hardcoding, (3) Secure by Default (permission-gated tools), (4) Long-running Ready (Task/Cron/Sleep/Sub-Agent are first-class).

## Monorepo layout (4 packages)

```
packages/
  core/     @cjhyy/code-shell-core     — engine, tools, hooks, protocol. UI-agnostic.
  tui/      @cjhyy/code-shell-tui      — Ink-based terminal REPL on top of core.
  desktop/  @cjhyy/code-shell-desktop  — Electron client (private, not published).
  cdp/      @cjhyy/code-shell-cdp      — env-agnostic CDP browser action layer (no Playwright).
```
Root package `@cjhyy/code-shell` is the meta package that installs core + tui and exposes the `code-shell` bin.

## Build & Test

```bash
bun install            # bun workspaces (NOT npm/yarn/pnpm)
bun run build          # filter order: core → tui → build-meta.ts (desktop/cdp built separately)
bun run dev            # = dev:desktop (launches the Electron app)
bun run dev:tui        # CODE_SHELL_DEV=1 CODESHELL_UI_PERF=1 packages/tui/src/cli/main.ts
bun test               # bun test runner (NOT vitest/jest)
bun test -- -t 'name'  # run tests matching a pattern
bun run typecheck      # tsc --noEmit at root (desktop has its own; see packages/desktop)
bun run lint           # eslint packages/
bun run lint:engine-bypass  # guard: every internal `new Engine(` must be allowlisted
bun run format         # prettier --write 'packages/**/*.ts'
bun run bench:render   # render benchmarks (tail / streaming / spinner / wheel)
```

## Code Style

- **Prettier**: double quotes, semicolons always, trailing commas (`all`), 2-space indent, 100 print width.
- **ESLint**: unused vars must be prefixed with `_`; `no-explicit-any` is off; `ts-expect-error` needs a ≥3-char description.
- **tsconfig**: `strict: true` but `noImplicitAny: false` — implicit `any` is tolerated.
- **`@/*` path alias** maps to `src/*` in each package (tsconfig paths + tsup).

## Architecture Gotchas

- **Package manager is `bun`**, not npm/yarn/pnpm. `preinstall` enforces Node >= 20.10 via `scripts/check-node.cjs`.
- **React is pinned to 19.2.6** via root `overrides` — do not upgrade casually.
- **Terminal UI is Ink** (React for CLI). `packages/tui/src/ui/**.tsx` are Ink React components, NOT browser DOM.
- **Core is `packages/core/`** (package name `@cjhyy/code-shell-core`). There is no `src/core` directory.
- **Typecheck is not a clean gate**: `bun run typecheck` reports pre-existing errors across the repo. Don't treat it as a blocker for your changes.
- **Two hard ESLint guardrails** (in `eslint.config.js`):
  - `packages/core/**` MUST NOT import `@cjhyy/code-shell-tui` (core is UI-agnostic).
  - `packages/desktop/src/renderer/**` MUST NOT runtime-import any codeshell package — talk to main via `window.codeShell.*`. Type-only imports are allowed and used to share `StreamEvent`/`TaskInfo` shapes.
- **Custom ESLint rules are stubbed** (`no-sync-fs`, `no-top-level-side-effects`, `no-top-level-dynamic-import`, `no-process-exit`, `no-process-cwd`, `no-process-env-top-level`) — they declare intent but don't actually lint. Follow them by convention.
- **`sync-models.ts` exists** at `scripts/sync-models.ts` but is NOT run automatically by `bun run build`. Run it manually to refresh OpenRouter model data (`bun run scripts/sync-models.ts`).
- **Markdown rendering stacks differ**: Desktop uses `react-markdown + remark-gfm + rehype-highlight` (streaming phase uses plain/pre without live parse); TUI uses `marked + marked-terminal`. Don't assume they render identically.
- **MCP servers may be project-scoped**: `SettingsManager` defaults to `project` scope and reads `${cwd}/.code-shell/settings.json` + `.local.json`. It does NOT read `~/.code-shell/settings.json` unless explicitly configured. Local-first is the intended pattern.
- **Plugin env-var rewrite is deliberate**: `packages/core/src/plugins/varRewrite.ts` rewrites `CLAUDE_PLUGIN_ROOT` → `CODESHELL_PLUGIN_ROOT` in plugin files at install time. This prevents plugins from detecting CC at runtime and emitting CC-specific output. Do NOT change this to dual-set env vars at runtime.

## Where to put things

- **Roadmap TODOs** → root `TODO.md` (has P0-P7 priority sections). There is no `todo/` directory for roadmap items. `TODO-week.md` is for the current week's plan.
- **In-progress design drafts** → `docs/todo/*.md` (e.g. `desktop-streaming-markdown-autoscroll-plan.md`).
- **Test files** → `tests/` and `packages/*/src/**/*.test.ts`.
- **Prompt sections** → `packages/core/src/prompt/sections/*.md` (copied to `dist/prompt/sections/` at build via `scripts/copy-assets.mjs`).

## Known Architecture Debt (context only, not asks)

- **`core → tool-system → engine` import cycle** must be broken before splitting `engine.ts` (3301 lines). Extract common types like `EngineConfig` into separate type files first.
- **Arena is entangled in core** via `tool-system/builtin/arena.ts`, `protocol/server.ts`, `settings/schema.ts`, `onboarding.ts`, `index.ts`. Three-step extraction plan: (a) move `extractJSON` → `utils/json.ts`, (b) make arena a selectable/optional builtin, (c) move to `packages/arena` or a product package.
- **Plugin SessionStart hooks are not wired** into session bootstrap → plugin-provided skills don't auto-load on session start.

## Commit Style

Conventional commits: `feat:`, `fix:`, `style:`, `refactor:`, `test:`, `chore:`, `docs:`, optional scope in parens (e.g. `feat(desktop): ...`, `feat(ui): ...`, `feat(goal): ...`).
