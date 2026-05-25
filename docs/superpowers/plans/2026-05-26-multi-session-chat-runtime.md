# Multi-Session Chat Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-flag `protocol/server.ts` chat run path with a per-`sessionId` `ChatSessionManager`, so the Electron client can run multiple chat tabs in parallel and same-session sends queue instead of vanishing.

**Architecture:** New `ChatSessionManager` (each session = one `Engine` instance over a shared `EngineRuntime`). `AgentServer` becomes a thin dispatcher over `ChatSessionManager` (for `agent/*`) and the existing `RunManager` (for `run/*`). Module-level `setRuntimeBypass`/`setInPlanMode` singletons move to per-`Engine` instance fields surfaced through `ToolContext`. Renderer routes by `sessionId` from the wire envelope instead of a single `runningBucketRef`. TUI uses one fixed sessionId — degenerate case, no UI change.

**Tech Stack:** TypeScript (Node 22 + Electron 33), Bun for builds/tests, in-process JSON-RPC transport in tests.

**Spec:** `docs/superpowers/specs/2026-05-26-multi-session-chat-runtime-design.md`

---

## File Structure

### New files (core)
- `packages/core/src/engine/runtime.ts` — `EngineRuntime` class holding shared read-only resources (model pool, tool registry, settings, MCP pool, cost tracker).
- `packages/core/src/protocol/chat-session.ts` — `ChatSession` class: owns one `Engine`, one `AbortController`, per-session FIFO turn queue, per-session pending approvals.
- `packages/core/src/protocol/chat-session-manager.ts` — `ChatSessionManager`: `Map<sessionId, ChatSession>`, `getOrCreate`, `close`, `closeAll`, idle eviction, global ceiling.

### New tests (core)
- `tests/engine-runtime.test.ts` — runtime is shared, per-engine fields are isolated.
- `tests/chat-session-manager.test.ts` — get/close/idle/ceiling.
- `tests/chat-session-queue.test.ts` — same-session FIFO.
- `tests/protocol/multi-session.test.ts` — end-to-end through `AgentServer` over in-process transport.

### Modified files (core)
- `packages/core/src/tool-system/context.ts` — add `planMode: boolean` field next to existing `permissionMode`.
- `packages/core/src/tool-system/permission.ts` — delete `runtimeBypass` module let + `setRuntimeBypass`/`isRuntimeBypass` exports; all reads through `ToolContext.permissionMode`.
- `packages/core/src/tool-system/builtin/plan.ts` — delete module-level state + `setInPlanMode`/`isInPlanMode` exports; reads through `ToolContext.planMode`.
- `packages/core/src/tool-system/executor.ts:90` — replace `isInPlanMode()` with `ctx.planMode`.
- `packages/core/src/tool-system/builtin/agent.ts:123` — subagent inherits `planMode` from parent context, not from module state.
- `packages/core/src/engine/engine.ts` — accept `runtime: EngineRuntime` in constructor; `permissionMode`/`planMode`/`askUser` become instance fields; `engine.ts:897 isInPlanMode()` → `this.planMode`; subagent spawn at `engine.ts:473` reuses `this.runtime`.
- `packages/core/src/protocol/types.ts` — wire format additions: every notification carries `sessionId`; add `agent/closeSession`; add `Overloaded -32001` and `SessionClosed -32004`; remove `AlreadyRunning -32003`.
- `packages/core/src/protocol/server.ts` — replace single-flag `handleRun` with dispatch through `ChatSessionManager`; `handleApprove`/`handleCancel`/`handleConfigure` route by `sessionId`; add `handleCloseSession`; delete `this.running`/`this.abortController`/server-level `pendingApprovals`.
- `packages/core/src/cli/agent-server-stdio.ts` — build `EngineRuntime` + `ChatSessionManager`, wire into `AgentServer`.

### Modified files (TUI)
- `packages/tui/src/cli/commands/repl.ts` — build `EngineRuntime` + `ChatSessionManager`, use fixed sessionId `"tui-main"`.
- `packages/tui/src/cli/commands/run.ts` — same restructuring.

### Modified files (desktop)
- `packages/desktop/src/preload/index.ts` — `run/cancel/approve` take `sessionId`; stream-listener API delivers `{ sessionId, event }`.
- `packages/desktop/src/preload/types.d.ts` — match preload API.
- `packages/desktop/src/renderer/App.tsx` — delete `runningBucketRef`; add `sessionIdToBucket: Map<string, BucketId>` + `busyBySession: Map<string, boolean>`; stream handler routes by envelope `sessionId`.

### Modified tests
- `tests/protocol/agent-server.test.ts` — new wire shape: requires sessionId on `agent/run`.
- `tests/protocol/in-process-client-drift.test.ts` — same.

---

## Task 1: `EngineRuntime` skeleton + test

**Files:**
- Create: `packages/core/src/engine/runtime.ts`
- Test: `tests/engine-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine-runtime.test.ts
import { describe, it, expect } from "bun:test";
import { EngineRuntime } from "../packages/core/src/engine/runtime.ts";
import { ModelPool } from "../packages/core/src/llm/model-pool.ts";

describe("EngineRuntime", () => {
  it("exposes shared resources passed in at construction", () => {
    const modelPool = {} as ModelPool;
    const rt = new EngineRuntime({ modelPool });
    expect(rt.modelPool).toBe(modelPool);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails with "Cannot find module"**

Run: `bun test tests/engine-runtime.test.ts -t "exposes shared resources"`
Expected: FAIL — "Cannot find module .../runtime.ts"

- [ ] **Step 3: Create the minimal `EngineRuntime`**

```ts
// packages/core/src/engine/runtime.ts
import type { ModelPool } from "../llm/model-pool.js";

export interface EngineRuntimeOptions {
  modelPool: ModelPool;
}

/**
 * Shared read-only resources used by all Engine instances in a worker.
 * Mutable per-session state stays on Engine itself.
 */
export class EngineRuntime {
  readonly modelPool: ModelPool;

  constructor(opts: EngineRuntimeOptions) {
    this.modelPool = opts.modelPool;
  }
}
```

- [ ] **Step 4: Run the test, confirm PASS**

Run: `bun test tests/engine-runtime.test.ts`
Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/runtime.ts tests/engine-runtime.test.ts
git commit -m "feat(core/engine): add EngineRuntime skeleton for shared resources"
```

---

## Task 2: Grow `EngineRuntime` to hold every shared resource Engine currently constructs internally

**Files:**
- Modify: `packages/core/src/engine/runtime.ts`
- Test: `tests/engine-runtime.test.ts`

**Context:** Skim `packages/core/src/engine/engine.ts` constructor for things that today are built once per `Engine` but could be shared: tool registry, settings store, MCP connection pool, cost tracker. Add each as a field on `EngineRuntime`.

- [ ] **Step 1: Add failing tests for the extra fields**

