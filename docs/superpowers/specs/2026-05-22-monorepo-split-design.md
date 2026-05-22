# Monorepo Split — `@cjhyy/code-shell` → core + tui + meta + desktop

**Date:** 2026-05-22
**Status:** Design (awaiting review)
**Author:** maki maki (with assistance from Claude Opus 4.7)

## Why

`@cjhyy/code-shell` currently ships engine, TUI, renderer, and protocol
in a single 5.7MB npm package. Two consequences:

1. **SDK consumers** who only want `new Engine()` still pull React,
   Ink, Yoga, and all UI dependencies into their `node_modules`.
2. **The desktop client** (in progress, `packages/desktop/`) cannot
   import `Engine` cleanly without dragging the entire UI subtree
   through esbuild — every transitive dep gets bundled into main even
   though main only needs core.

The fix is to split into three publishable packages plus the existing
private `desktop` app. This document captures the design we agreed on
during the 2026-05-22 brainstorming session.

## Goal

After this change:

- `npm i @cjhyy/code-shell-core` — pure engine, zero UI deps
- `npm i @cjhyy/code-shell-tui` — terminal UI on top of core (provides
  `code-shell` bin)
- `npm i @cjhyy/code-shell` — metapackage; backwards-compatible with
  every existing `import { Engine } from "@cjhyy/code-shell"` and
  every existing `code-shell` CLI invocation
- `packages/desktop/` — Electron app, depends on core, NOT published

## Non-goals

- **Not** introducing a separate `@cjhyy/code-shell-protocol` package.
  The protocol types live in core. Customers needing only types can
  install core (small, no runtime deps beyond what protocol needs).
- **Not** doing a logical-only split (tsconfig path aliases pretending
  to be packages). The split is physical: real directories, real
  `package.json` files, real workspace symlinks.
- **Not** modifying the existing `AgentClient` to be browser-friendly.
  The desktop renderer takes a codex-style path (no `AgentClient`
  import at all — see §3.2 below).

## 1. Architecture

```
codeshell/  (bun workspace root)
├── package.json              ← workspace root + meta package
│                               name: @cjhyy/code-shell
│                               dependencies: code-shell-core + code-shell-tui
│                               re-exports core, transitively exposes tui bin
│
├── packages/
│   ├── core/                 ← @cjhyy/code-shell-core
│   │   ├── src/              ← engine, tool-system, hooks, protocol, ...
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── tui/                  ← @cjhyy/code-shell-tui (bin: code-shell)
│   │   ├── src/              ← ui, render, bootstrap, cli (entry), ...
│   │   ├── tsconfig.json
│   │   └── package.json (dependencies: @cjhyy/code-shell-core)
│   │
│   └── desktop/              ← @cjhyy/code-shell-desktop (private)
│       └── (existing skeleton from prior session)
│           main: depends on @cjhyy/code-shell-core
│           renderer: ZERO codeshell deps (talks to main via IPC)
│
├── tests/                    ← stays at root, runs everything
├── docs/
├── eslint.config.js
└── (old src/ is removed at the end)
```

### Dependency rules (enforced by eslint)

| Allowed | Forbidden |
|---|---|
| `tui → @cjhyy/code-shell-core` | `core → tui` (ever) |
| `desktop/src/main → @cjhyy/code-shell-core` | `core → desktop` |
| `desktop/src/renderer → window.codeShell.*` only | `desktop/src/renderer → @cjhyy/code-shell-*` |
| `core` internal: relative paths only | `core` internal: `@cjhyy/code-shell-core/...` self-imports |

## 2. Package contents

### `packages/core/src/`

Holds anything that is not React/Ink/Yoga/CLI-stdin-specific.

