# CODESHELL.md

This file provides guidance to Code Shell when working with code in this repository.

## Build & Test

```bash
bun run build          # sync-models → tsup → tsc declarations
bun run dev            # CODE_SHELL_DEV=1 bun run src/cli/main.ts
bun test               # bun test runner (not vitest/jest)
bun test -- -t 'name'  # run a single test by pattern
bun run typecheck      # tsc --noEmit
bun run lint           # eslint src/
```

## Code Style

- **Prettier**: double quotes, semicolons always, trailing commas (`all`), 2-space indent, 100 print width
- **ESLint**: unused vars must be prefixed with `_`; `no-explicit-any` is off
- **tsconfig**: `strict: true` but `noImplicitAny: false` — implicit `any` is tolerated

## Architecture Gotchas

- **Package manager is `bun`**, not npm/yarn/pnpm. Use `bun install`, `bun run`, `bun test`.
- **Terminal UI is Ink** (React for CLI). Components in `src/ui/` are `.tsx` React components — not browser DOM.
- **Build depends on sync-models**: `bun run build` runs `sync-models` first to fetch model data from OpenRouter before bundling. Skipping this produces incomplete output.
- **Typecheck is not a clean gate**: `bun run typecheck` reports pre-existing errors across the repo. Don't treat it as a blocker for your changes.
- **`@/*` path alias** maps to `src/*` (configured in tsconfig paths and tsup).
- **Custom ESLint rules are stubbed** (`no-sync-fs`, `no-top-level-side-effects`, `no-process-exit`, `no-process-cwd`, `no-process-env-top-level`) — they declare intent but don't actually lint.
- **Engine requires Node >= 20.10**.

## Commit Style

Use conventional commits: `feat:`, `fix:`, `style:`, `refactor:`, `test:`, `chore:`, `docs:`