```ts
// tests/engine-runtime.test.ts — append
it("holds toolRegistry, settings, mcpPool, costTracker", () => {
  const modelPool = {} as any;
  const toolRegistry = {} as any;
  const settings = {} as any;
  const mcpPool = {} as any;
  const costTracker = {} as any;
  const rt = new EngineRuntime({ modelPool, toolRegistry, settings, mcpPool, costTracker });
  expect(rt.toolRegistry).toBe(toolRegistry);
  expect(rt.settings).toBe(settings);
  expect(rt.mcpPool).toBe(mcpPool);
  expect(rt.costTracker).toBe(costTracker);
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `bun test tests/engine-runtime.test.ts -t "holds toolRegistry"`
Expected: FAIL — fields are undefined.

- [ ] **Step 3: Extend `EngineRuntime`**

```ts
// packages/core/src/engine/runtime.ts
import type { ModelPool } from "../llm/model-pool.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { SettingsStore } from "../config/settings-store.js";
import type { McpManager } from "../tool-system/mcp-manager.js";
import type { CostStore } from "./cost-store.js";

export interface EngineRuntimeOptions {
  modelPool: ModelPool;
  toolRegistry: ToolRegistry;
  settings: SettingsStore;
  mcpPool: McpManager;
  costTracker: CostStore;
}

export class EngineRuntime {
  readonly modelPool: ModelPool;
  readonly toolRegistry: ToolRegistry;
  readonly settings: SettingsStore;
  readonly mcpPool: McpManager;
  readonly costTracker: CostStore;

  constructor(opts: EngineRuntimeOptions) {
    this.modelPool = opts.modelPool;
    this.toolRegistry = opts.toolRegistry;
    this.settings = opts.settings;
    this.mcpPool = opts.mcpPool;
    this.costTracker = opts.costTracker;
  }
}
```

> Note: if any of those imports do not exist at the cited paths, grep the codebase for the actual exported names (e.g. `grep -rn "export class SettingsStore" packages/core/src`) and update the import — but keep the field name in the spec (`settings`, `mcpPool`, `costTracker`, `toolRegistry`).

- [ ] **Step 4: Run, confirm PASS**

Run: `bun test tests/engine-runtime.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/runtime.ts tests/engine-runtime.test.ts
git commit -m "feat(core/engine): grow EngineRuntime with toolRegistry/settings/mcpPool/costTracker"
```

---

## Task 3: Add `planMode` to `ToolContext`

**Files:**
- Modify: `packages/core/src/tool-system/context.ts`
- Test: `tests/tool-context.test.ts` (likely exists; if not, create)

- [ ] **Step 1: Write the failing test**

```ts
// tests/tool-context.test.ts — add or append
import { describe, it, expect } from "bun:test";
import type { ToolContext } from "../packages/core/src/tool-system/context.ts";