| Top-level | Files | Notes |
|---|---|---|
| `engine/` | 10 | Engine main loop |
| `tool-system/` | 50 | Tool registry, executor, builtins |
| `hooks/` | 4 | Lifecycle hooks |
| `llm/` | 17 | Provider clients |
| `session/` | 4 | Transcript, session storage |
| `context/` | 4 | Context compaction |
| `prompt/` | 5 | Prompt composer |
| `protocol/` | 6 | AgentClient, AgentServer, transports (JSON-RPC) |
| `skills/` | 3 | Skill scanner |
| `plugins/` | 12 | Plugin loader |
| `settings/` | 2 | Settings manager |
| `logging/` | 2 | Logger |
| `preset/` | 1 | Agent presets |
| `run/` | 14 | Run manager |
| `arena/` | 47 | Multi-model arena |
| `product/` | 3 | SDK helpers for downstream consumers |
| `utils/` | 16 | Generic helpers |
| `data/` | 3 | OpenRouter catalog data |
| `services/` | 9 | analytics, auto-dream, diagnostics |
| `agent/` | 1 | coordinator |
| `cron/` | 1 | scheduler |
| `git/` | 2 | git utilities (used by tool-system) |
| `lsp/` | 3 | LSP client (used by tool-system) |
| `remote/` | 1 | NDJSON-over-SSH bridge (currently unused) |
| `exceptions.ts` | 1 | Custom error classes |
| `types.ts` | 1 | Public types |
| `index.ts` | 1 | Public API surface (re-export the ~50 symbols `src/index.ts` already exposes) |
| `cost-tracker.ts` | 1 | Moved from `src/cli/` — UI-agnostic |
| `onboarding.ts` | 1 | Moved from `src/cli/` — UI-agnostic |
| `updater.ts` | 1 | Moved from `src/cli/` — UI-agnostic |

Approximate total: ~250 files.

### `packages/tui/src/`

Everything React/Ink/Yoga/CLI-stdin-specific, plus the `code-shell`
bin.

| Top-level | Files | Notes |
|---|---|---|
| `ui/` | 51 | React components |
| `render/` | 104 | Ink/Yoga renderer |
| `bootstrap/` | 2 | UI startup chain |
| `native-ts/` | (yoga binding) | Yoga layout — TUI-only |
| `voice/` | 1 | STT/TTS — input device adapter (currently unused) |
| `react-compiler-runtime-shim.ts` | 1 | React Compiler memoization shim |
| `cli/` | ~24 | bin entry + commands/, input/, output/, input-compiler.ts, exit.ts, migrate-models.ts — **excluding** the 3 files moved to core |

Approximate total: ~190 files.

### Root meta package `@cjhyy/code-shell`

`package.json` becomes:

```jsonc
{
  "name": "@cjhyy/code-shell",
  "version": "0.5.0",
  "dependencies": {
    "@cjhyy/code-shell-core": "workspace:*",
    "@cjhyy/code-shell-tui": "workspace:*"
  },
  "main": "./dist/index.js",     // re-exports core
  "bin": { "code-shell": "..." } // transitively from tui (delegated)
}
```

`dist/index.js` literally just does `export * from "@cjhyy/code-shell-core";`.
Existing `import { Engine } from "@cjhyy/code-shell"` keeps working.

## 3. Data flow

### 3.1 TUI (no change in topology)

```
@cjhyy/code-shell-tui (one Node process)
├── cli/main.ts (bin)
│   new Engine({...}) ← direct
│   engine.run("...")  ← direct
└── ui/* + render/*
    AgentClient ↔ AgentServer ↔ createInProcessTransport
    (already in production today)
```

No architectural change here. TUI keeps using `AgentClient` over
`createInProcessTransport`, which is in core. The only difference is
the import path: `import { AgentClient, AgentServer } from "@cjhyy/code-shell-core"`.

### 3.2 Desktop (codex-style — renderer is a thin client)

```
┌───────── Electron main (Node) ─────────────────┐
│                                                │
│  AgentServer ← directly from @cjhyy/code-shell-core
│     ↑                                          │
│  ipcMain.handle("code-shell:run", ...)         │
│  ipcMain.handle("code-shell:cancel", ...)      │
│  ipcMain.handle("code-shell:approve", ...)     │
│  server notifications → webContents.send(...)  │
│                                                │
└─────────────────┬──────────────────────────────┘
                  │ Electron IPC (JSON)
                  ▼
┌───────── Electron renderer (Chromium) ─────────┐
│                                                │
│  window.codeShell (exposed by preload):        │
│   ├── run(task, sessionId?) → Promise          │
│   ├── cancel() → Promise                       │
│   ├── approve(reqId, decision) → Promise       │
│   ├── onStream(handler) → unsubscribe          │
│   ├── onApprovalRequest(h) → unsubscribe       │
│   └── onStatus(h) → unsubscribe                │
│                                                │
│  React UI:                                     │
│   const r = await window.codeShell.run("...");│
│   window.codeShell.onStream(ev => /* ... */); │
│                                                │
│  ZERO codeshell imports, ZERO node modules,    │
│  ZERO EventEmitter / node:events               │
│                                                │
└────────────────────────────────────────────────┘
```

### 3.3 Why we DON'T use `AgentClient` from desktop

