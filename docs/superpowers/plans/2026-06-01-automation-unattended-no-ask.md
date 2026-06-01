# Automation Unattended No-Ask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unattended automation runs (a) tell the model it IS the automation so it stops offering to set up automation, and (b) never block on `AskUserQuestion` (which currently suspends ~300s in headless runs).

**Architecture:** Two changes in `packages/core`. Fix A: `EngineRunner` reads `run.metadata.source === "automation"` and prepends an English system-prompt note to `appendSystemPrompt`. Fix B: `EngineRunner` sets `headless: true` whenever an unattended `approvalBackend` override is present, and the in-process `AgentServer` constructor skips its unconditional `setAskUser` wiring when the engine is headless — so `AskUserQuestion` hits its instant headless-error branch instead of suspending.

**Tech Stack:** TypeScript, Bun test runner. Tests via `bun test <path>`.

---

### Task 1: Engine exposes `isHeadless()`

`AgentServer` (Fix B) needs to read whether its engine is headless. `Engine.config` is a private constructor field with no accessor. Add a minimal public method.

**Files:**
- Modify: `packages/core/src/engine/engine.ts` (add method near `setAskUser`, ~line 590)
- Test: `packages/core/src/engine/engine.headless-accessor.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/engine/engine.headless-accessor.test.ts
import { describe, it, expect } from "bun:test";
import { Engine } from "./engine.js";

const baseLlm = { provider: "openai", model: "gpt-5", apiKey: "test-key" } as any;

describe("Engine.isHeadless", () => {
  it("returns true when constructed headless", () => {
    const engine = new Engine({ llm: baseLlm, headless: true });
    expect(engine.isHeadless()).toBe(true);
  });

  it("returns false when headless is unset", () => {
    const engine = new Engine({ llm: baseLlm });
    expect(engine.isHeadless()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/engine/engine.headless-accessor.test.ts`
Expected: FAIL — `engine.isHeadless is not a function`.

- [ ] **Step 3: Add the accessor**

In `packages/core/src/engine/engine.ts`, immediately after the `setAskUser` method (the block ending at the `}` on the line after `this.config.askUser = fn;`), insert:

```ts
  /** Whether this engine runs unattended (no interactive human). Used by the
   *  in-process AgentServer to decide whether to wire an interactive askUser. */
  isHeadless(): boolean {
    return this.config.headless === true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/engine/engine.headless-accessor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/engine.ts packages/core/src/engine/engine.headless-accessor.test.ts
git commit -m "feat(core): add Engine.isHeadless() accessor"
```

---

### Task 2: AgentServer skips askUser wiring when engine is headless (Fix B, server half)

The `AgentServer` constructor unconditionally calls `legacyEngine.setAskUser(...)` (`server.ts:110`), re-binding askUser to a client round-trip even when the run is unattended. Gate it on `!isHeadless()`.

**Files:**
- Modify: `packages/core/src/protocol/server.ts:105-113`
- Test: `packages/core/src/protocol/server.askuser-headless.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/protocol/server.askuser-headless.test.ts
import { describe, it, expect } from "bun:test";
import { AgentServer } from "./server.js";

// Minimal stub transport satisfying the Transport interface (send/onMessage/close).
function makeTransport() {
  return {
    send: (_msg: unknown) => {},
    onMessage: (_cb: (msg: unknown) => void) => {},
    close: () => {},
  } as any;
}

// Minimal Engine stub: only what the AgentServer ctor touches.
function makeEngineStub(headless: boolean) {
  return {
    isHeadless: () => headless,
    setAskUser: function (fn: unknown) {
      (this as any)._askUser = fn;
    },
    _askUser: undefined as unknown,
  };
}

describe("AgentServer askUser wiring", () => {
  it("does NOT wire askUser when the engine is headless", () => {
    const engine = makeEngineStub(true);
    new AgentServer({ transport: makeTransport(), engine: engine as any });
    expect(engine._askUser).toBeUndefined();
  });

  it("wires askUser when the engine is interactive", () => {
    const engine = makeEngineStub(false);
    new AgentServer({ transport: makeTransport(), engine: engine as any });
    expect(typeof engine._askUser).toBe("function");
  });
});
```