describe("ToolContext", () => {
  it("carries planMode flag", () => {
    const ctx: Partial<ToolContext> = { planMode: true };
    expect(ctx.planMode).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL (type error or undefined property)**

Run: `bun test tests/tool-context.test.ts -t "carries planMode"`
Expected: FAIL — TS compile error "Object literal may only specify known properties" or runtime undefined.

- [ ] **Step 3: Edit `context.ts` to add `planMode`**

Find the existing `ToolContext` interface (around line 82 where `permissionMode` lives) and add:

```ts
// packages/core/src/tool-system/context.ts (excerpt)
export interface ToolContext {
  // ... existing fields
  permissionMode: string;
  /** Whether the owning Engine is currently in plan mode. Replaces the
   *  removed module-level `isInPlanMode()` singleton. */
  planMode: boolean;
  // ... rest
}
```

- [ ] **Step 4: Run, confirm PASS**

Run: `bun test tests/tool-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tool-system/context.ts tests/tool-context.test.ts
git commit -m "feat(core/tool-context): add planMode field"
```

---

## Task 4: Delete plan-mode module singleton, route through ToolContext

**Files:**
- Modify: `packages/core/src/tool-system/builtin/plan.ts`
- Modify: `packages/core/src/tool-system/executor.ts:90`
- Modify: `packages/core/src/tool-system/builtin/agent.ts:123`
- Modify: `packages/core/src/engine/engine.ts:897`
- Test: existing executor/plan tests + new isolation test

**Context:** Verify current call sites first:
```
grep -rn "isInPlanMode\|setInPlanMode\|resetPlanMode\|restorePlanMode" \
  packages/core/src --include='*.ts'
```
You should see exactly the sites listed above. If extra sites exist, port them too.

- [ ] **Step 1: Write the failing isolation test**

```ts
// tests/plan-mode-isolation.test.ts
import { describe, it, expect } from "bun:test";

describe("plan mode isolation", () => {
  it("two ToolContexts can carry different planMode values", () => {
    // After refactor: there is no global getter. Each engine surfaces its own.
    const ctxA = { planMode: true } as any;
    const ctxB = { planMode: false } as any;
    expect(ctxA.planMode).toBe(true);
    expect(ctxB.planMode).toBe(false);
  });

  it("plan.ts no longer exports setInPlanMode/isInPlanMode", async () => {
    const mod: any = await import("../packages/core/src/tool-system/builtin/plan.ts");
    expect(mod.setInPlanMode).toBeUndefined();
    expect(mod.isInPlanMode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, second test FAILs (exports still present)**

Run: `bun test tests/plan-mode-isolation.test.ts`
Expected: 1 pass, 1 fail ("toBeUndefined").

- [ ] **Step 3: Remove module state from `plan.ts`**

Open `packages/core/src/tool-system/builtin/plan.ts`. Delete the module-level `let` holding plan-mode state and the `setInPlanMode`/`isInPlanMode`/`resetPlanMode`/`restorePlanMode` helpers. The Plan tool itself stays — it now toggles state via its `ToolContext` callback (see Task 7 for engine wiring). Concretely, the file should retain only:
- the `Plan` tool definition (`name`, `description`, `args` schema, `execute`)
- inside `execute`, replace `setInPlanMode(true)` with a call into the engine via `ctx` — if `ctx.engine?.setPlanMode` is not yet wired, add a TODO comment **only inside this step**; Task 7 finalizes the wiring.

If `resetPlanMode`/`restorePlanMode` are imported elsewhere, leave a one-line stub that throws so the build fails loudly until Task 5/7 finish — do NOT silently delete them mid-refactor.

- [ ] **Step 4: Update `executor.ts:90`**

Find:
```ts
import { isInPlanMode } from "./builtin/plan.js";
// ...
if (isInPlanMode()) {
```

Replace with:
```ts
// (remove the import)
if (ctx.planMode) {
```

Use the `ctx` already in scope at line 90.

- [ ] **Step 5: Update `agent.ts:123` (subagent plan inheritance)**

Find:
```ts
import { isInPlanMode, resetPlanMode, restorePlanMode } from "./plan.js";
// ...
const parentWasInPlanMode = isInPlanMode();
```

Subagents should inherit plan-mode from the parent's `ToolContext`. Replace with:
```ts
const parentWasInPlanMode = ctx.planMode;
// `resetPlanMode` / `restorePlanMode` are no longer needed: the child
// Engine receives its own planMode at construction time, and the parent
// Engine's planMode is unaffected.
```

Remove the import.

- [ ] **Step 6: Update `engine.ts:897`**

Find:
```ts
const toolDefs = isInPlanMode()
```

Replace with:
```ts
const toolDefs = this.planMode
```

Remove the import at the top of `engine.ts:47`. (`this.planMode` will be wired up in Task 7; this edit is purely the call-site change.)

- [ ] **Step 7: Run the full core test suite**

Run: `bun test packages/core tests/`
Expected: every test that touched plan-mode now compiles; new isolation test passes.

If a test fails because it called `setInPlanMode` in its own setup, update that test to set `ctx.planMode` directly or to pass `planMode` through `EngineConfig` (which Task 7 will add).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/tool-system/builtin/plan.ts \
        packages/core/src/tool-system/executor.ts \
        packages/core/src/tool-system/builtin/agent.ts \
        packages/core/src/engine/engine.ts \
        tests/plan-mode-isolation.test.ts
git commit -m "refactor(core/plan-mode): remove module singleton, route through ToolContext"
```

---

## Task 5: Delete `setRuntimeBypass`/`isRuntimeBypass` singleton

**Files:**
- Modify: `packages/core/src/tool-system/permission.ts:472-476`
- Modify: `packages/core/src/protocol/server.ts` (drop the two callers — they are obsolete; new server in Task 10 doesn't need them)
- Test: extend `tests/plan-mode-isolation.test.ts`

**Context:** From the grep done in Task 4, the only readers of `isRuntimeBypass` are in `permission.ts` itself (the export) and `protocol/server.ts` (which we are about to rewrite anyway). The current ToolContext already has `permissionMode: string`, so consumers can derive bypass from `ctx.permissionMode === "bypassPermissions"`.

- [ ] **Step 1: Add failing assertion**

```ts
// tests/plan-mode-isolation.test.ts — append
it("permission.ts no longer exports setRuntimeBypass/isRuntimeBypass", async () => {
  const mod: any = await import("../packages/core/src/tool-system/permission.ts");
  expect(mod.setRuntimeBypass).toBeUndefined();
  expect(mod.isRuntimeBypass).toBeUndefined();
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `bun test tests/plan-mode-isolation.test.ts -t "permission.ts no longer"`
Expected: FAIL.

- [ ] **Step 3: Delete the exports**

Open `packages/core/src/tool-system/permission.ts`. Delete the module-level `let runtimeBypass = false;` (or equivalent), and remove the two exported functions `setRuntimeBypass` and `isRuntimeBypass`. If any internal helper in this file reads `runtimeBypass`, replace with a parameter (most likely a function takes a `permissionMode` arg already).

- [ ] **Step 4: Drop the obsolete callers in `server.ts`**

In `packages/core/src/protocol/server.ts`, remove the import line `import { setRuntimeBypass, isRuntimeBypass } from "../tool-system/permission.js";` and both `setRuntimeBypass(...)` invocations on lines 146 and 243. Leave the surrounding logic in place for now — Task 10 rewrites `handleConfigure` properly. If `isRuntimeBypass()` is read anywhere in server.ts, replace with the engine-derived value (we'll surface it via `ChatSession.engine.permissionMode === "bypassPermissions"` in Task 10).

- [ ] **Step 5: Run the test suite**

Run: `bun test packages/core tests/`
Expected: previously-failing test now passes; nothing else regresses.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tool-system/permission.ts \
        packages/core/src/protocol/server.ts \
        tests/plan-mode-isolation.test.ts
git commit -m "refactor(core/permission): remove runtimeBypass module singleton"
```

---

## Task 6: Engine accepts `runtime: EngineRuntime` and instance-level `permissionMode`/`planMode`

**Files:**
- Modify: `packages/core/src/engine/engine.ts`
- Test: `tests/engine-runtime.test.ts`

**Context:** Today `Engine`'s constructor builds its own ModelPool/ToolRegistry/etc. We want it to accept an optional `runtime` param and prefer that over constructing its own. This is the **adapter step** — both call patterns work until Task 11 cleans up call sites.

- [ ] **Step 1: Write failing test**

```ts
// tests/engine-runtime.test.ts — append
it("Engine accepts a shared EngineRuntime via constructor", async () => {
  const { Engine } = await import("../packages/core/src/engine/engine.ts");
  const rt = new EngineRuntime({
    modelPool: {} as any,
    toolRegistry: {} as any,
    settings: {} as any,
    mcpPool: {} as any,
    costTracker: {} as any,
  });
  const e = new Engine({ runtime: rt, cwd: "/tmp", llm: { provider: "noop" } as any });
  expect((e as any).runtime).toBe(rt);
});

it("Engine exposes planMode/permissionMode as instance fields", async () => {
  const { Engine } = await import("../packages/core/src/engine/engine.ts");
  const e = new Engine({ cwd: "/tmp", llm: { provider: "noop" } as any, permissionMode: "plan" });
  expect(e.permissionMode).toBe("plan");
  expect(e.planMode).toBe(true);
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `bun test tests/engine-runtime.test.ts -t "shared EngineRuntime"`
Expected: FAIL (`runtime` is undefined or constructor rejects).

- [ ] **Step 3: Update Engine constructor**

In `packages/core/src/engine/engine.ts`:

a) Add `runtime?: EngineRuntime` to `EngineConfig`.
b) Add `permissionMode` and `planMode` as instance fields:
```ts
   readonly runtime: EngineRuntime | null;
   permissionMode: EngineConfig["permissionMode"];
   planMode: boolean;
```
c) In the constructor:
```ts
this.runtime = config.runtime ?? null;
this.permissionMode = config.permissionMode ?? "acceptEdits";
this.planMode = this.permissionMode === "plan";
```
d) Wherever the existing constructor built its own ModelPool / registry / mcp pool / cost tracker, change to:
```ts
this.modelPool = this.runtime?.modelPool ?? new ModelPool(...);
```
(and similarly for the other three). Keep the fallback `new ModelPool(...)` so existing call sites work unchanged.

e) Add a `setPlanMode(value: boolean)` method on `Engine`:
```ts
setPlanMode(value: boolean): void {
  this.planMode = value;
}
```
This is what the `Plan` tool (Task 4 Step 3) will call through `ctx`.

f) Update `engine.ts:897` (already changed in Task 4 to read `this.planMode`) — verify it compiles now that the field exists.

- [ ] **Step 4: Run the tests, confirm PASS**

Run: `bun test tests/engine-runtime.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/engine.ts tests/engine-runtime.test.ts
git commit -m "feat(core/engine): accept EngineRuntime + instance permissionMode/planMode"
```

---

## Task 7: Engine populates `ToolContext.planMode` and Plan tool calls `engine.setPlanMode`

**Files:**
- Modify: `packages/core/src/engine/engine.ts` (where ToolContext is constructed)
- Modify: `packages/core/src/tool-system/builtin/plan.ts` (Plan tool execute)
- Test: `tests/plan-tool.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// tests/plan-tool.test.ts
import { describe, it, expect } from "bun:test";
import { Engine } from "../packages/core/src/engine/engine.ts";

describe("Plan tool", () => {
  it("toggles engine.planMode through ToolContext", async () => {
    const e = new Engine({ cwd: "/tmp", llm: { provider: "noop" } as any, permissionMode: "default" });
    expect(e.planMode).toBe(false);
    // Simulate Plan tool execution. Engine should pass itself into ctx so
    // the tool can call ctx.engine.setPlanMode(true).
    const ctx = (e as any).buildToolContext();   // helper added by this task
    ctx.engine.setPlanMode(true);
    expect(e.planMode).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `bun test tests/plan-tool.test.ts`
Expected: FAIL — `buildToolContext` undefined.

- [ ] **Step 3: Add `buildToolContext()` (or update existing equivalent) on Engine**

Find where `Engine` constructs a `ToolContext` for tool execution (search for `permissionMode:` inside `engine.ts`). At that point, also set:

```ts
const ctx: ToolContext = {
  // ... existing fields
  permissionMode: this.permissionMode,
  planMode: this.planMode,
  engine: this,   // ← give tools a typed handle back to the owning Engine
};
```

Add `engine: Engine` to `ToolContext` in `packages/core/src/tool-system/context.ts` (next to `planMode` from Task 3). To avoid circular import problems, type it as:

```ts
// context.ts
// (top of file)
import type { Engine } from "../engine/engine.js";   // type-only import is OK
```

If a `buildToolContext()` helper does not exist yet, add one — it's a small method that returns the constructed `ToolContext`, used by both the existing per-turn ctx and the new test.

- [ ] **Step 4: Make Plan tool call into engine**

Open `packages/core/src/tool-system/builtin/plan.ts`. In the `execute` function, replace any TODO (or stub) left from Task 4 with:

```ts
ctx.engine.setPlanMode(true);     // or false, depending on the tool args
```

- [ ] **Step 5: Run, confirm PASS**

Run: `bun test tests/plan-tool.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite — nothing should regress**

Run: `bun test`
Expected: all tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/engine/engine.ts \
        packages/core/src/tool-system/context.ts \
        packages/core/src/tool-system/builtin/plan.ts \
        tests/plan-tool.test.ts
git commit -m "feat(core/engine): wire planMode through ToolContext.engine"
```

---

## Task 8: `ChatSession` class

**Files:**
- Create: `packages/core/src/protocol/chat-session.ts`
- Test: `tests/chat-session-queue.test.ts`

**Spec reference:** §6.3 of the design doc.

- [ ] **Step 1: Write failing tests**

```ts
// tests/chat-session-queue.test.ts
import { describe, it, expect } from "bun:test";
import { ChatSession } from "../packages/core/src/protocol/chat-session.ts";

const fakeEngine: any = {
  run: async (task: string) => {
    // Simulate a slow turn so we can observe queueing.
    await new Promise((r) => setTimeout(r, 30));
    return { text: `done:${task}`, reason: "completed", sessionId: "s1", turnCount: 1, usage: {} };
  },
  permissionMode: "default",
  planMode: false,
};

describe("ChatSession", () => {
  it("runs a single turn", async () => {
    const s = new ChatSession({ id: "s1", engine: fakeEngine });
    const result = await s.enqueueTurn("hello", {});
    expect(result.text).toBe("done:hello");
    expect(s.isBusy()).toBe(false);
  });

  it("serializes turns from the same session", async () => {
    const s = new ChatSession({ id: "s1", engine: fakeEngine });
    const order: string[] = [];
    const a = s.enqueueTurn("a", {}).then((r) => order.push(r.text));
    const b = s.enqueueTurn("b", {}).then((r) => order.push(r.text));
    expect(s.queueDepth()).toBe(1); // a running, b queued
    await Promise.all([a, b]);
    expect(order).toEqual(["done:a", "done:b"]);
  });

  it("cancel aborts in-flight turn", async () => {
    const slowEngine: any = {
      run: async (_task: string, opts: any) => {
        await new Promise((resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(resolve, 5000);
        });
        return { text: "never", reason: "completed", sessionId: "s1", turnCount: 1, usage: {} };
      },
      permissionMode: "default",
      planMode: false,
    };
    const s = new ChatSession({ id: "s1", engine: slowEngine });
    const p = s.enqueueTurn("slow", {});
    setTimeout(() => s.cancel(), 10);
    await expect(p).rejects.toThrow(/aborted/);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `bun test tests/chat-session-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ChatSession`**

```ts
// packages/core/src/protocol/chat-session.ts
import type { Engine } from "../engine/engine.js";
import type { RunResult, StreamEvent } from "../types.js";

export interface ChatSessionOptions {
  id: string;
  engine: Engine;
  onStream?: (event: StreamEvent) => void;
}

export interface TurnOpts {
  cwd?: string;
  onStream?: (event: StreamEvent) => void;
}

interface QueuedTurn {
  task: string;
  opts: TurnOpts;
  resolve: (r: RunResult) => void;
  reject: (e: unknown) => void;
}

/**
 * One ChatSession per UI chat tab. Owns a single Engine, an AbortController
 * for the active turn, and a FIFO queue so a fast second send waits for the
 * first turn to finish instead of being silently rejected.
 */
export class ChatSession {
  readonly id: string;
  readonly engine: Engine;
  readonly pendingApprovals = new Map<string, (decision: unknown) => void>();
  lastActivityAt = Date.now();

  private queue: QueuedTurn[] = [];
  private active: QueuedTurn | null = null;
  private controller: AbortController | null = null;
  private readonly defaultOnStream?: (event: StreamEvent) => void;

  constructor(opts: ChatSessionOptions) {
    this.id = opts.id;
    this.engine = opts.engine;
    this.defaultOnStream = opts.onStream;
  }

  enqueueTurn(task: string, opts: TurnOpts): Promise<RunResult> {
    this.lastActivityAt = Date.now();
    return new Promise((resolve, reject) => {
      this.queue.push({ task, opts, resolve, reject });
      this.pump();
    });
  }

  cancel(): void {
    this.controller?.abort();
    // Drain queued turns as cancelled
    const drained = this.queue.splice(0);
    for (const t of drained) {
      t.reject(new Error("cancelled: session aborted before turn ran"));
    }
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  queueDepth(): number {
    return this.queue.length;
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.controller = new AbortController();
    try {
      const onStream = next.opts.onStream ?? this.defaultOnStream;
      const result = await this.engine.run(next.task, {
        cwd: next.opts.cwd,
        signal: this.controller.signal,
        onStream,
      });
      this.lastActivityAt = Date.now();
      next.resolve(result);
    } catch (err) {
      next.reject(err);
    } finally {
      this.active = null;
      this.controller = null;
      // Drain the next turn if one is waiting.
      if (this.queue.length > 0) void this.pump();
    }
  }
}
```

- [ ] **Step 4: Run, confirm PASS**

Run: `bun test tests/chat-session-queue.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/chat-session.ts tests/chat-session-queue.test.ts
git commit -m "feat(core/protocol): add ChatSession with per-session FIFO turn queue"
```

---

## Task 9: `ChatSessionManager`

**Files:**
- Create: `packages/core/src/protocol/chat-session-manager.ts`
- Test: `tests/chat-session-manager.test.ts`

**Spec reference:** §6.3.

- [ ] **Step 1: Write failing tests**

```ts
// tests/chat-session-manager.test.ts
import { describe, it, expect } from "bun:test";
import { ChatSessionManager } from "../packages/core/src/protocol/chat-session-manager.ts";

function fakeRuntime(): any { return {}; }

describe("ChatSessionManager", () => {
  it("creates and reuses sessions by id", () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => ({ run: async () => ({}), permissionMode: "default", planMode: false } as any),
      maxSessions: 4,
      idleTtlMs: 60_000,
    });
    const s1 = m.getOrCreate("A", { permissionMode: "default" } as any);
    const s2 = m.getOrCreate("A", { permissionMode: "default" } as any);
    expect(s1).toBe(s2);
    expect(m.sessionCount()).toBe(1);
  });

  it("rejects with Overloaded when new session exceeds ceiling", () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => ({ run: async () => ({}), permissionMode: "default", planMode: false } as any),
      maxSessions: 2,
      idleTtlMs: 60_000,
    });
    m.getOrCreate("A", {} as any);
    m.getOrCreate("B", {} as any);
    expect(() => m.getOrCreate("C", {} as any)).toThrow(/Overloaded/);
    // Existing session still accessible:
    expect(m.get("A")).toBeDefined();
  });

  it("close() removes the session", () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => ({ run: async () => ({}), permissionMode: "default", planMode: false } as any),
      maxSessions: 4,
      idleTtlMs: 60_000,
    });
    m.getOrCreate("A", {} as any);
    m.close("A");
    expect(m.get("A")).toBeUndefined();
  });

  it("evicts idle sessions older than idleTtlMs", async () => {
    const m = new ChatSessionManager({
      runtime: fakeRuntime(),
      engineFactory: () => ({ run: async () => ({}), permissionMode: "default", planMode: false } as any),
      maxSessions: 4,
      idleTtlMs: 20,
    });
    const s = m.getOrCreate("A", {} as any);
    s.lastActivityAt = Date.now() - 1000;
    m.sweepIdle();
    expect(m.get("A")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `bun test tests/chat-session-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ChatSessionManager`**

```ts
// packages/core/src/protocol/chat-session-manager.ts
import { ChatSession } from "./chat-session.js";
import type { Engine } from "../engine/engine.js";
import type { EngineRuntime } from "../engine/runtime.js";
import type { EngineConfig } from "../engine/engine.js";

export type EngineConfigSlice = Pick<
  EngineConfig,
  "permissionMode" | "preset" | "customSystemPrompt" | "appendSystemPrompt" | "maxTurns" | "maxContextTokens" | "cwd"
>;

export interface ChatSessionManagerOptions {
  runtime: EngineRuntime;
  /** Build an Engine. Tests inject a fake; production passes (cfg) => new Engine({ runtime, ...cfg }). */
  engineFactory: (slice: EngineConfigSlice) => Engine;
  maxSessions?: number;       // default 16
  idleTtlMs?: number;         // default 30 min
}

export class ChatSessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly runtime: EngineRuntime;
  private readonly factory: (slice: EngineConfigSlice) => Engine;
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ChatSessionManagerOptions) {
    this.runtime = opts.runtime;
    this.factory = opts.engineFactory;
    this.maxSessions = opts.maxSessions ?? 16;
    this.idleTtlMs = opts.idleTtlMs ?? 30 * 60 * 1000;
  }

  getOrCreate(sessionId: string, slice: EngineConfigSlice): ChatSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    if (this.sessions.size >= this.maxSessions) {
      const err = new Error(`Overloaded: maxSessions=${this.maxSessions} reached`);
      (err as any).code = -32001;
      throw err;
    }
    const engine = this.factory(slice);
    const session = new ChatSession({ id: sessionId, engine });
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): ChatSession | undefined {
    return this.sessions.get(sessionId);
  }

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.cancel();
    this.sessions.delete(sessionId);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  sweepIdle(): void {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [id, s] of this.sessions) {
      if (s.lastActivityAt < cutoff && !s.isBusy()) this.close(id);
    }
  }

  startIdleSweeper(intervalMs = 60_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepIdle(), intervalMs);
    // Allow the process to exit even if sweeper is pending.
    (this.sweeper as any)?.unref?.();
  }

  stopIdleSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
```

- [ ] **Step 4: Run, confirm PASS**

Run: `bun test tests/chat-session-manager.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/chat-session-manager.ts \
        tests/chat-session-manager.test.ts
git commit -m "feat(core/protocol): add ChatSessionManager with multi-session map + ceiling"
```

---

## Task 10: Rewrite `AgentServer` to dispatch via `ChatSessionManager`

**Files:**
- Modify: `packages/core/src/protocol/types.ts`
- Modify: `packages/core/src/protocol/server.ts`
- Modify: `tests/protocol/agent-server.test.ts`
- Modify: `tests/protocol/in-process-client-drift.test.ts`
- Test: `tests/protocol/multi-session.test.ts` (new)

**Spec reference:** §4 (protocol), §6.4 (server).

- [ ] **Step 1: Update protocol types**

In `packages/core/src/protocol/types.ts`:
a) Add `agent/closeSession` to `Methods`.
b) Add error codes:
```ts
Overloaded: -32001,
SessionClosed: -32004,
```
c) Delete `AlreadyRunning: -32003`.
d) Make `sessionId` required on `RunParams`:
```ts
export interface RunParams {
  sessionId: string;          // required, client-minted
  task: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  planMode?: boolean;
}
```
e) Add `CancelParams`, `ApproveParams`, `CloseSessionParams`, each with required `sessionId`.
f) Stream event notification envelope shape:
```ts
export interface AgentStreamEventNotification {
  sessionId: string;
  event: StreamEvent;
}
```

- [ ] **Step 2: Write failing multi-session test**

```ts
// tests/protocol/multi-session.test.ts
import { describe, it, expect } from "bun:test";
import { AgentServer } from "../../packages/core/src/protocol/server.ts";
import { ChatSessionManager } from "../../packages/core/src/protocol/chat-session-manager.ts";
import { createInProcessTransport } from "../../packages/core/src/protocol/transport.ts";
import { AgentClient } from "../../packages/core/src/protocol/client.ts";
import { EngineRuntime } from "../../packages/core/src/engine/runtime.ts";

function fakeEngineFactory() {
  return (_slice: any) => ({
    permissionMode: "default",
    planMode: false,
    run: async (task: string, opts: any) => {
      // Emit a couple stream events, then complete.
      opts.onStream?.({ type: "text_delta", text: `t:${task}` });
      await new Promise((r) => setTimeout(r, 20));
      opts.onStream?.({ type: "turn_complete" });
      return { text: `done:${task}`, reason: "completed", sessionId: opts.sessionId, turnCount: 1, usage: {} };
    },
  });
}

describe("AgentServer multi-session", () => {
  it("runs two sessions in parallel without cross-talk", async () => {
    const [serverT, clientT] = createInProcessTransport();
    const runtime = new EngineRuntime({
      modelPool: {} as any, toolRegistry: {} as any, settings: {} as any,
      mcpPool: {} as any, costTracker: {} as any,
    });
    const cm = new ChatSessionManager({ runtime, engineFactory: fakeEngineFactory(), maxSessions: 8, idleTtlMs: 60_000 });
    new AgentServer({ chatManager: cm, transport: serverT });
    const client = new AgentClient({ transport: clientT });

    const eventsA: any[] = [];
    const eventsB: any[] = [];
    client.onStreamEvent((env: any) => {
      if (env.sessionId === "A") eventsA.push(env.event);
      if (env.sessionId === "B") eventsB.push(env.event);
    });

    const [a, b] = await Promise.all([
      client.run({ sessionId: "A", task: "hello-a" }),
      client.run({ sessionId: "B", task: "hello-b" }),
    ]);
    expect(a.text).toBe("done:hello-a");
    expect(b.text).toBe("done:hello-b");
    expect(eventsA.some((e) => e.type === "text_delta" && e.text === "t:hello-a")).toBe(true);
    expect(eventsB.some((e) => e.type === "text_delta" && e.text === "t:hello-b")).toBe(true);
    // Crucially: each tab only sees its own events.
    expect(eventsA.every((e) => !("text" in e) || e.text === "t:hello-a" || e.type === "turn_complete")).toBe(true);
  });

  it("agent/run without sessionId returns -32602", async () => {
    const [serverT, clientT] = createInProcessTransport();
    const runtime = new EngineRuntime({ /* same as above */ } as any);
    const cm = new ChatSessionManager({ runtime, engineFactory: fakeEngineFactory(), maxSessions: 8, idleTtlMs: 60_000 });
    new AgentServer({ chatManager: cm, transport: serverT });
    const client = new AgentClient({ transport: clientT });
    await expect(client.run({ task: "x" } as any)).rejects.toMatchObject({ code: -32602 });
  });

  it("same-session second send queues behind the first", async () => {
    const [serverT, clientT] = createInProcessTransport();
    const runtime = new EngineRuntime({} as any);
    const cm = new ChatSessionManager({ runtime, engineFactory: fakeEngineFactory(), maxSessions: 8, idleTtlMs: 60_000 });
    new AgentServer({ chatManager: cm, transport: serverT });
    const client = new AgentClient({ transport: clientT });
    const order: string[] = [];
    const a = client.run({ sessionId: "A", task: "a" }).then((r) => order.push(r.text));
    const b = client.run({ sessionId: "A", task: "b" }).then((r) => order.push(r.text));
    await Promise.all([a, b]);
    expect(order).toEqual(["done:a", "done:b"]);
  });
});
```

- [ ] **Step 3: Run, confirm FAIL**

Run: `bun test tests/protocol/multi-session.test.ts`
Expected: FAIL — server still uses single flag.

- [ ] **Step 4: Rewrite `AgentServer.handleRun` and adjacent handlers**

Open `packages/core/src/protocol/server.ts`. Replace the entire class with the structure below — keep the imports for `RpcRequest`, `createResponse`, `createErrorResponse`, `ErrorCodes`, `Methods`, but drop `setRuntimeBypass`/`setInPlanMode` etc.

Skeleton:

```ts
import { ChatSessionManager } from "./chat-session-manager.js";
import type { RunManager } from "../run/RunManager.js";
import { ErrorCodes, Methods } from "./types.js";
import { createErrorResponse, createResponse } from "./helpers.js";
import type { ServerTransport } from "./transport.js";
import type { RpcRequest } from "./types.js";
import type { StreamEvent } from "../types.js";

export interface AgentServerOptions {
  chatManager: ChatSessionManager;
  runManager?: RunManager;
  transport: ServerTransport;
}

export class AgentServer {
  private readonly chatManager: ChatSessionManager;
  private readonly runManager: RunManager | null;
  private readonly transport: ServerTransport;

  constructor(opts: AgentServerOptions) {
    this.chatManager = opts.chatManager;
    this.runManager = opts.runManager ?? null;
    this.transport = opts.transport;
    this.transport.onMessage((line: string) => this.handleRpc(line));
    this.notify(Methods.Status, { status: "ready" });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private async handleRpc(line: string): Promise<void> {
    let req: RpcRequest;
    try { req = JSON.parse(line); } catch { return; }
    switch (req.method) {
      case Methods.Run:           return this.handleRun(req);
      case Methods.Cancel:        return this.handleCancel(req);
      case Methods.Approve:       return this.handleApprove(req);
      case Methods.CloseSession:  return this.handleCloseSession(req);
      case Methods.Configure:     return this.handleConfigure(req);
      // run/* methods dispatch to runManager (unchanged from prior wiring).
      default:
        if (req.method.startsWith("run/")) return this.handleRunManagerMethod(req);
        this.transport.send(createErrorResponse(req.id, ErrorCodes.MethodNotFound, `Unknown method: ${req.method}`));
    }
  }

  private async handleRun(req: RpcRequest): Promise<void> {
    const params = (req.params ?? {}) as any;
    if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
      return this.send(createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"));
    }
    if (typeof params.task !== "string" || params.task.length === 0) {
      return this.send(createErrorResponse(req.id, ErrorCodes.InvalidParams, "task is required"));
    }
    let session;
    try {
      session = this.chatManager.getOrCreate(params.sessionId, {
        permissionMode: params.permissionMode,
        cwd: params.cwd,
      } as any);
    } catch (err: any) {
      const code = err.code ?? ErrorCodes.InternalError;
      return this.send(createErrorResponse(req.id, code, err.message));
    }
    if (typeof params.planMode === "boolean") session.engine.setPlanMode(params.planMode);
    try {
      const result = await session.enqueueTurn(params.task, {
        cwd: params.cwd,
        onStream: (event: StreamEvent) => this.notify(Methods.StreamEvent, { sessionId: params.sessionId, event }),
      });
      this.send(createResponse(req.id, { sessionId: params.sessionId, ...result }));
    } catch (err: any) {
      this.send(createErrorResponse(req.id, ErrorCodes.InternalError, err.message ?? String(err)));
    }
  }

  private handleCancel(req: RpcRequest): void {
    const params = (req.params ?? {}) as any;
    if (typeof params.sessionId !== "string") {
      return this.send(createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"));
    }
    const s = this.chatManager.get(params.sessionId);
    if (!s) return this.send(createErrorResponse(req.id, ErrorCodes.SessionClosed, `No such session: ${params.sessionId}`));
    s.cancel();
    this.send(createResponse(req.id, { ok: true }));
  }

  private handleApprove(req: RpcRequest): void {
    const params = (req.params ?? {}) as any;
    const s = this.chatManager.get(params.sessionId);
    if (!s) return this.send(createErrorResponse(req.id, ErrorCodes.SessionClosed, `No such session: ${params.sessionId}`));
    const resolve = s.pendingApprovals.get(params.requestId);
    if (!resolve) return this.send(createErrorResponse(req.id, ErrorCodes.InvalidParams, `No pending approval: ${params.requestId}`));
    s.pendingApprovals.delete(params.requestId);
    resolve(params.decision);
    this.send(createResponse(req.id, { ok: true }));
  }

  private handleCloseSession(req: RpcRequest): void {
    const params = (req.params ?? {}) as any;
    if (typeof params.sessionId !== "string") {
      return this.send(createErrorResponse(req.id, ErrorCodes.InvalidParams, "sessionId is required"));
    }
    this.chatManager.close(params.sessionId);
    this.send(createResponse(req.id, { ok: true }));
  }

  private handleConfigure(req: RpcRequest): void {
    const params = (req.params ?? {}) as any;
    // sessionId optional: when present, mutate that session's engine.
    if (typeof params.sessionId === "string") {
      const s = this.chatManager.get(params.sessionId);
      if (!s) return this.send(createErrorResponse(req.id, ErrorCodes.SessionClosed, `No such session: ${params.sessionId}`));
      if (typeof params.planMode === "boolean") s.engine.setPlanMode(params.planMode);
      if (typeof params.permissionMode === "string") s.engine.setPermissionMode(params.permissionMode as any);
      return this.send(createResponse(req.id, { ok: true }));
    }
    // Worker-global configure paths (model reload, MCP reload, etc.) — keep
    // the legacy logic if present; just remove the now-defunct
    // setRuntimeBypass/setInPlanMode calls.
    this.send(createResponse(req.id, { ok: true }));
  }

  private async handleRunManagerMethod(req: RpcRequest): Promise<void> {
    if (!this.runManager) {
      return this.send(createErrorResponse(req.id, ErrorCodes.MethodNotFound, `run/* methods require runManager`));
    }
    // Existing dispatch code stays here — left unchanged for this PR.
    // (If the previous server had inline run/* dispatch, move that block here verbatim.)
    this.send(createErrorResponse(req.id, ErrorCodes.MethodNotFound, `run/${req.method} not yet ported`));
  }

  private send(line: string): void {
    this.transport.send(line);
  }
}
```

> Note: this rewrite drops a few features that the old server.ts had (model switching, settings reload, sessions list, etc.). Before deleting any handler, **grep for its method name in protocol/types.ts and any test**. If the test still references it, port the handler verbatim into `handleConfigure` or a new `handleQuery`. Do not silently lose features.

- [ ] **Step 5: Update / add `Engine.setPermissionMode` method (if missing)**

Likely already exists at `engine.ts:1524`. If not, add it:
```ts
setPermissionMode(mode: EngineConfig["permissionMode"]): void {
  this.permissionMode = mode;
  this.planMode = mode === "plan";
}
```

- [ ] **Step 6: Update the older protocol tests**

In `tests/protocol/agent-server.test.ts` and `tests/protocol/in-process-client-drift.test.ts`:
- Every `client.run({ task: ... })` must now pass `sessionId`.
- Any assertion that expected `-32003 AlreadyRunning` flips to expecting either (a) `-32001 Overloaded` (over ceiling) or (b) successful queueing (same session) or (c) successful parallelism (different sessions).

- [ ] **Step 7: Run the full test suite**

Run: `bun test`
Expected: all green. The new `multi-session.test.ts` passes; the old protocol tests pass after updates.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/protocol/types.ts \
        packages/core/src/protocol/server.ts \
        packages/core/src/engine/engine.ts \
        tests/protocol/multi-session.test.ts \
        tests/protocol/agent-server.test.ts \
        tests/protocol/in-process-client-drift.test.ts
git commit -m "feat(core/protocol): AgentServer dispatches via ChatSessionManager"
```

---

## Task 11: Wire `EngineRuntime` + `ChatSessionManager` into `agent-server-stdio.ts`

**Files:**
- Modify: `packages/core/src/cli/agent-server-stdio.ts`

- [ ] **Step 1: Replace the existing Engine bootstrap**

Open `packages/core/src/cli/agent-server-stdio.ts`. Today it does roughly:
```ts
const engine = new Engine(config);
new AgentServer({ engine, transport });
```

Change to:
```ts
import { EngineRuntime } from "../engine/runtime.js";
import { ChatSessionManager } from "../protocol/chat-session-manager.js";
import { Engine } from "../engine/engine.js";
// ... existing imports

const runtime = new EngineRuntime({
  modelPool: buildModelPool(config),         // existing helper or factory used today
  toolRegistry: buildToolRegistry(config),
  settings: buildSettingsStore(config),
  mcpPool: buildMcpManager(config),
  costTracker: buildCostStore(config),
});

const chatManager = new ChatSessionManager({
  runtime,
  engineFactory: (slice) => new Engine({ runtime, ...config, ...slice }),
  maxSessions: 16,
  idleTtlMs: 30 * 60 * 1000,
});
chatManager.startIdleSweeper();

const server = new AgentServer({ chatManager, transport: stdioTransport });
```

If `buildModelPool` etc. helpers don't exist, factor them out of the existing `new Engine(config)` constructor as small standalone exports — that is a strict refactor of code that already runs today.

- [ ] **Step 2: Manual smoke test**

Run: `node packages/core/dist/cli/agent-server-stdio.js < /dev/null`
Expected: server prints the `{"method":"agent/status", ...}` ready notification within 200ms, then waits for input.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/cli/agent-server-stdio.ts \
        packages/core/src/engine/engine.ts
git commit -m "feat(core/cli): bootstrap EngineRuntime + ChatSessionManager"
```

---

## Task 12: Update TUI (`repl.ts`, `run.ts`) for the new wire format

**Files:**
- Modify: `packages/tui/src/cli/commands/repl.ts`
- Modify: `packages/tui/src/cli/commands/run.ts`

- [ ] **Step 1: Update `repl.ts`**

Open `packages/tui/src/cli/commands/repl.ts`. Find the block (~line 125) that does:
```ts
const engine = new Engine({ ... });
const [serverTransport, clientTransport] = createInProcessTransport();
const _server = new AgentServer({ engine, transport: serverTransport });
```

Replace with:
```ts
const runtime = new EngineRuntime({
  modelPool: ..., toolRegistry: ..., settings: ..., mcpPool: ..., costTracker: ...,
});
const chatManager = new ChatSessionManager({
  runtime,
  engineFactory: (slice) => new Engine({ runtime, ...sharedCfg, ...slice }),
  maxSessions: 4,
  idleTtlMs: 30 * 60 * 1000,
});

const [serverTransport, clientTransport] = createInProcessTransport();
const _server = new AgentServer({ chatManager, transport: serverTransport });
```

Find where `startInkRepl` is called. Pass a fixed sessionId so every send routes to the one TUI session:
```ts
await startInkRepl({
  client,
  sessionId: options.resume ?? "tui-main",
  // ... rest unchanged
});
```

- [ ] **Step 2: Update `startInkRepl` to attach sessionId on every send**

Find where the Ink REPL invokes `client.run({ task })`. Change to `client.run({ sessionId: opts.sessionId, task })`.

- [ ] **Step 3: Update `run.ts` (one-shot command)**

Same pattern. Single sessionId per invocation (e.g. `run-${randomUUID()}`).

- [ ] **Step 4: Smoke**

Run: `bun run tui repl --provider noop` (or whatever the dev TUI command is)
Expected: REPL boots, prompts for input, basic message round-trips without errors.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/cli/commands/repl.ts packages/tui/src/cli/commands/run.ts
git commit -m "feat(tui): switch to EngineRuntime + ChatSessionManager (single sessionId)"
```

---

## Task 13: Desktop preload — `sessionId` on requests, envelope on stream

**Files:**
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/types.d.ts`

- [ ] **Step 1: Edit `preload/index.ts`**

Find the existing `streamListeners` fan-out (lines ~41-47). Change the wrapped event from `params.event` to `{ sessionId: params.sessionId, event: params.event }`:

```ts
// packages/desktop/src/preload/index.ts (excerpt)
if (method === "agent/streamEvent") {
  const sessionId = params?.sessionId as string;
  const event = params?.event;
  streamListeners.forEach((cb) => cb({ sessionId, event }));
}
```

Similarly for `agent/approvalRequest`:
```ts
} else if (method === "agent/approvalRequest") {
  approvalListeners.forEach((cb) => cb({ sessionId: params?.sessionId, ...params }));
}
```

Update the `run`, `cancel`, `approve`, and add `closeSession`:

```ts
run: (task: string, opts: { sessionId: string; cwd?: string; permissionMode?: string }) =>
  rpc("agent/run", { task, ...opts }),
cancel: (sessionId: string) => rpc("agent/cancel", { sessionId }),
approve: (sessionId: string, requestId: string, decision: ...) =>
  rpc("agent/approve", { sessionId, requestId, decision: ... }),
closeSession: (sessionId: string) => rpc("agent/closeSession", { sessionId }),
```

- [ ] **Step 2: Update `preload/types.d.ts`**

Match each renamed signature. `onStreamEvent`'s callback type becomes `(env: { sessionId: string; event: StreamEvent }) => void`.

- [ ] **Step 3: Build the preload and confirm typecheck**

Run: `bun run --filter desktop typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts
git commit -m "feat(desktop/preload): pass sessionId on every request + envelope stream events"
```

---

## Task 14: Desktop renderer — route by sessionId, delete `runningBucketRef`

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx`

- [ ] **Step 1: Delete `runningBucketRef`**

In `App.tsx`, remove the `runningBucketRef` declaration and every read/write of it (around lines 425-460 and any companion `useRef`).

- [ ] **Step 2: Add two Maps to the App component scope**

Near the existing top-level refs:
```tsx
const sessionIdToBucketRef = useRef(new Map<string, string>());
const busyBySessionRef    = useRef(new Map<string, boolean>());
```

When a chat tab is created (existing `handleAddSession` or equivalent), register:
```tsx
sessionIdToBucketRef.current.set(uiSession.sessionId, bucketOf(uiSession));
```

When closed:
```tsx
sessionIdToBucketRef.current.delete(closedSession.sessionId);
window.codeshell.closeSession(closedSession.sessionId);
```

- [ ] **Step 3: Rewrite the stream handler**

Replace the body of the `onStreamEvent` callback:

```tsx
const offStream = window.codeshell.onStreamEvent(({ sessionId, event }) => {
  const bucket = sessionIdToBucketRef.current.get(sessionId);
  if (!bucket) return;
  const noisy =
    event.type === "text_delta" ||
    event.type === "tool_use_args_delta" ||
    event.type === "usage_update" ||
    event.type === "thinking_delta";
  if (!noisy) {
    window.codeshell.log("stream.event", { type: event.type, bucket, sessionId });
  }
  dispatch({ type: "stream", bucket, event });

  if (event.type === "session_started") {
    // bind engine sessionId back to the UI session (existing logic; sessionId
    // comes from envelope now, not from event payload)
    const sep = bucket.indexOf("::");
    if (sep > 0) {
      const repoKey = bucket.slice(0, sep);
      const uiSessionId = bucket.slice(sep + 2);
      const repoId = repoKey === GLOBAL_KEY ? null : repoKey;
      if (uiSessionId && uiSessionId !== "_none_") {
        const nextIdx = bindEngineSession(repoId, uiSessionId, sessionId);
        setSessionIndices((prev) => ({ ...prev, [repoKey]: nextIdx }));
      }
    }
  }

  if (event.type === "turn_complete" || event.type === "error") {
    busyBySessionRef.current.set(sessionId, false);
    setBusyForKey(bucket, false);   // existing per-tab busy state still updates
  }
});
```

- [ ] **Step 4: Update `send` to pass sessionId**

Find where `window.codeshell.run({ task, cwd })` is called. Add `sessionId: currentUiSession.sessionId`:

```tsx
window.codeshell.run(task, {
  sessionId: currentUiSession.sessionId,
  cwd: currentRepo?.cwd,
  permissionMode: currentPermissionMode,
});
```

- [ ] **Step 5: Build the renderer**

Run: `bun run --filter desktop dev`
Expected: app starts, no console errors at load.

- [ ] **Step 6: Manual smoke (matches §8.4 of spec)**

Open two tabs. In tab A, send a long task. In tab B, send a task. Verify both stream concurrently. In tab A, send a second message — UI should accept it and start streaming after the first turn finishes (not silently drop). Cancel tab A; tab B unaffected.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/renderer/App.tsx
git commit -m "feat(desktop/renderer): route stream events by sessionId from envelope"
```

---

## Task 15: Final cleanup — sanity sweep + doc bump

**Files:**
- Modify: `docs/superpowers/specs/2026-05-26-multi-session-chat-runtime-design.md` (flip Status to "Implemented")

- [ ] **Step 1: Run the full suite end-to-end**

Run: `bun test`
Expected: all green.

- [ ] **Step 2: Ripgrep for leftover singletons**

Run: `rg "setRuntimeBypass|isRuntimeBypass|setInPlanMode|isInPlanMode|this\.running\b|runningBucketRef" packages/`
Expected: zero matches (besides tests that assert the singletons are gone, which is the negative test we wrote earlier).

- [ ] **Step 3: Flip spec status**

In `docs/superpowers/specs/2026-05-26-multi-session-chat-runtime-design.md`, change line `Status: Draft` to `Status: Implemented (PR <link>)`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-26-multi-session-chat-runtime-design.md
git commit -m "docs: mark multi-session chat runtime spec as implemented"
```

---

## Self-Review

**Spec coverage:**
- §3.1 architecture (EngineRuntime / ChatSessionManager / ChatSession): Task 1, 2, 8, 9 ✅
- §3.2 lifecycle (lazy create, idle eviction, no recovery): Task 9 (sweepIdle) ✅
- §3.3 subagent attribution (per-session route): handled by Engine.run → onStream still wired to the same ChatSession.onStream in Task 8/10 ✅
- §4 protocol (sessionId required, new error codes, closeSession): Task 10 step 1 ✅
- §5.1-5.4 data flow: Task 10 (server) + Task 14 (renderer) ✅
- §6.1 EngineRuntime: Task 1-2 ✅
- §6.2 Engine refactor: Task 6, 7 ✅
- §6.3 ChatSessionManager: Task 9 ✅
- §6.4 AgentServer rewrite: Task 10 ✅
- §6.5 agent-server-stdio bootstrap: Task 11 ✅
- §6.6 TUI: Task 12 ✅
- §6.7 preload: Task 13 ✅
- §6.8 renderer: Task 14 ✅
- §6.9 permission/plan singletons: Task 3-5, 7 ✅
- §7 error handling (Overloaded ceiling, SessionClosed, cancel race): Task 9 (ceiling), Task 10 (handlers), Task 8 (cancel) ✅
- §8 testing: Task 8 (queue), 9 (manager), 10 (multi-session integration), 12 (TUI smoke), 14 (desktop smoke) ✅
- §10 out-of-scope: explicitly NOT done — recovery, multi-worker, persistent chat ✅

**Placeholder scan:** no TBD/TODO left in the plan body. Task 4 step 3 mentions a "TODO comment only inside this step" which is removed in Task 7 step 4 — that is bounded and explicit.

**Type consistency:**
- `sessionId` (string) used everywhere — wire, ChatSession, ChatSessionManager, renderer Maps ✅
- `EngineConfigSlice` defined in Task 9, referenced in Task 11/12 ✅
- `setPlanMode(boolean)` defined in Task 6, called from Task 7 (Plan tool) and Task 10 (Configure handler) ✅
- `setPermissionMode(mode)` confirmed-or-added in Task 10 step 5 ✅
- `onStream` envelope `{ sessionId, event }` consistent across Task 10 (server emits), Task 13 (preload reshapes), Task 14 (renderer consumes) ✅

No gaps found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-multi-session-chat-runtime.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Per the goal ("使用 subagent 来做"), proceeding with option 1.