`AgentClient` makes sense when the consumer is a Node process talking
to an in-process or stdio JSON-RPC server. Desktop main has neither
need: it already has the `Engine` object next to it. Going through
`AgentClient` would mean:

- main: `Engine → Transport (out) → AgentClient → Transport (in) → ipcMain`
- but we want: `Engine → AgentServer → ipcMain` (direct)

Codex's desktop client does the same simplification — it talks to the
`app-server` JSON-RPC surface directly, not through the
`app-server-client` crate (which exists for Rust CLI consumers).

### 3.4 Consequence for `IpcTransport`

`IpcTransport` was written assuming the renderer would use
`AgentClient` over Electron IPC. With the codex-style decision, the
renderer never uses `AgentClient`. `IpcTransport` has no consumers
and is removed in batch 6.

| Transport | Kept? | Used by |
|---|---|---|
| `createInProcessTransport()` | yes | TUI, desktop main |
| `StdioTransport` | yes | future remote/bridge or daemon mode |
| `IpcTransport` | **no, removed** | nobody |

## 4. Migration steps

Following the topology-based batch strategy from the brainstorming
session. Each batch is one git commit that leaves the repo green.

### 4.1 Layered topology

| Layer | Contents | Has dependencies on |
|---|---|---|
| L0 | types.ts, exceptions.ts, data/, utils/, react-compiler-runtime-shim.ts | (none) |
| L1 | logging/, settings/, skills/, preset/, agent/, cron/, git/ | L0 |
| L2 | llm/, context/, prompt/, hooks/, lsp/, services/, plugins/ | L0–L1 |
| L3 | session/, tool-system/, arena/, voice/, remote/ | L0–L2 |
| L4 | engine/, run/, product/, cost-tracker.ts, onboarding.ts, updater.ts | L0–L3 |
| L5 | protocol/, bootstrap/ | L0–L4 |
| L6 | ui/, render/, native-ts/, cli/ (rest), index.ts | L0–L5 |

### 4.2 Batch plan

| Batch | Move | Notes |
|---|---|---|
| 1 | L0 → `packages/core/src/` | leave stubs at `src/` |
| 2 | L1 → `packages/core/src/` | leave stubs |
| 3 | L2 → `packages/core/src/` | leave stubs |
| 4 | L3 (minus voice, react-shim) → `packages/core/src/` | leave stubs; voice & react-shim stay in src/ until batch 7 |
| 5 | L4 → `packages/core/src/`; write `packages/core/src/index.ts` with full re-exports | leave stubs |
| 6 | L5 protocol → `packages/core/src/`; **delete IpcTransport + tests + index.ts re-export** | leave stubs |
| 7 | All TUI content → `packages/tui/src/`; update tui imports to `@cjhyy/code-shell-core` | bin entry: `packages/tui/dist/cli/main.js` |
| 8 | tests/ import rewrites; meta package config; delete all src/ stubs; delete src/; eslint guards | terminal state |

### 4.3 Per-batch routine

```
1. git mv <dir> packages/core/src/<dir>
2. write src/<dir>/index.ts (or per-file stubs) that re-export from new location
3. npx tsc --noEmit       (must be 0 errors)
4. bun test               (must remain 677/677)
5. npx eslint src/ packages/  (0 errors)
6. git add -A && git commit -m "chore(monorepo): move <X> to packages/core (batch N)"
```

### 4.3.1 Stub template

A directory with `index.ts`:

```ts
// src/<dir>/index.ts
// Temporary stub during monorepo migration. Removed in batch 8.
export * from "../../packages/core/src/<dir>/index.js";
```

A directory whose consumers import individual files (no `index.ts`):

```ts
// src/<dir>/<file>.ts (per file in the original dir)
// Temporary stub during monorepo migration. Removed in batch 8.
export * from "../../packages/core/src/<dir>/<file>.js";
```

A top-level single file (e.g. `src/types.ts`):

```ts
// src/types.ts
// Temporary stub during monorepo migration. Removed in batch 8.
export * from "../packages/core/src/types.js";
```

Per-batch precheck script generates these automatically; the engineer
running the batch reviews them before commit.

### 4.3.2 Test import rewrite (batch 8)

The 124 `from "../src/<X>"` paths in `tests/` are rewritten to point
at the new package location:

```
from "../src/engine/engine.js"       →  from "../packages/core/src/engine/engine.js"
from "../src/hooks/inject.js"        →  from "../packages/core/src/hooks/inject.js"
from "../src/ui/components/X.js"     →  from "../packages/tui/src/ui/components/X.js"
```