> The `AgentServer` constructor takes a single options object
> (`{ transport, engine }`) — confirmed in `server.ts` (`constructor(options:
> AgentServerOptions)`). The assertions on `engine._askUser` are what matter.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/protocol/server.askuser-headless.test.ts`
Expected: FAIL — the headless case wires askUser (so `_askUser` is a function, not undefined).

- [ ] **Step 3: Gate the wiring**

In `packages/core/src/protocol/server.ts`, change the block at lines 105-113 from:

```ts
    if (this.legacyEngine) {
      setInteractiveApprovalFn((request: ApprovalRequest) => {
        return this.requestApprovalFromClient(request);
      });

      this.legacyEngine.setAskUser((question, opts) => {
        return this.requestAskUserFromClient(question, opts);
      });
    }
```

to:

```ts
    if (this.legacyEngine) {
      setInteractiveApprovalFn((request: ApprovalRequest) => {
        return this.requestApprovalFromClient(request);
      });

      // Only wire an interactive askUser when a human is present. For
      // unattended (headless) runs we leave askUser undefined so
      // AskUserQuestion hits its headless-error branch and returns immediately
      // instead of suspending until the tool-exec timeout (~300s).
      if (!this.legacyEngine.isHeadless()) {
        this.legacyEngine.setAskUser((question, opts) => {
          return this.requestAskUserFromClient(question, opts);
        });
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/protocol/server.askuser-headless.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol/server.ts packages/core/src/protocol/server.askuser-headless.test.ts
git commit -m "fix(core): AgentServer skips interactive askUser for headless engines"
```

---

### Task 3: EngineRunner forces headless under approvalBackend override (Fix B, runner half)

`EngineRunner` already treats an `approvalBackend` override as the "unattended" signal (it leaves `askUserFn` undefined under override — `EngineRunner.ts:115-129`). Make the same condition also set `headless: true` on the built `EngineConfig`, so the in-process AgentServer (Task 2) sees a headless engine.

**Files:**
- Modify: `packages/core/src/run/EngineRunner.ts:145-163` (the `engineConfig` object)
- Test: `packages/core/src/run/EngineRunner.headless.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/run/EngineRunner.headless.test.ts
import { describe, it, expect } from "bun:test";
import { EngineRunner } from "./EngineRunner.js";
import { HeadlessApprovalBackend } from "../tool-system/permission.js";

const baseLlm = { provider: "openai", model: "gpt-5", apiKey: "test-key" } as any;

// Reach the private config-builder by exercising the public surface is hard
// without a full run; instead assert the decision rule directly via a tiny
// helper exported for testing. See Step 3 — we extract buildHeadlessFlag.
import { buildHeadlessFlag } from "./EngineRunner.js";

describe("EngineRunner headless decision", () => {
  it("is headless when an approvalBackend override is present", () => {
    expect(buildHeadlessFlag(new HeadlessApprovalBackend("approve-read-only"))).toBe(true);
  });

  it("is not forced headless when no override", () => {
    expect(buildHeadlessFlag(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/run/EngineRunner.headless.test.ts`
Expected: FAIL — `buildHeadlessFlag` is not exported / not defined.

- [ ] **Step 3: Extract the rule and apply it in the config**

In `packages/core/src/run/EngineRunner.ts`, add a small exported pure helper near the top (after imports):

```ts
/** Unattended runs (those with an injected approval backend) run headless so
 *  the in-process AgentServer does not wire an interactive askUser. Exported
 *  for unit testing the decision rule. */
export function buildHeadlessFlag(
  override: import("../tool-system/permission.js").ApprovalBackend | undefined,
): boolean {
  return override !== undefined;
}
```

Then, in the `engineConfig` object (lines 145-163), add a `headless` field driven by the existing `override` local (defined at line 115 as `const override = this.config.approvalBackend;`). Insert it alongside the other fields, e.g. right after `permissionMode: this.config.permissionMode ?? "acceptEdits",`:

```ts
      headless: buildHeadlessFlag(override),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/run/EngineRunner.headless.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/run/EngineRunner.ts packages/core/src/run/EngineRunner.headless.test.ts
git commit -m "fix(core): EngineRunner runs headless when an approval override is set"
```

---

### Task 4: EngineRunner injects automation system-prompt note (Fix A)

When the run is tagged `metadata.source === "automation"`, prepend an English note to `appendSystemPrompt` telling the model it is the unattended automation and must not ask or offer to set up automation.

**Files:**
- Modify: `packages/core/src/run/EngineRunner.ts` (add exported helper + use it in `engineConfig.appendSystemPrompt`)
- Test: `packages/core/src/run/EngineRunner.automation-note.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/run/EngineRunner.automation-note.test.ts
import { describe, it, expect } from "bun:test";
import { buildAppendSystemPrompt, AUTOMATION_PROMPT_NOTE } from "./EngineRunner.js";

describe("buildAppendSystemPrompt", () => {
  it("prepends the automation note for automation runs", () => {
    const out = buildAppendSystemPrompt("host-append", { source: "automation" });
    expect(out.startsWith(AUTOMATION_PROMPT_NOTE)).toBe(true);
    expect(out).toContain("host-append");
  });

  it("returns host append unchanged for non-automation runs", () => {
    expect(buildAppendSystemPrompt("host-append", { source: "user" })).toBe("host-append");
    expect(buildAppendSystemPrompt(undefined, {})).toBeUndefined();
  });

  it("uses just the note when there is no host append", () => {
    expect(buildAppendSystemPrompt(undefined, { source: "automation" })).toBe(
      AUTOMATION_PROMPT_NOTE,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/run/EngineRunner.automation-note.test.ts`
Expected: FAIL — `buildAppendSystemPrompt` / `AUTOMATION_PROMPT_NOTE` not exported.

- [ ] **Step 3: Add the note + helper, and wire it into the config**

In `packages/core/src/run/EngineRunner.ts`, add near the top (after imports):

```ts
/** Appended to the system prompt for unattended automation runs so the model
 *  knows it IS the automation and must not ask the user or offer to schedule
 *  automation. English by repo convention; the model answers in the user's
 *  language regardless. */
export const AUTOMATION_PROMPT_NOTE =
  "This is an unattended, scheduled automation run. No human is watching, and " +
  "AskUserQuestion will not reach anyone. You ARE the automation — do not ask " +
  "the user questions and do not offer to set up or schedule automation. " +
  "Produce the requested output directly; when uncertain, state your assumption " +
  "and proceed.";

/** Compose the run's appendSystemPrompt: prepend the automation note when the
 *  run is tagged source "automation", preserving any host-provided append. */
export function buildAppendSystemPrompt(
  hostAppend: string | undefined,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (metadata?.source !== "automation") return hostAppend;
  return hostAppend ? `${AUTOMATION_PROMPT_NOTE}\n\n${hostAppend}` : AUTOMATION_PROMPT_NOTE;
}
```

Then in the `engineConfig` object, replace:

```ts
      appendSystemPrompt: this.config.appendSystemPrompt,
```

with:

```ts
      appendSystemPrompt: buildAppendSystemPrompt(this.config.appendSystemPrompt, run.metadata),
```

(`run` is the first parameter of `execute(run, context, ...)`; `run.metadata` is typed `Record<string, unknown>` on `RunSnapshot` — confirmed in `run/types.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/run/EngineRunner.automation-note.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/run/EngineRunner.ts packages/core/src/run/EngineRunner.automation-note.test.ts
git commit -m "feat(core): inject automation system-prompt note for source=automation runs"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full core test suite**

Run: `bun test packages/core`
Expected: all pass, 0 fail. (Pre-existing warnings are fine; no new failures.)

- [ ] **Step 2: Typecheck + rebuild core dist**

Core has no standalone `typecheck` script — its `build` runs `tsc -p tsconfig.json` first, so building both typechecks and refreshes dist. Per the project memory, TUI/desktop resolve `@cjhyy/code-shell-core` to **dist**, not source, so new exports (`isHeadless`, the helpers) must be built.

Run: `bun run --filter '@cjhyy/code-shell-core' build`
Expected: `tsc` reports 0 errors and the build completes.

- [ ] **Step 3: Commit any build artifacts if the repo tracks dist** (skip if dist is gitignored)

```bash
git status --short
# if dist files changed and are tracked:
git add -A && git commit -m "build(core): rebuild dist for automation no-ask changes"
```

---

## Self-Review

**Spec coverage:**
- Fix A (automation note via metadata → appendSystemPrompt) → Task 4. ✓
- Fix B server half (gate setAskUser on headless) → Task 2. ✓
- Fix B runner half (override → headless:true) → Task 3. ✓
- `isHeadless()` accessor needed by Task 2 → Task 1. ✓
- "Why not goal mode" — design rationale only, no code. ✓
- Out-of-scope (askUser timeout, tool-exec 300s, write tiers) — correctly untouched. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. Two explicit "confirm the signature" notes (Task 2 ctor shape, Task 5 typecheck script name) are guarded with how to resolve them, not placeholders.

**Type consistency:** `isHeadless()` (Task 1) is the exact name read in Task 2. `buildHeadlessFlag` (Task 3) and `buildAppendSystemPrompt`/`AUTOMATION_PROMPT_NOTE` (Task 4) names match their tests. `run.metadata` typed `Record<string, unknown>` matches `RunSnapshot` (verified). `override` local already exists at `EngineRunner.ts:115`.
