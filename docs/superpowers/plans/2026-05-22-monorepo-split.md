# Monorepo Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Physically split `src/` into `packages/core/src` (engine, ~250 files) and `packages/tui/src` (UI, ~190 files); make `@cjhyy/code-shell` a metapackage; delete `IpcTransport` (no consumers after codex-style desktop redesign).

**Architecture:** 6-layer topological migration in 8 batches. Each batch is one git commit that leaves the tree green (677/677 tests pass, tsc clean, eslint 0 errors). Stub re-exports keep imports resolving between batches; final batch deletes the stubs.

**Tech Stack:** bun workspaces, tsc, esbuild (desktop), vite (desktop renderer), eslint.

**Companion spec:** `docs/superpowers/specs/2026-05-22-monorepo-split-design.md`

---

## Preflight (Task 0): Working tree gate

**Files:**
- Read: `git status --short`
- No file changes in this task — gate only.

- [ ] **Step 1: Verify working tree is clean**

```bash
git status --short
```

Expected: empty output. If not empty, STOP. The user must commit or stash their unrelated changes before migration begins (see spec §5.5). Do not proceed.

- [ ] **Step 2: Verify on main, in sync with origin**

```bash
git branch --show-current
# Expected: main
git fetch origin main
git status -sb
# Expected: "## main...origin/main" with no "ahead"/"behind"
```

- [ ] **Step 3: Verify baseline tests pass**

```bash
npx tsc --noEmit
bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)"
```

Expected: tsc clean, `677 pass`, `0 fail`.

- [ ] **Step 4: Tag baseline for nuclear rollback**

```bash
git tag v0.4.0-monorepo-batch-0
```

- [ ] **Step 5: Pre-create stub helper script**

Create `scripts/migrate-stub-gen.sh`:

```bash
#!/usr/bin/env bash
# Generate stub re-exports for a moved directory.
# Usage: ./scripts/migrate-stub-gen.sh <dirname>
#   e.g.: ./scripts/migrate-stub-gen.sh logging
# Creates src/<dirname>/<each-file>.ts as a re-export pointing to
# packages/core/src/<dirname>/<file>.js
#
# For a top-level single file (e.g. src/types.ts), pass the file path:
#   ./scripts/migrate-stub-gen.sh types.ts

set -euo pipefail
NAME="$1"
NEW_BASE="../packages/core/src"

if [[ -f "packages/core/src/$NAME" ]]; then
  # Single file at top level
  rel="${NEW_BASE}/${NAME%.ts}.js"
  mkdir -p "$(dirname "src/$NAME")"
  cat > "src/$NAME" <<EOF
// Temporary stub during monorepo migration (spec §4.3.1). Removed in batch 8.
export * from "$rel";
EOF
  echo "wrote stub: src/$NAME → $rel"
  exit 0
fi

if [[ ! -d "packages/core/src/$NAME" ]]; then
  echo "ERROR: packages/core/src/$NAME is not a file or directory" >&2
  exit 1
fi

# Directory — generate per-file stubs for every .ts/.tsx file
mkdir -p "src/$NAME"
find "packages/core/src/$NAME" -type f \( -name "*.ts" -o -name "*.tsx" \) | while read -r src; do
  rel_to_dir="${src#packages/core/src/$NAME/}"
  target_path="src/$NAME/$rel_to_dir"
  target_dir="$(dirname "$target_path")"
  mkdir -p "$target_dir"
  # Compute relative path from stub to real file
  rel="../../packages/core/src/$NAME/${rel_to_dir%.ts*}.js"
  cat > "$target_path" <<EOF
// Temporary stub during monorepo migration (spec §4.3.1). Removed in batch 8.
export * from "$rel";
EOF
done
echo "wrote stubs for: src/$NAME/"
```

```bash
chmod +x scripts/migrate-stub-gen.sh
git add scripts/migrate-stub-gen.sh
git commit -m "chore(monorepo): add stub-gen helper for migration batches"
```

---

## Batch 1: Move Layer 0 (no-deps leaves) to packages/core