Rewrite is mechanical (sed-driven) using the per-dir classification
from §2.

### 4.4 Risk register

| Risk | Mitigation |
|---|---|
| Directory has no `index.ts`; consumers import files directly | Per-batch precheck script: grep all `from "../<dir>"` paths, generate per-file stubs |
| Hidden cross-layer dependency (e.g. tool-system file imports engine) | tsc fails immediately; fix by moving the offending file up a layer |
| Working tree dirty at start | Pre-flight gate: `git status` must be empty (excluding ignored files) |
| Concurrent edits during migration | Single-session work; no other writes accepted between batch 1 and batch 8 |

## 5. Rollback & verification

### 5.1 Rollback options

- **Single batch:** `git revert HEAD` (immediate, surgical)
- **Multi-batch:** `git reset --hard <batch-tag>` where tags are placed at batches 2, 5, 7
- **Nuclear:** `git reset --hard v0.4.0-monorepo-batch-0` (= origin/main pre-migration)

### 5.2 Per-batch verification gate

```bash
npx tsc --noEmit                     # 0 errors
bun test                             # 677/677 pass
npx eslint src/ packages/            # 0 errors
```

All three must pass. Otherwise the batch does not commit.

### 5.3 Stage gates (build the packages themselves)

After batches 5, 7, 8 respectively:

```bash
# After batch 5 (core complete)
cd packages/core && bun run build
# expect: out/index.js + out/index.d.ts emitted, sized reasonably

# After batch 7 (tui complete)
cd packages/tui && bun run build
node packages/tui/dist/cli/main.js --help
# expect: CLI help output

# Always (desktop must not regress)
cd packages/desktop && bun run build
# expect: out/main/index.mjs + out/preload + out/renderer
```

### 5.4 Final state acceptance

10 checks, all must pass before declaring done:

| # | Check | Expected |
|---|---|---|
| 1 | `npx tsc --noEmit` | 0 errors |
| 2 | `bun test` | 677/677 |
| 3 | `npx eslint src/ packages/` | 0 errors |
| 4 | `cd packages/core && bun run build` | clean |
| 5 | `cd packages/tui && bun run build` | clean |
| 6 | `cd packages/desktop && bun run build` | clean |
| 7 | `bun run packages/tui/dist/cli/main.js --help` | help text |
| 8 | `find src -type f \| wc -l` | 0 (or only README) |
| 9 | `bun -e 'import("@cjhyy/code-shell").then(m=>console.log(typeof m.Engine))'` | `function` |
| 10 | `bun -e 'import("@cjhyy/code-shell-core").then(m=>console.log(typeof m.Engine))'` | `function` |

### 5.5 Coordination with current working tree

Before migration starts, the working tree must be clean. The user
has 5 uncommitted files unrelated to monorepo work
(`engine.ts`, `llm/client-base.ts`, `session-manager.ts`,
`SpinnerWithVerb.tsx`, plus new `patch-orphaned-tools.ts`). The user
commits these in their own commits before migration begins. Claude
does not commit on the user's behalf.

## 6. Time estimate

| Batch | Estimate |
|---|---|
| 1 (L0) | 30 min |
| 2 (L1) | 30 min |
| 3 (L2) | 45 min |
| 4 (L3, ~100 files) | 60 min |
| 5 (L4) | 30 min |
| 6 (L5 + delete IpcTransport) | 30 min |
| 7 (TUI move + import rewrites) | 90 min |
| 8 (wrap-up: tests, meta, stub cleanup, eslint guards) | 60 min |
| **Total** | **~6 hours, contiguous work** |

## 7. Out of scope (explicit)

The following are NOT addressed by this migration. They land in
separate specs:

- Wiring desktop main to actually instantiate `Engine` + `AgentServer`
  + `ipcMain.handle` (the codex-style bridge from §3.2). This is a
  follow-up that becomes possible *after* the split because
  `@cjhyy/code-shell-core` then exists as a real package main can
  import cleanly.
- Designing the desktop UI itself. Renderer remains a placeholder
  ("preload bridge: pending") until the real UI design lands.
- Replacing the metapackage with independent releases for
  core/tui/desktop. Initially they version together at 0.5.0.
- Removing remaining module-level singletons in core (taskManager,
  permission.setInteractiveApprovalFn, bootstrap globals). Each is a
  separate follow-up.
