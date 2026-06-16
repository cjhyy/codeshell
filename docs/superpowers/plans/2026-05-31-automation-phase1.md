# Automation Phase 1 — Extract `automation/` module + Electron in-process host (read-only loop)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the scheduling/execution/storage logic into a zero-environment-dependency core module exposing `startAutomation()`, and load it in-process from Electron main so a scheduled read-only job actually runs on the desktop.

**Architecture:** Re-home the existing `core/src/cron/` files under `core/src/automation/` and add a thin `index.ts` facade `startAutomation(deps)` that wires an injected runner to the scheduler. The module imports nothing from Electron/Ink and assumes no GUI/TTY — all environment-bound dependencies are injected. Electron `main/index.ts` calls `startAutomation()` once at app-ready with a runner that spins up a one-shot read-only headless Engine per fired job (reusing the existing `bindCronToEngine` read-only contract). RunManager-based execution and calendar cron are explicitly **out of scope** for Phase 1 (Phase 2).

**Tech Stack:** TypeScript, bun test (`bun:test`), Electron main process, existing `CronScheduler`/`CronStore`/`bindCronToEngine` (this session's work), `Engine` from `@cjhyy/code-shell-core`.

---

## Scope (Phase 1 only)

In scope:
- New `core/src/automation/` module: `scheduler.ts`, `store.ts`, `runner.ts`, `index.ts` (re-homed from `cron/` + a facade).
- `startAutomation(deps) → { scheduler, stop() }` facade with dependency injection.
- A "zero Electron/Ink import" guard test.
- Electron `main/index.ts` loads it in-process at app-ready with a read-only Engine runner.
- Backward-compat: keep `cron/*` re-exporting from `automation/*` so existing imports (`tool-system/builtin/cron.ts`, `index.ts` exports, repl.ts) don't break.

Out of scope (later phases): calendar cron expressions + timezone (Phase 2), RunManager execution + run history (Phase 2), desktop UI (Phase 3), sandbox (Phase 4), write-type/worktree/PR (Phase 5), network server (Phase 6).

---

## File Structure

- Create: `packages/core/src/automation/scheduler.ts` — moved from `cron/scheduler.ts` (CronScheduler + cronScheduler singleton + CronJob + parseSchedule).
- Create: `packages/core/src/automation/store.ts` — moved from `cron/cron-store.ts` (CronStore + defaultCronStorePath).
- Create: `packages/core/src/automation/runner.ts` — moved from `cron/cron-runtime.ts` (bindCronToEngine + CronRunner types).
- Create: `packages/core/src/automation/index.ts` — NEW facade `startAutomation()` + re-exports.
- Create: `packages/core/src/automation/start-automation.test.ts` — NEW facade tests.
- Create: `packages/core/src/automation/no-host-deps.test.ts` — NEW zero-env-dependency guard.
- Modify: `packages/core/src/cron/scheduler.ts` → becomes a re-export shim of `../automation/scheduler.js`.
- Modify: `packages/core/src/cron/cron-store.ts` → re-export shim of `../automation/store.js`.
- Modify: `packages/core/src/cron/cron-runtime.ts` → re-export shim of `../automation/runner.js`.
- Move: the four `cron/*.test.ts` files stay where they are (they import via `./scheduler.js` etc., which still resolve through the shims) — no change needed.
- Modify: `packages/core/src/index.ts` — add `startAutomation` export.
- Modify: `packages/desktop/src/main/index.ts` — call `startAutomation()` at app-ready.
- Create: `packages/desktop/src/main/automation-host.ts` — builds the read-only Engine runner for the desktop host.

---

### Task 1: Move cron files into `automation/` (verbatim, no behavior change)

**Files:**
- Create: `packages/core/src/automation/scheduler.ts`
- Create: `packages/core/src/automation/store.ts`
- Create: `packages/core/src/automation/runner.ts`

- [ ] **Step 1: Copy the three files into the new directory, fixing the one internal import**

Run these copies, then fix `runner.ts`'s import of the store/scheduler (they are now siblings — paths unchanged since both move together):

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
mkdir -p packages/core/src/automation
git mv packages/core/src/cron/scheduler.ts packages/core/src/automation/scheduler.ts
git mv packages/core/src/cron/cron-store.ts packages/core/src/automation/store.ts
git mv packages/core/src/cron/cron-runtime.ts packages/core/src/automation/runner.ts
```

`scheduler.ts` imports `./cron-store.js` for the `CronStore` type — update it to `./store.js`. `runner.ts` imports `./scheduler.js` (unchanged) and `../tool-system/permission.js` (unchanged). No other edits.

- [ ] **Step 2: Fix the renamed import in `automation/scheduler.ts`**

In `packages/core/src/automation/scheduler.ts`, change:

```ts
import type { CronStore } from "./cron-store.js";
```

to:

```ts
import type { CronStore } from "./store.js";
```

- [ ] **Step 3: Verify the moved files typecheck**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bunx tsc --noEmit 2>&1 | head -20`
Expected: errors only about `cron/scheduler.js` / `cron/cron-store.js` / `cron/cron-runtime.js` no longer existing (consumers still point at old paths). These are fixed in Task 2. No errors inside `automation/`.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/automation/ packages/core/src/cron/
git commit -m "refactor(automation): move cron module files under automation/"
```

---

### Task 2: Add backward-compat re-export shims at the old `cron/` paths

**Files:**
- Create: `packages/core/src/cron/scheduler.ts`
- Create: `packages/core/src/cron/cron-store.ts`
- Create: `packages/core/src/cron/cron-runtime.ts`

These keep existing importers (`tool-system/builtin/cron.ts`, `index.ts`, `tui/repl.ts`, and the four moved test files that still live in `cron/`) working without edits.

- [ ] **Step 1: Create `cron/scheduler.ts` shim**

```ts
/**
 * Back-compat shim. The cron scheduler moved to `automation/scheduler.ts`
 * (see docs/archive/automation-plan-2026-05-31.md). This re-export keeps existing
 * `../cron/scheduler.js` importers working. New code should import from
 * `../automation/scheduler.js`.
 */
export * from "../automation/scheduler.js";
```

- [ ] **Step 2: Create `cron/cron-store.ts` shim**

```ts
/** Back-compat shim — moved to `automation/store.ts`. */
export * from "../automation/store.js";
```

- [ ] **Step 3: Create `cron/cron-runtime.ts` shim**

```ts
/** Back-compat shim — moved to `automation/runner.ts`. */
export * from "../automation/runner.js";
```

- [ ] **Step 4: Run the existing cron tests (they import via the shims) and typecheck**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun test packages/core/src/cron/ 2>&1 | tail -8`
Expected: `13 pass, 0 fail` (3 scheduler + 5 store + 5 persist + cron-runtime's 4 — note cron-runtime.test.ts imports `./cron-runtime.js` which is now the shim; all still resolve).

Run: `bunx tsc --noEmit 2>&1 | head -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cron/
git commit -m "refactor(automation): keep cron/ re-export shims for back-compat"
```

---

### Task 3: Write the failing test for `startAutomation()` facade

**Files:**
- Create: `packages/core/src/automation/start-automation.test.ts`

The facade wires an injected runner to a scheduler with an injected store, loads persisted jobs, and returns a handle with `stop()`. It must NOT create its own store/engine — everything is injected so the same module works in any host.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAutomation } from "./index.js";
import { CronStore } from "./store.js";
import type { CronRunRequest } from "./runner.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "start-automation-"));
  file = join(dir, "cron.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("startAutomation", () => {
  test("returns a handle with a scheduler and stop()", () => {
    const store = new CronStore(file);
    const handle = startAutomation({ store, runner: async () => ({ text: "", reason: "completed" }) });
    expect(typeof handle.stop).toBe("function");
    expect(handle.scheduler).toBeDefined();
    handle.stop();
  });

  test("a created job fires the injected runner with the read-only contract", async () => {
    const store = new CronStore(file);
    const calls: CronRunRequest[] = [];
    const handle = startAutomation({
      store,
      runner: async (req) => {
        calls.push(req);
        return { text: "ok", reason: "completed" };
      },
    });
    handle.scheduler.create("nightly", "20", "summarize repo"); // 20ms interval
    await sleep(60);
    handle.stop();
    await sleep(10);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].prompt).toBe("summarize repo");
    expect(calls[0].permissionMode).toBe("default");
  });

  test("loads persisted jobs on start (restart survival)", () => {
    // First lifetime: persist a job, then stop.
    const a = startAutomation({ store: new CronStore(file), runner: async () => ({ text: "", reason: "completed" }) });
    const job = a.scheduler.create("persisted", "1h", "p");
    a.stop();
    // Second lifetime: a fresh facade over the same store restores it.
    const b = startAutomation({ store: new CronStore(file), runner: async () => ({ text: "", reason: "completed" }) });
    expect(b.scheduler.get(job.id)?.name).toBe("persisted");
    b.stop();
  });

  test("stop() halts all timers (no further runner calls)", async () => {
    const store = new CronStore(file);
    let count = 0;
    const handle = startAutomation({ store, runner: async () => { count++; return { text: "", reason: "completed" }; } });
    handle.scheduler.create("x", "20", "p");
    await sleep(50);
    handle.stop();
    const after = count;
    await sleep(60);
    expect(count).toBe(after); // no ticks after stop()
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun test packages/core/src/automation/start-automation.test.ts 2>&1 | tail -10`
Expected: FAIL — `startAutomation` is not exported from `./index.js` (module not found / undefined).

---

### Task 4: Implement the `startAutomation()` facade

**Files:**
- Create: `packages/core/src/automation/index.ts`

- [ ] **Step 1: Write the facade**

```ts
/**
 * automation/ — zero-environment-dependency scheduling module.
 *
 * Hosts (Electron main, future CLI server) load this module and inject their
 * own store + runner. The module imports nothing from Electron/Ink and makes
 * no GUI/TTY assumptions, so the same code runs in any host
 * (docs/archive/automation-plan-2026-05-31.md, D1).
 */

import { CronScheduler } from "./scheduler.js";
import { bindCronToEngine, type CronRunner } from "./runner.js";
import type { CronStore } from "./store.js";

export interface StartAutomationDeps {
  /** Persistence backend (injected; module never picks a path itself). */
  store: CronStore;
  /** Run backend invoked when a job fires (injected by the host). */
  runner: CronRunner;
}

export interface AutomationHandle {
  scheduler: CronScheduler;
  /** Halt all timers and release the scheduler. Idempotent. */
  stop(): void;
}

/**
 * Wire a scheduler to a host-provided store + runner and restore persisted
 * jobs. Returns a handle the host keeps for its lifetime.
 */
export function startAutomation(deps: StartAutomationDeps): AutomationHandle {
  const scheduler = new CronScheduler(deps.store);
  bindCronToEngine(scheduler, deps.runner);
  scheduler.loadJobs();
  return {
    scheduler,
    stop: () => scheduler.stopAll(),
  };
}

// Re-export the building blocks so hosts import everything from one place.
export { CronScheduler, cronScheduler, type CronJob } from "./scheduler.js";
export { CronStore, defaultCronStorePath } from "./store.js";
export {
  bindCronToEngine,
  type CronRunner,
  type CronRunRequest,
  type CronRunResult,
} from "./runner.js";
```

- [ ] **Step 2: Run the facade test to verify it passes**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun test packages/core/src/automation/start-automation.test.ts 2>&1 | tail -10`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/automation/index.ts packages/core/src/automation/start-automation.test.ts
git commit -m "feat(automation): startAutomation() facade with injected store + runner"
```

---

### Task 5: Add the "zero host-dependency" guard test

**Files:**
- Create: `packages/core/src/automation/no-host-deps.test.ts`

This locks in D1's rule: the module must never import Electron or Ink, or assume a GUI/TTY. A static scan of the module's source files is enough and runs fast.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Forbidden host-coupling import substrings. The automation module must load
// in a headless server with no Electron/Ink present.
const FORBIDDEN = ["electron", "ink", "react", "@cjhyy/code-shell-tui"];

function sourceFiles(): string[] {
  return readdirSync(here)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(here, f));
}

describe("automation module is host-agnostic", () => {
  test("no source file imports Electron/Ink/React", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf-8");
      // Only inspect import/require lines.
      const importLines = src
        .split("\n")
        .filter((l) => /\b(import|require)\b/.test(l));
      for (const line of importLines) {
        for (const bad of FORBIDDEN) {
          if (line.includes(`"${bad}`) || line.includes(`'${bad}`) || line.includes(`/${bad}`)) {
            offenders.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it passes immediately (the module is already clean)**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun test packages/core/src/automation/no-host-deps.test.ts 2>&1 | tail -8`
Expected: PASS (1 test). It passes now; it exists to FAIL if someone later adds a forbidden import.

> Note: this is a guard test, not red-green. It documents and enforces an invariant. If it fails now, a forbidden import already exists — fix the import, not the test.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/automation/no-host-deps.test.ts
git commit -m "test(automation): guard against Electron/Ink imports in the module"
```

---

### Task 6: Export `startAutomation` from core's public index

**Files:**
- Modify: `packages/core/src/index.ts` (the cron export block near line 536)

- [ ] **Step 1: Add the automation facade export**

Find this block in `packages/core/src/index.ts`:

```ts
export { CronScheduler, cronScheduler, type CronJob } from "./cron/scheduler.js";
export { CronStore, defaultCronStorePath } from "./cron/cron-store.js";
export {
  bindCronToEngine,
  type CronRunner,
  type CronRunRequest,
  type CronRunResult,
} from "./cron/cron-runtime.js";
```

Replace it with (point at the new module; add the facade):

```ts
export {
  startAutomation,
  type StartAutomationDeps,
  type AutomationHandle,
  CronScheduler,
  cronScheduler,
  type CronJob,
  CronStore,
  defaultCronStorePath,
  bindCronToEngine,
  type CronRunner,
  type CronRunRequest,
  type CronRunResult,
} from "./automation/index.js";
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bunx tsc --noEmit 2>&1 | head -20`
Expected: no errors.

- [ ] **Step 3: Rebuild core so dist carries the new export (TUI/desktop resolve core via dist)**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun run --filter '@cjhyy/code-shell-core' build 2>&1 | tail -3`
Expected: `Exited with code 0`.

Run: `grep -c "startAutomation" packages/core/dist/index.d.ts`
Expected: `1` (or more).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(automation): export startAutomation from core index"
```

---

### Task 7: Build the desktop read-only Engine runner

**Files:**
- Create: `packages/desktop/src/main/automation-host.ts`

This builds a `CronRunner` for the desktop host: each fired job runs a one-shot headless `Engine` with the read-only contract supplied by `bindCronToEngine` (the request already carries `permissionMode: "default"` + a read-only `approvalBackend`). It mirrors the runner already wired in `tui/src/cli/commands/repl.ts`, but reads settings the way desktop's other services do.

- [ ] **Step 1: Write the runner factory**

```ts
/**
 * Desktop automation host — builds the read-only Engine runner that fired
 * cron jobs execute through. Phase 1 runs a one-shot headless Engine per job
 * (read-only: bindCronToEngine supplies permissionMode "default" + a read-only
 * approval backend). Phase 2 will replace this with RunManager.submit().
 */

import {
  Engine,
  SettingsManager,
  type CronRunner,
  type CronRunResult,
} from "@cjhyy/code-shell-core";

/** Build a CronRunner that runs each job as a one-shot read-only headless Engine. */
export function buildDesktopAutomationRunner(): CronRunner {
  return async (req): Promise<CronRunResult> => {
    const jobCwd = req.job.cwd ?? process.cwd();
    const settings = new SettingsManager(jobCwd, "full").get();
    const engine = new Engine({
      llm: {
        provider: settings.model.provider,
        model: settings.model.name,
        apiKey: settings.model.apiKey ?? "",
        baseUrl: settings.model.baseUrl,
        maxTokens: settings.model.maxTokens,
      },
      cwd: jobCwd,
      settingsScope: "full",
      headless: true,
      // Read-only contract from bindCronToEngine — cron is unattended.
      permissionMode: req.permissionMode,
      approvalBackend: req.approvalBackend,
    });
    const result = await engine.run(req.prompt, { cwd: jobCwd });
    return { text: result.text, reason: result.reason };
  };
}
```

> Note on `req.job.cwd`: `CronJob` does not yet have a `cwd` field (added in Phase 2). For Phase 1 it is `undefined`, so the runner falls back to `process.cwd()`. The `?? process.cwd()` keeps this forward-compatible without depending on Phase 2.

- [ ] **Step 2: Typecheck desktop**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop && bunx tsc --noEmit 2>&1 | head -20`
Expected: error that `CronJob.cwd` does not exist (because Phase 1 hasn't added it).

- [ ] **Step 3: Make the `cwd` access forward-compatible without the field**

Since `CronJob` has no `cwd` yet, accessing `req.job.cwd` errors under strict types. Change the access to read it defensively:

```ts
const jobCwd = (req.job as { cwd?: string }).cwd ?? process.cwd();
```

Re-run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop && bunx tsc --noEmit 2>&1 | head -20`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/main/automation-host.ts
git commit -m "feat(desktop): read-only Engine runner for automation host"
```

---

### Task 8: Load `startAutomation()` in Electron main at app-ready

**Files:**
- Modify: `packages/desktop/src/main/index.ts` (imports + the `app.whenReady().then(...)` block near line 246)

- [ ] **Step 1: Add imports near the other `@cjhyy/code-shell-core` imports**

Add to `packages/desktop/src/main/index.ts`:

```ts
import { startAutomation, CronStore, defaultCronStorePath, type AutomationHandle } from "@cjhyy/code-shell-core";
import { buildDesktopAutomationRunner } from "./automation-host.js";
```

- [ ] **Step 2: Add a module-level handle and start it inside `app.whenReady`**

Add a module-scoped variable near the top-level state of the file:

```ts
let automationHandle: AutomationHandle | null = null;
```

Inside the existing `app.whenReady().then(() => { ... })` block, after `void createWindow();`, add:

```ts
  // Automation: load the in-process scheduler (read-only jobs). Persisted
  // jobs are restored from ~/.code-shell/cron.json. Cron follows the app
  // lifecycle by design (docs/archive/automation-plan-2026-05-31.md, D2).
  try {
    automationHandle = startAutomation({
      store: new CronStore(defaultCronStorePath()),
      runner: buildDesktopAutomationRunner(),
    });
  } catch (err) {
    // Automation is non-critical to the GUI — never block startup on it.
    console.error("automation: failed to start", err);
  }
```

- [ ] **Step 3: Stop it on quit**

Find the existing quit handling (search for `app.on("before-quit"` or `app.on("window-all-closed"` in the file). If a `before-quit` handler exists, add `automationHandle?.stop();` inside it. If none exists, add:

```ts
app.on("before-quit", () => {
  automationHandle?.stop();
  automationHandle = null;
});
```

- [ ] **Step 4: Typecheck desktop**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop && bunx tsc --noEmit 2>&1 | head -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Documents/个人学习/代码学习/codeshell
git add packages/desktop/src/main/index.ts
git commit -m "feat(desktop): start automation scheduler in-process at app-ready"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run the full core test suite**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun test packages/core 2>&1 | tail -8`
Expected: all pass, 0 fail (255 prior + 5 new automation tests ≈ 260).

- [ ] **Step 2: Typecheck core + tui (root) and desktop**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bunx tsc --noEmit 2>&1 | head; echo "---desktop---"; cd packages/desktop && bunx tsc --noEmit 2>&1 | head`
Expected: no errors from either.

- [ ] **Step 3: Lint the changed files**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun run lint 2>&1 | grep -E "automation|automation-host" ; echo "exit: ${PIPESTATUS[0]}"`
Expected: no errors in the new files (warnings tolerated only if pre-existing pattern).

- [ ] **Step 4: Verify the shim didn't break existing cron consumers**

Run: `cd /Users/admin/Documents/个人学习/代码学习/codeshell && bun test packages/core/src/cron/ packages/core/src/automation/ 2>&1 | tail -8`
Expected: all pass (cron shims + automation module).

- [ ] **Step 5: Final commit if any cleanup remains**

```bash
git status --short
# Only commit automation/desktop files you changed; do NOT commit others' WIP.
```

---

## Self-Review

**1. Spec coverage (Phase 1 portion of the plan):**
- D1 "zero-env-dependency module + startAutomation()" → Tasks 3-5 (facade + guard test). ✓
- D1 "dependency injection (store + runner)" → `StartAutomationDeps` in Task 4. ✓
- D2 "Electron main loads in-process at app-ready, follows app lifecycle" → Tasks 7-8. ✓
- "reinstate CronScheduler/CronStore/bindCronToEngine, relocated under automation/" → Tasks 1-2. ✓
- "read-only default (permissionMode default + read-only approvalBackend)" → Task 7 uses `req.permissionMode`/`req.approvalBackend` from `bindCronToEngine`. ✓
- Deferred correctly: calendar cron (Phase 2), RunManager (Phase 2), `CronJob.cwd` (Phase 2 — Task 7 reads it defensively), UI (Phase 3). ✓

**2. Placeholder scan:** No TBD/TODO-as-instruction; every code step has full code; commands have expected output. ✓

**3. Type consistency:** `startAutomation`/`StartAutomationDeps`/`AutomationHandle` defined in Task 4 and used identically in Tasks 6, 8. `CronRunner`/`CronRunRequest`/`CronRunResult` come from the moved `runner.ts` (Task 1) and re-exported in Task 4/6. `buildDesktopAutomationRunner` defined Task 7, used Task 8. `automationHandle` typed `AutomationHandle | null` consistently in Task 8. ✓

**4. Known forward-compat seam:** `req.job.cwd` doesn't exist until Phase 2; Task 7 Step 3 reads it via `(req.job as { cwd?: string }).cwd ?? process.cwd()` so Phase 1 compiles and Phase 2 can add the field without touching the runner. ✓