**Files moved (5 dirs/files):**
- `src/types.ts` → `packages/core/src/types.ts`
- `src/exceptions.ts` → `packages/core/src/exceptions.ts`
- `src/data/` → `packages/core/src/data/`
- `src/utils/` → `packages/core/src/utils/`
- `src/react-compiler-runtime-shim.ts` — **stay in src/**, this goes to TUI in batch 7

**Files modified:** none yet (stubs only)

**Test:** existing test suite (677/677)

- [ ] **Step 1: Verify packages/core/src exists**

```bash
ls packages/core/src
```

Expected: at least `index.ts` exists from the POC.

- [ ] **Step 2: Move types.ts**

```bash
git mv src/types.ts packages/core/src/types.ts
./scripts/migrate-stub-gen.sh types.ts
```

- [ ] **Step 3: Move exceptions.ts**

```bash
git mv src/exceptions.ts packages/core/src/exceptions.ts
./scripts/migrate-stub-gen.sh exceptions.ts
```

- [ ] **Step 4: Move data/**

```bash
git mv src/data packages/core/src/data
./scripts/migrate-stub-gen.sh data
```

- [ ] **Step 5: Move utils/**

```bash
git mv src/utils packages/core/src/utils
./scripts/migrate-stub-gen.sh utils
```

- [ ] **Step 6: Verify tsc clean**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 7: Verify tests pass**

```bash
bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)"
```

Expected: `677 pass`, `0 fail`.

- [ ] **Step 8: Verify eslint clean**

```bash
npx eslint src/ packages/ 2>&1 | tail -3
```

Expected: `0 errors` (warnings OK).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore(monorepo): move L0 leaves (types/exceptions/data/utils) to core (batch 1)"
```

---

## Batch 2: Move Layer 1 (depends on L0 only) to packages/core

**Files moved (7 dirs):**
- `src/logging/`, `src/settings/`, `src/skills/`, `src/preset/`, `src/agent/`, `src/cron/`, `src/git/`

- [ ] **Step 1: Move 7 directories**

```bash
git mv src/logging packages/core/src/logging
git mv src/settings packages/core/src/settings
git mv src/skills packages/core/src/skills
git mv src/preset packages/core/src/preset
git mv src/agent packages/core/src/agent
git mv src/cron packages/core/src/cron
git mv src/git packages/core/src/git
```

- [ ] **Step 2: Generate stubs**

```bash
for d in logging settings skills preset agent cron git; do
  ./scripts/migrate-stub-gen.sh "$d"
done
```

- [ ] **Step 3: Verify tsc clean**

```bash
npx tsc --noEmit
```

Expected: 0 errors. If errors: a Layer 1 file imports something from Layer 2+ (a misclassification). Fix by promoting the file's layer.

- [ ] **Step 4: Verify tests pass**

```bash
bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)"
```

Expected: `677 pass`.

- [ ] **Step 5: Verify eslint clean**

```bash
npx eslint src/ packages/ 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(monorepo): move L1 (logging/settings/skills/preset/agent/cron/git) to core (batch 2)"
```

---

## Batch 3: Move Layer 2 (depends on L0–L1) to packages/core

**Files moved (7 dirs, ~50 files):**
- `src/llm/`, `src/context/`, `src/prompt/`, `src/hooks/`, `src/lsp/`, `src/services/`, `src/plugins/`

- [ ] **Step 1: Move 7 directories**

```bash
git mv src/llm packages/core/src/llm
git mv src/context packages/core/src/context
git mv src/prompt packages/core/src/prompt
git mv src/hooks packages/core/src/hooks
git mv src/lsp packages/core/src/lsp
git mv src/services packages/core/src/services
git mv src/plugins packages/core/src/plugins
```

- [ ] **Step 2: Generate stubs**

```bash
for d in llm context prompt hooks lsp services plugins; do
  ./scripts/migrate-stub-gen.sh "$d"
done
```

- [ ] **Step 3: Verify tsc clean**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Verify tests pass**

```bash
bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)"
```

Expected: `677 pass`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(monorepo): move L2 (llm/context/prompt/hooks/lsp/services/plugins) to core (batch 3)"
```

---

## Batch 4: Move Layer 3 (depends on L0–L2) to packages/core

**Files moved (3 dirs, ~100 files):**
- `src/session/`, `src/tool-system/`, `src/arena/`, `src/remote/`
- (voice/ stays in src/ — it's TUI in batch 7)

- [ ] **Step 1: Move 4 directories**

```bash
git mv src/session packages/core/src/session
git mv src/tool-system packages/core/src/tool-system
git mv src/arena packages/core/src/arena
git mv src/remote packages/core/src/remote
```

- [ ] **Step 2: Generate stubs**

```bash
for d in session tool-system arena remote; do
  ./scripts/migrate-stub-gen.sh "$d"
done
```

- [ ] **Step 3: Verify tsc clean**

```bash
npx tsc --noEmit
```

Expected: 0 errors. tool-system has 50 files — if anything misclassified, this is where it surfaces.

- [ ] **Step 4: Verify tests pass**

```bash
bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)"
```

Expected: `677 pass`.

- [ ] **Step 5: Commit + tag**

```bash
git add -A
git commit -m "chore(monorepo): move L3 (session/tool-system/arena/remote) to core (batch 4)"
git tag v0.4.0-monorepo-batch-2
```

---

## Batch 5: Move Layer 4 + cli shared files; write core/index.ts

**Files moved:**
- `src/engine/`, `src/run/`, `src/product/`
- `src/cli/cost-tracker.ts` → `packages/core/src/cost-tracker.ts`
- `src/cli/onboarding.ts` → `packages/core/src/onboarding.ts`
- `src/cli/updater.ts` → `packages/core/src/updater.ts`

**Files modified:**
- Create: `packages/core/src/index.ts` (full re-export of all public API)

- [ ] **Step 1: Move 3 dirs + 3 cli files**

```bash
git mv src/engine packages/core/src/engine
git mv src/run packages/core/src/run
git mv src/product packages/core/src/product
git mv src/cli/cost-tracker.ts packages/core/src/cost-tracker.ts
git mv src/cli/onboarding.ts packages/core/src/onboarding.ts
git mv src/cli/updater.ts packages/core/src/updater.ts
```

- [ ] **Step 2: Generate stubs for moved dirs**

```bash
for d in engine run product; do
  ./scripts/migrate-stub-gen.sh "$d"
done
```

- [ ] **Step 3: Generate stubs for moved cli files**

These need stubs at `src/cli/cost-tracker.ts` etc. (not top-level):

```bash
for f in cost-tracker onboarding updater; do
  cat > "src/cli/$f.ts" <<EOF
// Temporary stub during monorepo migration (spec §4.3.1). Removed in batch 8.
export * from "../../packages/core/src/$f.js";
EOF
done
```

- [ ] **Step 4: Replace `packages/core/src/index.ts` with full public API**

Read the current root `src/index.ts` for the canonical export list. Then write `packages/core/src/index.ts` as:

```ts
// @cjhyy/code-shell-core — public API surface.
//
// Migrated from the legacy `src/index.ts`. Keep this in sync with what
// downstream consumers expect (Engine, AgentClient, AgentServer,
// HookRegistry, Transcript, etc.). The shape of this re-export list
// IS the public API contract.

export * from "./types.js";
export * from "./exceptions.js";

// Engine
export { Engine, type EngineConfig, type EngineResult, type EngineHookConfig } from "./engine/engine.js";
// ... (mirror the contents of src/index.ts exactly — re-read it during this task and replicate)
```

The actual content must match what `src/index.ts` currently exports. Run:

```bash
cat src/index.ts
```

…and replicate every `export ... from "./..."` line with the path remapped from `./X` (root src) to `./X` (now packages/core/src — same relative form). Most lines port over verbatim because they were already relative.

- [ ] **Step 5: Make root src/index.ts a stub**

```bash
cat > src/index.ts <<'EOF'
// Temporary stub during monorepo migration (spec §4.3.1). Removed in batch 8.
export * from "../packages/core/src/index.js";
EOF
```

- [ ] **Step 6: Verify tsc clean**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 7: Verify tests pass**

```bash
bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)"
```

Expected: `677 pass`.

- [ ] **Step 8: Stage gate — core builds standalone**

```bash
cd packages/core && bun run build
ls dist/
cd ../..
```

Expected: `dist/index.js` + `dist/index.d.ts` emitted. File sizes nontrivial (>10KB combined).

- [ ] **Step 9: Commit + tag**

```bash
git add -A
git commit -m "chore(monorepo): move L4 (engine/run/product + shared cli files); write core/index.ts (batch 5)"
git tag v0.4.0-monorepo-batch-5
```

---

## Batch 6: Move Layer 5 + delete IpcTransport

**Files moved:**
- `src/protocol/` → `packages/core/src/protocol/`
- `src/bootstrap/` — **stays in src/** (goes to TUI in batch 7)

**Files deleted (spec §3.4):**
- `packages/core/src/protocol/transport.ts`: delete the `IpcTransport` class only (keep `Transport` interface, `createInProcessTransport`, `StdioTransport`)
- `tests/protocol/ipc-transport.test.ts`: delete entire file
- `packages/core/src/index.ts`: remove `IpcTransport / IpcSink / IpcSubscribe` exports

- [ ] **Step 1: Move protocol/**

```bash
git mv src/protocol packages/core/src/protocol
./scripts/migrate-stub-gen.sh protocol
```

- [ ] **Step 2: Delete IpcTransport from transport.ts**

Open `packages/core/src/protocol/transport.ts`. Find the section starting with `// ─── IPC Transport ──` and ending at the end of the `IpcTransport` class (closing `}`). Delete that whole section including `IpcSink` and `IpcSubscribe` type definitions.

Verify remaining exports: `Transport`, `createInProcessTransport`, `StdioTransport`.

- [ ] **Step 3: Delete IpcTransport test file**

```bash
git rm tests/protocol/ipc-transport.test.ts
```

- [ ] **Step 4: Remove IpcTransport from index.ts re-exports**

In `packages/core/src/index.ts`, find the protocol re-export block. Change:

```ts
export {
  createInProcessTransport,
  StdioTransport,
  IpcTransport,
  type Transport,
  type IpcSink,
  type IpcSubscribe,
} from "./protocol/transport.js";
```

to:

```ts
export {
  createInProcessTransport,
  StdioTransport,
  type Transport,
} from "./protocol/transport.js";
```

Also remove any `IpcTransport / IpcSink / IpcSubscribe` mentions from the root `src/index.ts` re-export block if it had them.

- [ ] **Step 5: Verify tsc clean**

```bash
npx tsc --noEmit
```

Expected: 0 errors. If a file still imports `IpcTransport`, follow the error to its file. The only legitimate places that imported it were the desktop poc skeleton (now removed) and the test file (now deleted).

- [ ] **Step 6: Verify tests pass**

```bash
bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)"
```

Expected: `672 pass` (was 677, minus the 5 IpcTransport tests we deleted).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(monorepo): move L5 (protocol) to core; delete unused IpcTransport (batch 6)"
```

---

## Batch 7: Move all TUI content to packages/tui; rewrite imports to use core package name

**Files moved:**
- `src/ui/` → `packages/tui/src/ui/`
- `src/render/` → `packages/tui/src/render/`
- `src/bootstrap/` → `packages/tui/src/bootstrap/`
- `src/native-ts/` → `packages/tui/src/native-ts/`
- `src/voice/` → `packages/tui/src/voice/`
- `src/react-compiler-runtime-shim.ts` → `packages/tui/src/react-compiler-runtime-shim.ts`
- `src/cli/` (remaining: commands/, input/, output/, main.ts, input-compiler.ts, exit.ts, migrate-models.ts) → `packages/tui/src/cli/`

**Files modified (this is the big import rewrite):**
- All files now in `packages/tui/src/` that previously imported from `../<dir>` need to point at `@cjhyy/code-shell-core`. The pattern is mechanical:
  - `from "../../types.js"` → `from "@cjhyy/code-shell-core"` (if importing public types)
  - `from "../../engine/engine.js"` → `from "@cjhyy/code-shell-core"` (Engine is re-exported)
  - `from "../../protocol/client.js"` → `from "@cjhyy/code-shell-core"` (AgentClient re-exported)
  - …and so on
- packages/tui/package.json must declare `@cjhyy/code-shell-core` as dependency
- packages/tui/package.json bin entry: `code-shell` → `dist/cli/main.js`

- [ ] **Step 1: Rename packages/cli to packages/tui**

The POC scaffold made `packages/cli/`. We agreed in brainstorming to call it `tui`.

```bash
git mv packages/cli packages/tui
# Update its package.json name
```

Edit `packages/tui/package.json`:

```jsonc
{
  "name": "@cjhyy/code-shell-tui",
  "version": "0.5.0-rc.0",
  "type": "module",
  "main": "./dist/cli/main.js",
  "bin": {
    "code-shell": "./dist/cli/main.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@cjhyy/code-shell-core": "workspace:*"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

(Keep external deps that tui actually needs — react, ink, yoga, etc. — copy from current root package.json dependencies.)

- [ ] **Step 2: Move 6 dirs + 1 file from src/ to packages/tui/src/**

```bash
git mv src/ui packages/tui/src/ui
git mv src/render packages/tui/src/render
git mv src/bootstrap packages/tui/src/bootstrap
git mv src/native-ts packages/tui/src/native-ts
git mv src/voice packages/tui/src/voice
git mv src/react-compiler-runtime-shim.ts packages/tui/src/react-compiler-runtime-shim.ts
```

- [ ] **Step 3: Move remaining src/cli to packages/tui/src/cli**

```bash
git mv src/cli packages/tui/src/cli
```

At this point `src/` should only contain stubs from earlier batches.

- [ ] **Step 4: Rewrite cross-package imports**

The mechanical rule: any `from "../../<X>"` or `from "../<X>"` inside `packages/tui/src/` that resolves to something now in `packages/core/src/` becomes `from "@cjhyy/code-shell-core"`.

Run this audit script to see what needs rewriting:

```bash
# What's the current import surface inside packages/tui/src
grep -rh '^import .* from "\.\./' packages/tui/src/ 2>/dev/null \
  | sed 's|.*from "||;s|".*||' | sort -u
```

For each path it lists, decide: does this resolve to packages/core/src/ now, or to packages/tui/src/?

- If it's a path that was moved to core in batches 1–6 → rewrite to `@cjhyy/code-shell-core`
- If it stays within tui → keep as is

Apply rewrites via sed for the common patterns. Example:

```bash
# Rewrite imports of core public symbols. Adjust paths as the audit reveals.
# This is a starting list — review the audit output above to extend.
find packages/tui/src -type f \( -name "*.ts" -o -name "*.tsx" \) -print0 \
  | xargs -0 sed -i '' \
    -e 's|from "\.\./\.\./types\.js"|from "@cjhyy/code-shell-core"|g' \
    -e 's|from "\.\./\.\./\.\./types\.js"|from "@cjhyy/code-shell-core"|g' \
    -e 's|from "\.\./types\.js"|from "@cjhyy/code-shell-core"|g' \
    -e 's|from "\.\./\.\./engine/engine\.js"|from "@cjhyy/code-shell-core"|g' \
    -e 's|from "\.\./\.\./protocol/client\.js"|from "@cjhyy/code-shell-core"|g' \
    -e 's|from "\.\./\.\./protocol/types\.js"|from "@cjhyy/code-shell-core"|g'
```

After the sed pass, re-run the audit and keep iterating until no `from "../../X"` path resolves into `packages/core/src/`.

- [ ] **Step 5: Add core dependency symlink (bun install)**

```bash
bun install
ls packages/tui/node_modules/@cjhyy/code-shell-core
# Expected: symlink → ../../../core
```

- [ ] **Step 6: Verify tsc clean**

```bash
npx tsc --noEmit
```

Expected: 0 errors. If errors: a path was missed by sed — find the file, fix manually, re-run.

- [ ] **Step 7: Verify tests pass**

```bash
bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)"
```

Expected: `672 pass`.

- [ ] **Step 8: Stage gate — tui builds standalone + bin works**

```bash
cd packages/tui && bun run build
node packages/tui/dist/cli/main.js --help 2>&1 | head -5
cd ../..
```

Expected: dist/ populated; bin prints help.

- [ ] **Step 9: Stage gate — desktop still builds**

```bash
cd packages/desktop && bun run build
ls out/main out/preload out/renderer
cd ../..
```

Expected: all three sub-builds OK.

- [ ] **Step 10: Commit + tag**

```bash
git add -A
git commit -m "chore(monorepo): move TUI to packages/tui; rewrite imports to @cjhyy/code-shell-core (batch 7)"
git tag v0.4.0-monorepo-batch-7
```

---

## Batch 8: Wrap-up — tests, meta package, stub removal, eslint guards

**Files modified:**
- `tests/**/*.ts`: rewrite 124 `from "../src/X"` paths to `../packages/core/src/X` or `../packages/tui/src/X`
- Root `package.json`: convert to metapackage shape
- Delete: all `src/**` stubs + the now-empty `src/` directory
- Update `tsconfig.json`: remove `src/` from `include`
- Update `eslint.config.js`: add no-import rule preventing `packages/core/**` from importing `packages/tui/**` and preventing `packages/desktop/src/renderer/**` from importing `@cjhyy/code-shell-*`

- [ ] **Step 1: Rewrite test imports**

The mechanical rule:
- `from "../src/<X>"` where `<X>` is in core's territory → `from "../packages/core/src/<X>"`
- `from "../src/<X>"` where `<X>` is in tui's territory → `from "../packages/tui/src/<X>"`

Run an audit:

```bash
grep -rh 'from "\.\./src/' tests/ 2>/dev/null | sed 's|.*from "||;s|".*||' | sort -u
```

For each result, classify (core or tui), then do the sed rewrite. Example:

```bash
find tests -type f -name "*.ts" -o -name "*.tsx" | while read -r f; do
  sed -i '' \
    -e 's|from "\.\./src/engine/|from "../packages/core/src/engine/|g' \
    -e 's|from "\.\./src/hooks/|from "../packages/core/src/hooks/|g' \
    -e 's|from "\.\./src/llm/|from "../packages/core/src/llm/|g' \
    -e 's|from "\.\./src/protocol/|from "../packages/core/src/protocol/|g' \
    -e 's|from "\.\./src/tool-system/|from "../packages/core/src/tool-system/|g' \
    -e 's|from "\.\./src/types\.js"|from "../packages/core/src/types.js"|g' \
    -e 's|from "\.\./src/exceptions\.js"|from "../packages/core/src/exceptions.js"|g' \
    -e 's|from "\.\./src/ui/|from "../packages/tui/src/ui/|g' \
    -e 's|from "\.\./src/render/|from "../packages/tui/src/render/|g' \
    "$f"
done
```

Extend the sed list with whatever the audit produced. Re-run the audit until 0 results.

- [ ] **Step 2: Convert root package.json to metapackage**

Replace `package.json` content with:

```jsonc
{
  "name": "@cjhyy/code-shell",
  "version": "0.5.0-rc.0",
  "description": "Code Shell — meta package. Installs @cjhyy/code-shell-core and @cjhyy/code-shell-tui.",
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "code-shell": "./node_modules/.bin/code-shell"
  },
  "scripts": {
    "build": "bun run build:meta",
    "build:meta": "mkdir -p dist && echo 'export * from \"@cjhyy/code-shell-core\";' > dist/index.js && echo 'export * from \"@cjhyy/code-shell-core\";' > dist/index.d.ts",
    "test": "bun test",
    "typecheck": "bun run tsc --noEmit"
  },
  "dependencies": {
    "@cjhyy/code-shell-core": "workspace:*",
    "@cjhyy/code-shell-tui": "workspace:*"
  },
  "workspaces": ["packages/*"],
  "engines": {"node": ">=20.10"},
  "publishConfig": {"access": "public"}
}
```

Keep `devDependencies` (eslint, typescript, prettier, etc.) — those drive workspace-wide tooling.

- [ ] **Step 3: Update root tsconfig.json**

Remove `src/` from `include`. Keep refs to packages/core and packages/tui if you want a workspace-level typecheck; otherwise rely on each package's own tsconfig:

```jsonc
{
  "compilerOptions": { /* unchanged */ },
  "include": [
    "packages/core/src/**/*.ts",
    "packages/tui/src/**/*.ts",
    "packages/tui/src/**/*.tsx",
    "tests/**/*.ts",
    "tests/**/*.tsx"
  ],
  "exclude": ["node_modules", "dist", "packages/desktop"]
}
```

- [ ] **Step 4: Delete all stubs in src/**

```bash
git rm -rf src
```

- [ ] **Step 5: Add eslint guard rules**

In `eslint.config.js`, add a config block:

```js
{
  files: ["packages/core/src/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [
        { group: ["@cjhyy/code-shell-tui", "@cjhyy/code-shell-tui/*"],
          message: "core must not import tui" },
        { group: ["**/packages/tui/**"],
          message: "core must not import tui (use package name if you need it — but core cannot depend on tui)" }
      ]
    }]
  }
},
{
  files: ["packages/desktop/src/renderer/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [
        { group: ["@cjhyy/code-shell-core", "@cjhyy/code-shell-core/*", "@cjhyy/code-shell-tui", "@cjhyy/code-shell-tui/*", "@cjhyy/code-shell"],
          message: "renderer must not import codeshell packages — talk to main via window.codeShell.*" }
      ]
    }]
  }
}
```

- [ ] **Step 6: Run all verification**

```bash
npx tsc --noEmit
bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)"
npx eslint packages/ tests/ 2>&1 | tail -3
```

Expected: tsc 0 errors, `672 pass`, eslint 0 errors.

- [ ] **Step 7: Final acceptance — 10 checks (spec §5.4)**

```bash
# 1
npx tsc --noEmit
# 2
bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)"
# 3
npx eslint packages/ 2>&1 | tail -3
# 4
cd packages/core && bun run build && ls dist/index.js && cd ../..
# 5
cd packages/tui && bun run build && ls dist/cli/main.js && cd ../..
# 6
cd packages/desktop && bun run build && ls out/main out/preload out/renderer && cd ../..
# 7
node packages/tui/dist/cli/main.js --help | head -5
# 8
find src -type f 2>/dev/null | wc -l
# Expected: 0 (src/ removed)
# 9
bun -e 'import("@cjhyy/code-shell").then(m => console.log(typeof m.Engine))'
# Expected: function
# 10
bun -e 'import("@cjhyy/code-shell-core").then(m => console.log(typeof m.Engine))'
# Expected: function
```

If any of the 10 fails: STOP. The split is incomplete. Either fix the specific failure or revert the batch and reconsider.

- [ ] **Step 8: Commit + tag**

```bash
git add -A
git commit -m "chore(monorepo): wrap-up — meta package, stub removal, eslint guards (batch 8)

