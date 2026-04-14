# CODESHELL.md

This file provides guidance to Code Shell when working with code in this repository.

## Project Overview

Code Shell is now positioned as a general-purpose agent orchestration framework with a built-in `terminal-coding` preset. The core engine is domain-agnostic; coding behavior comes from preset/configuration. Ink (React for CLI) powers the terminal UI.

## Build & Dev Commands

```bash
npm run build        # Build with tsup (output: dist/)
npm run dev          # Watch mode dev build
npm start            # Run the built CLI
npm test             # Run tests with vitest
npx vitest run -t 'test name'  # Run a single test by name
```

## Code Style

Prettier is the formatter — see `.prettierrc`:
- **Double quotes**, semicolons, trailing commas (`all`)
- 2-space indentation, 100 char print width
- No ESLint — rely on Prettier + TypeScript compiler

## Architecture Gotchas

- **Ink/React UI**: The terminal UI uses Ink (React renderer for CLI). Components in `src/ui/` are `.tsx` files using React patterns — not browser React.
- **Tool system**: Tools are defined in `src/tool/builtin/`. Each tool exports a definition object with name, description, parameters schema, and execute function.
- **Preset system**: `src/preset/` defines built-in agent presets that choose the default system prompt, builtin tool set, and permission shortcuts.
- **Engine**: `src/engine/` handles the conversation loop and LLM interaction.
- **`restored-src/`**: Legacy/reference code imported for feature parity. Do not modify files here without understanding their origin.

## Testing

- Framework: **vitest** (not Jest)
- Test files live in `tests/` directory with `.test.ts` extension
- Use `describe`/`it`/`expect` from vitest

## Commit Style

Use conventional commits: `feat:`, `fix:`, `style:`, `refactor:`, `test:`, `chore:`
