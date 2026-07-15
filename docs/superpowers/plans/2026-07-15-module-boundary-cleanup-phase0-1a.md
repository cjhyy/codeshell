# Module Boundary Cleanup — Phase 0 + Phase 1a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the only production cross-package deep import, the chat→desktop test deep import, dead/shim directories in core, and the four layering inversions inside core (protocol↔engine, session→engine ×2, settings→engine).

**Architecture:** Pure moves + import rewrites. No behavior change. Shared types sink to `packages/core/src/types.ts`; self-contained modules (`goal.ts`, `session-usage.ts`) sink out of `engine/`; the settings→engine bridge (`disk-defaults.ts`) moves into `engine/` because engine is its only consumer.

**Tech Stack:** TypeScript (bun workspaces), bun test. Repo-wide `bun run typecheck` is NOT a clean gate (pre-existing errors); verify with targeted `bun test` runs and grep.

**Execution notes (deviations from template, decided for this session):**
- NO git commits during execution — the working tree carries unrelated uncommitted user work in the same files; sweeping it into commits is worse than batching. Record `git stash create` SHA after each task instead.
- No worktree isolation — the refactor must build on the uncommitted working-tree state.

---

### Task 1: Fix desktop → core deep import in login-shell-path.ts

**Files:**
- Modify: `packages/desktop/src/main/login-shell-path.ts:3`

- [x] **Step 1: Rewrite the import**

Replace line 3:

```ts
import { ENV_DENY_REGEX } from "../../../core/src/runtime/spawn-common.js";
```

with:

```ts
import { ENV_DENY_REGEX } from "@cjhyy/code-shell-core";
```

(`ENV_DENY_REGEX` is already exported from `packages/core/src/index.ts:727`.)

- [x] **Step 2: Verify**

Run: `grep -rn "core/src" packages/desktop/src --include='*.ts' --include='*.tsx' | grep -v test | grep import`
Expected: no output.
Run: `bun test packages/desktop/src/main/login-shell-path.test.ts` (if the test file exists; otherwise `bun test packages/desktop/src/main --test-name-pattern login-shell` )
Expected: PASS.

### Task 2: Move chat's desktop-control integration test into desktop

**Files:**
- Delete: `packages/chat/src/desktop-control-integration.test.ts`
- Create: `packages/desktop/src/main/im-gateway-control-integration.test.ts`

- [x] **Step 1: Create the test in desktop with package-boundary imports**