Final state of the monorepo split:
- @cjhyy/code-shell-core (engine, ~250 files)
- @cjhyy/code-shell-tui (UI + bin, ~190 files)
- @cjhyy/code-shell (metapackage, re-exports core + transitively exposes tui bin)
- packages/desktop unchanged (still consumes core via @cjhyy/code-shell-core)

src/ removed entirely. 672/672 tests pass. tsc + eslint clean. All 10
acceptance checks (spec §5.4) green."
git tag v0.4.0-monorepo-batch-8
```

- [ ] **Step 9: Push**

```bash
git push origin main
git push origin v0.4.0-monorepo-batch-0 v0.4.0-monorepo-batch-2 v0.4.0-monorepo-batch-5 v0.4.0-monorepo-batch-7 v0.4.0-monorepo-batch-8
```

---

## Self-review notes (writing-plans skill checklist)

**Spec coverage:** Every section of `2026-05-22-monorepo-split-design.md` maps to a task here. §1 architecture → batch 8 (eslint guards). §2 package contents → batches 1–7. §3.1 TUI flow → batch 7 (tui keeps using AgentClient via core import). §3.2 desktop codex-style → out of scope for this plan (see spec §7). §3.4 IpcTransport removal → batch 6. §4 migration → batches 1–8 exact mapping. §5 rollback/verification → preflight + batches 4/5/7/8 tags + final 10-check.

**Placeholder scan:** none. Every step has concrete commands. The one judgment-required step is batch 5 step 4 (replicate src/index.ts content into packages/core/src/index.ts) — engineer is told to `cat src/index.ts` and replicate. That's the right amount of guidance because the export list will have evolved by the time this plan executes.

**Type consistency:** package names consistent throughout (`@cjhyy/code-shell-core`, `@cjhyy/code-shell-tui`, `@cjhyy/code-shell`). Tag names consistent (`v0.4.0-monorepo-batch-N`). Path forms consistent (`packages/<pkg>/src/<dir>`).