Content = old file with imports rewritten:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayControlServer } from "./im-gateway-control-server.js";
import {
  DesktopControlClient,
  type DesktopGatewayConfig,
} from "@cjhyy/code-shell-chat/codeshell";
```

Body unchanged (mkdtemp root, GatewayControlServer with open/close/status/pairingUrl fakes, DesktopControlClient status/open/events/close assertions).

First verify the chat `./codeshell` entry actually exports `DesktopControlClient` and `DesktopGatewayConfig` (grep `packages/chat/src/codeshell.ts`); if the type is only in `config.ts`, import it via the same entry if re-exported, else `import type { DesktopGatewayConfig } from "@cjhyy/code-shell-chat/codeshell"` should resolve through the re-export chain.

- [x] **Step 2: Delete the old chat test**

`rm packages/chat/src/desktop-control-integration.test.ts`

- [x] **Step 3: Verify**

Run: `bun test packages/desktop/src/main/im-gateway-control-integration.test.ts`
Expected: PASS (2-way loopback assertions).
Run: `grep -rn "desktop/src" packages/chat/src`
Expected: no output.

### Task 3: Remove core empty dirs and the cron/ back-compat shim

**Files:**
- Delete: `packages/core/src/cron/` (3 shims + 4 test files after moving), empty dirs `cc-orchestrator/ external-agents/ git/ lsp/ quota/ review/`
- Create (moves): `packages/core/src/automation/cron-runtime.test.ts`, `automation/cron-store.test.ts`, `automation/scheduler-persist.test.ts`, `automation/scheduler-noverlap.test.ts`

- [x] **Step 1: Move the four test files into automation/ and rewrite their local imports**

| old import (in cron/*.test.ts) | new import (in automation/*.test.ts) |
|---|---|
| `./scheduler.js` | `./scheduler.js` |
| `./cron-runtime.js` | `./runner.js` |
| `./cron-store.js` | `./store.js` |
| `../tool-system/permission.js` | `../tool-system/permission.js` |

`cron/scheduler.test.ts` → rename to `automation/scheduler-noverlap.test.ts` (avoids implying it is THE scheduler test; automation already has scheduler-*.test.ts siblings).

- [x] **Step 2: Run the moved tests**

Run: `bun test packages/core/src/automation/cron-runtime.test.ts packages/core/src/automation/cron-store.test.ts packages/core/src/automation/scheduler-persist.test.ts packages/core/src/automation/scheduler-noverlap.test.ts`
Expected: PASS.

- [x] **Step 3: Delete cron/ and empty dirs; grep for stragglers**

```bash
rm -rf packages/core/src/cron
rmdir packages/core/src/git/worktree packages/core/src/git packages/core/src/cc-orchestrator packages/core/src/external-agents packages/core/src/lsp packages/core/src/quota packages/core/src/review
grep -rn "src/cron\|/cron/scheduler\|/cron/cron-" packages --include='*.ts' --include='*.tsx' | grep -v dist | grep -v node_modules
```

Expected: grep empty.

- [x] **Step 4: Full automation test suite still green**

Run: `bun test packages/core/src/automation`
Expected: PASS.

### Task 4: Sink InputAttachment* types from protocol/types.ts to root types.ts

**Files:**
- Modify: `packages/core/src/types.ts` (add types), `packages/core/src/protocol/types.ts:100-140` (remove + re-export), `packages/core/src/engine/engine.ts:157`, `engine/input-attachments.ts:5`, `engine/run-image-input.ts:6`, `engine/steer-queue.ts:9`, `engine/run-types.ts:2`

- [x] **Step 1: Move the three types**

Cut from `protocol/types.ts` (lines ~100-140): `InputAttachmentKind`, `InputAttachmentOrigin`, `InputAttachmentMeta` (full interface with vision/directory sub-objects). Paste into `types.ts` (near other cross-layer types, keep doc comments).

In `protocol/types.ts` replace with:

```ts
export type {
  InputAttachmentKind,
  InputAttachmentOrigin,
  InputAttachmentMeta,
} from "../types.js";
```

If `protocol/types.ts` uses these names locally, also add `import type { InputAttachmentMeta } from "../types.js";` above.

- [x] **Step 2: Repoint the five engine imports**

In each engine file listed above: `from "../protocol/types.js"` → `from "../types.js"` (import specifiers unchanged).

- [x] **Step 3: Verify no engine→protocol imports remain, tests green**

```bash
grep -rn "protocol/" packages/core/src/engine --include='*.ts' | grep -v test
```

Expected: no output.
Run: `bun test packages/core/src/engine packages/core/src/protocol`
Expected: PASS (same pass/fail set as before the change — run before AND after if unsure).

### Task 5: Move engine/session-usage.ts → session/usage.ts

**Files:**
- Create: `packages/core/src/session/usage.ts` (content of old file, imports unchanged — same directory depth)
- Delete: `packages/core/src/engine/session-usage.ts`
- Modify importers: `engine/auxiliary-pipeline.ts`, `engine/turn-loop.ts`, `engine/engine.ts`, `engine/types.ts`, `engine/model-facade.ts`, `engine/run-types.ts` (`./session-usage.js` → `../session/usage.js`), `session/session-manager.ts` (`../engine/session-usage.js` → `./usage.js`), `index.extension.ts` (`./engine/session-usage.js` → `./session/usage.js`), plus any hits from `grep -rn "session-usage" packages --include='*.ts' | grep -v dist` (tests included — rewrite them too).

- [x] **Step 1: git mv + rewrite imports** (as above)
- [x] **Step 2: Verify**

```bash
grep -rn "session-usage" packages --include='*.ts' --include='*.tsx' | grep -v dist
```

Expected: no output.
Run: `bun test packages/core/src/session packages/core/src/engine`
Expected: PASS.

### Task 6: Move engine/goal.ts → goal/lifecycle.ts (new top-level module)

`goal.ts` (713 lines) imports only `node:crypto` and is referenced by root `types.ts`, `index.ts`, protocol (client/types/server/chat-session), hooks (goal-stop-hook/events), session-manager, engine — a cross-cutting domain primitive that must sit below all of them.

**Files:**
- Create: `packages/core/src/goal/lifecycle.ts` (verbatim content of `engine/goal.ts`)
- Delete: `packages/core/src/engine/goal.ts`
- Modify: every `engine/goal.js` / `./goal.js` importer. Enumerate with `grep -rn "engine/goal\|\./goal\.js" packages --include='*.ts' | grep -v dist` and rewrite:
  - from `packages/core/src/<dir>/x.ts` → `../goal/lifecycle.js`
  - from `packages/core/src/types.ts` and `index.ts` → `./goal/lifecycle.js`
  - engine-internal `./goal.js` → `../goal/lifecycle.js`
  - test files: same rewrite.

- [x] **Step 1: git mv + rewrite all importers**
- [x] **Step 2: Verify**

```bash
grep -rn "engine/goal" packages --include='*.ts' --include='*.tsx' | grep -v dist
```

Expected: no output.
Run: `bun test packages/core/src/hooks packages/core/src/session packages/core/src/protocol packages/core/src/engine`
Expected: PASS.

### Task 7: Move settings/disk-defaults.ts → engine/disk-defaults.ts

Engine is its only consumer (`engine/engine.ts`, `engine/types.ts`); this kills the settings→engine type dependency.

**Files:**
- Create: `packages/core/src/engine/disk-defaults.ts` — old content with relative imports rewritten: `./schema.js` → `../settings/schema.js`, `../engine/types.js` → `./types.js`, `./personalization.js` → `../settings/personalization.js`, `../plugins/installer/loadPluginMcp.js` unchanged.
- Delete: `packages/core/src/settings/disk-defaults.ts`
- Modify: `engine/engine.ts`, `engine/types.ts` (`../settings/disk-defaults.js` → `./disk-defaults.js`), plus test/index hits from `grep -rn "disk-defaults" packages --include='*.ts' | grep -v dist`.

- [x] **Step 1: Move + rewrite** (as above)
- [x] **Step 2: Verify layering + tests**

```bash
grep -rn "engine/" packages/core/src/settings --include='*.ts' | grep -v test
```

Expected: no output (settings no longer references engine).
Run: `bun test packages/core/src/settings packages/core/src/engine`
Expected: PASS.

### Task 8: Final sweep

- [x] **Step 1: Layering assertions**

```bash
grep -rn "protocol/" packages/core/src/engine --include='*.ts' | grep -v test          # expect empty
grep -rn "\.\./engine/" packages/core/src/session packages/core/src/settings --include='*.ts' | grep -v test   # expect empty
```

- [x] **Step 2: Broad test pass**

Run: `bun test packages/core`
Expected: same failure set as a pre-change baseline run (record baseline BEFORE starting Task 1: `bun test packages/core 2>&1 | tail -5`).

- [x] **Step 3: Rollback point**

`git stash create` → record SHA in the session scratchpad.
